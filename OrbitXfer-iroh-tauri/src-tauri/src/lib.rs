use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MENU_ID_QUIT: &str = "ox-quit";
const MENU_ID_RESET_IDENTITY: &str = "ox-reset-identity";
const MENU_ID_NEW_WINDOW: &str = "ox-new-window";
const MENU_ID_RESUME_LAST_SEND: &str = "ox-resume-last-send";
const MENU_ID_VIEW_ZOOM_IN: &str = "ox-view-zoom-in";
const MENU_ID_VIEW_ZOOM_OUT: &str = "ox-view-zoom-out";
const MENU_ID_VIEW_ACTUAL_SIZE: &str = "ox-view-actual-size";
const MENU_ID_WINDOW_PREFIX: &str = "ox-window-";

/// Each transfer window has its own isolated send/receive process slot.
/// Without this, a second window starting a send would clobber the first.
#[derive(Default)]
struct WindowState {
    sender: Option<CommandChild>,
    receiver: Option<CommandChild>,
}

#[derive(Default)]
struct AppState {
    windows: Mutex<HashMap<String, WindowState>>,
    /// Reference count of currently-active transfers across every window.
    /// Goes 0 → 1 when the first transfer begins (we acquire the wake
    /// lock then) and N → 0 when the last one ends (we drop the lock).
    active_transfer_count: Mutex<u32>,
    /// Cross-platform sleep inhibitor handle. Held while
    /// `active_transfer_count > 0`. macOS uses IOKit's
    /// `kIOPMAssertionTypeNoIdleSleep` (system stays awake, display
    /// can still sleep — like `caffeinate -i`). Windows uses
    /// `SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)`.
    /// Linux uses systemd-logind's `Inhibit("sleep:idle", …)`. Dropping
    /// the handle releases the lock in every case.
    keep_awake: Mutex<Option<keepawake::KeepAwake>>,
}

#[derive(Clone, Copy)]
enum Slot {
    Send,
    Recv,
}

impl Slot {
    fn pick<'a>(self, ws: &'a mut WindowState) -> &'a mut Option<CommandChild> {
        match self {
            Slot::Send => &mut ws.sender,
            Slot::Recv => &mut ws.receiver,
        }
    }
}

fn replace_in_slot(
    state: &AppState,
    label: &str,
    slot: Slot,
    new: Option<CommandChild>,
) {
    if let Ok(mut map) = state.windows.lock() {
        let ws = map.entry(label.to_string()).or_default();
        if let Some(prev) = slot.pick(ws).take() {
            let _ = prev.kill();
        }
        *slot.pick(ws) = new;
    }
}

fn clear_slot(app: &AppHandle, label: &str, slot: Slot) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut map) = state.windows.lock() {
            if let Some(ws) = map.get_mut(label) {
                let _ = slot.pick(ws).take();
            }
        }
    }
}

fn sanitize_label(label: &str) -> String {
    label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Show the "transfers in progress" confirm dialog if any window has an
/// active sender or receiver, then exit. With no active transfer, exit
/// immediately. Used by the custom Quit menu item — Tauri 2's default macOS
/// Cmd-Q handler bypasses RunEvent::ExitRequested and skips straight to
/// Exit, so we have to own the menu item to get a cancellable quit.
fn handle_app_quit(app: &AppHandle) {
    let any_active = app
        .try_state::<AppState>()
        .and_then(|state| {
            state.windows.lock().ok().map(|map| {
                map.values()
                    .any(|ws| ws.sender.is_some() || ws.receiver.is_some())
            })
        })
        .unwrap_or(false);

    if !any_active {
        app.exit(0);
        return;
    }

    let app_clone = app.clone();
    app.dialog()
        .message(
            "Transfers are still in progress. Quit OrbitXfer anyway? \
             In-flight sends and receives will be stopped.",
        )
        .title("OrbitXfer")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Quit anyway".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            if let Some(state) = app_clone.try_state::<AppState>() {
                if let Ok(mut map) = state.windows.lock() {
                    for ws in map.values_mut() {
                        if let Some(c) = ws.sender.take() {
                            let _ = c.kill();
                        }
                        if let Some(c) = ws.receiver.take() {
                            let _ = c.kill();
                        }
                    }
                }
            }
            app_clone.exit(0);
        });
}

/// Return the currently-focused webview window, if any. Used by menu
/// handlers that need to dispatch an event ("zoom in", "resume last send",
/// etc.) to the window the user is actually looking at.
fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    for (_label, window) in app.webview_windows() {
        if window.is_focused().unwrap_or(false) {
            return Some(window);
        }
    }
    None
}

/// Create a new transfer window with a unique label. Called from the File
/// menu and from the `open_new_window` Tauri command (which the frontend
/// "+ New Window" button invokes). After creation, the menu is rebuilt so
/// the new window appears in the Window submenu's list.
fn create_transfer_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // Same labeling scheme the frontend used previously: `window-<ts>-<rand>`.
    // Each label is unique so the per-window AppState slot doesn't collide.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 2];
    let _ = getrandom_simple(&mut rand_bytes);
    let suffix = ((rand_bytes[0] as u16) << 8) | (rand_bytes[1] as u16);
    let label = format!("window-{nanos}-{suffix}");

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("OrbitXfer")
        .inner_size(900.0, 700.0)
        .build()?;

    // Rebuild menu so the new window appears in the Window submenu's list.
    if let Ok(menu) = build_menu(app) {
        let _ = app.set_menu(menu);
    }

    Ok(window)
}

/// Build the entire OrbitXfer menu, including the Window submenu's dynamic
/// list of currently-open windows. Called at startup and again whenever a
/// window opens or closes.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    // ---- OrbitXfer (app) menu ----
    let custom_quit = MenuItemBuilder::new("Quit OrbitXfer")
        .id(MENU_ID_QUIT)
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let reset_identity = MenuItemBuilder::new("Reset Identity…")
        .id(MENU_ID_RESET_IDENTITY)
        .build(app)?;

    let app_submenu = SubmenuBuilder::new(app, "OrbitXfer")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About OrbitXfer"),
            Some(AboutMetadata::default()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, Some("Hide OrbitXfer"))?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&reset_identity)
        .separator()
        .item(&custom_quit)
        .build()?;

    // ---- File menu ----
    let new_window = MenuItemBuilder::new("New Transfer Window")
        .id(MENU_ID_NEW_WINDOW)
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let resume_last_send = MenuItemBuilder::new("Resume Last Send Transfer")
        .id(MENU_ID_RESUME_LAST_SEND)
        .build(app)?;
    let file_submenu = SubmenuBuilder::new(app, "File")
        .item(&new_window)
        .item(&resume_last_send)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    // ---- Edit menu ----
    let edit_submenu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    // ---- View menu ----
    // Zoom items emit events to the focused window — the frontend listens
    // and adjusts the webview's zoom factor in response.
    let zoom_in = MenuItemBuilder::new("Zoom In")
        .id(MENU_ID_VIEW_ZOOM_IN)
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::new("Zoom Out")
        .id(MENU_ID_VIEW_ZOOM_OUT)
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let actual_size = MenuItemBuilder::new("Actual Size")
        .id(MENU_ID_VIEW_ACTUAL_SIZE)
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .separator()
        .item(&actual_size)
        .item(&zoom_in)
        .item(&zoom_out)
        .build()?;

    // ---- Window menu ----
    let mut window_builder = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator();

    // Dynamic list of currently-open windows. We sort by label so the
    // numbering is stable across menu rebuilds (HashMap iteration order
    // isn't). Per the user's preference (option (i)), every entry gets a
    // disambiguating counter even when titles are unique, so the user can
    // always tell which entry is which.
    let mut windows: Vec<(String, WebviewWindow)> = app
        .webview_windows()
        .into_iter()
        .collect();
    windows.sort_by(|a, b| a.0.cmp(&b.0));
    for (i, (label, window)) in windows.iter().enumerate() {
        let title = window.title().unwrap_or_else(|_| label.clone());
        let display = format!("{title} ({})", i + 1);
        let item = MenuItemBuilder::new(&display)
            .id(format!("{MENU_ID_WINDOW_PREFIX}{label}"))
            .build(app)?;
        window_builder = window_builder.item(&item);
    }

    let window_submenu = window_builder.build()?;

    // ---- Top-level menu bar ----
    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&file_submenu)
        .item(&edit_submenu)
        .item(&view_submenu)
        .item(&window_submenu)
        .build()
}

/// A minimal getrandom wrapper so we don't pull in a heavy dep just to
/// suffix window labels. Uses the host OS's CSPRNG. If it fails (vanishingly
/// rare), we accept a deterministic fallback — the nanos-since-epoch part
/// of the label is enough to avoid collisions in practice.
fn getrandom_simple(buf: &mut [u8]) -> std::io::Result<()> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom")?;
    f.read_exact(buf)?;
    Ok(())
}

/// Confirm the user really wants to rotate their iroh identities, then do
/// it. Triggered by the "Reset Identity…" menu item.
fn confirm_and_reset_identity(app: &AppHandle) {
    let app_clone = app.clone();
    app.dialog()
        .message(
            "Reset your OrbitXfer file identities?\n\n\
             This will:\n\
             • Stop every in-progress transfer in every window\n\
             • Erase every saved per-file identity\n\
             • Invalidate every share ticket you've ever sent\n\n\
             The next time you send any file, OrbitXfer will create a \
             fresh identity for it. Recipients holding old tickets will \
             no longer be able to reach your Mac, and they won't be able \
             to probe whether your Mac is on iroh.\n\n\
             This cannot be undone.",
        )
        .title("OrbitXfer")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Reset".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                reset_app_identity(&app_clone);
            }
        });
}

/// Per-file identity-key directory. The CLI's send flow keys identities
/// by the file's BLAKE3 content hash: `<dir>/<hash>.key`. Same file →
/// same identity → same share ticket. Different file → different
/// identity, no cross-linking. This is the v0.1.61+ default; v0.1.60's
/// single global `identity.key` is gone.
///
/// Lives OUTSIDE the per-window `store-*` directories so
/// `cleanup_old_stores()` doesn't accidentally wipe it on app startup —
/// only `reset_app_identity()` should ever delete it.
fn per_file_identity_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir lookup failed: {e}"))?;
    let dir = base.join("file-identities");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create per-file identity dir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// One-time cleanup of the v0.1.60 global identity file. Harmless if
/// it's already gone. Called from `setup` so a user upgrading from
/// v0.1.60 doesn't keep a stale identity sitting on disk.
fn cleanup_legacy_identity_key(app: &AppHandle) {
    let Ok(base) = app.path().app_local_data_dir() else {
        return;
    };
    let legacy = base.join("identity.key");
    let _ = std::fs::remove_file(&legacy);
}

/// Kill every active sidecar, wipe every per-file identity, wipe every
/// per-window FsStore, and remove the legacy v0.1.60 identity file if
/// any. Effectively rotates every iroh Node ID this Mac has ever used
/// via OrbitXfer: every ticket previously issued becomes inert, and old
/// recipients can no longer probe any of the (now-deleted) Node IDs.
fn reset_app_identity(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut map) = state.windows.lock() {
            for ws in map.values_mut() {
                if let Some(c) = ws.sender.take() {
                    let _ = c.kill();
                }
                if let Some(c) = ws.receiver.take() {
                    let _ = c.kill();
                }
            }
        }
    }

    if let Ok(dir) = per_file_identity_dir(app) {
        let _ = std::fs::remove_dir_all(&dir);
    }
    cleanup_legacy_identity_key(app);
    cleanup_old_stores(app);

    let _ = app.emit("identity:reset", ());
}

/// Run once at app startup: remove every leftover `store-*` directory in
/// the app's data folder. Those dirs are from previous sessions; if an
/// orphan CLI from a prior session still holds an exclusive lock on
/// `<dir>/blobs.db`, removing the dir unlinks the file (POSIX semantics),
/// the orphan keeps writing to its now-anonymous inode, and our new
/// sidecar can recreate the dir and start fresh without contention.
fn cleanup_old_stores(app: &AppHandle) {
    let Ok(base) = app.path().app_local_data_dir() else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("store-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Each window gets its own store directory under the Tauri app's data
/// folder. This isolates Tauri-spawned CLI sidecars from each other AND
/// from the standalone CLI (which defaults to ~/.orbitxfer-store). Without
/// this, an orphaned CLI from a previous session — Tauri or terminal —
/// holding the global store's exclusive lock would hang every future send
/// at ticket_hashing_start.
fn store_dir_for(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir lookup failed: {e}"))?;
    let dir = base.join(format!("store-{}", sanitize_label(label)));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create store dir {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Increment the active-transfer counter and, on the 0 → 1 transition,
/// acquire a cross-platform sleep inhibitor and broadcast a
/// `transfer:active` event so the UI can show the ☕ indicator.
fn acquire_keep_awake(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut count) = state.active_transfer_count.lock() else {
        return;
    };
    *count += 1;
    if *count == 1 {
        if let Ok(mut handle) = state.keep_awake.lock() {
            if handle.is_none() {
                match keepawake::Builder::default()
                    .display(false)
                    .idle(true)
                    .reason("OrbitXfer transfer in progress")
                    .app_name("OrbitXfer")
                    .app_reverse_domain("com.orbitolive.orbitxfer.tauri")
                    .create()
                {
                    Ok(h) => {
                        *handle = Some(h);
                        let _ = app.emit("transfer:active", ());
                    }
                    Err(e) => {
                        eprintln!(
                            "[orbitxfer] failed to acquire wake lock: {e}"
                        );
                    }
                }
            }
        }
    }
}

/// Decrement the active-transfer counter and, on the N → 0 transition,
/// drop the sleep inhibitor and broadcast `transfer:idle`. Safe to call
/// when the counter is already 0 (no-op).
fn release_keep_awake(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(mut count) = state.active_transfer_count.lock() else {
        return;
    };
    if *count > 0 {
        *count -= 1;
        if *count == 0 {
            if let Ok(mut handle) = state.keep_awake.lock() {
                *handle = None; // Drop releases the system-level lock.
            }
            let _ = app.emit("transfer:idle", ());
        }
    }
}

fn run_sidecar(
    app: &AppHandle,
    label: String,
    args: &[&str],
    event_prefix: &'static str,
    slot: Slot,
    ticket_mode: Option<&str>,
) -> Result<(), String> {
    let mut sidecar = app
        .shell()
        .sidecar("orbitxfer-iroh-cli")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?;

    if matches!(slot, Slot::Send) {
        // Sends need per-window FsStore isolation so concurrent sends
        // across multiple windows can't collide on a shared store's
        // exclusive flock. Receives don't have this problem (each
        // receive has its own destination dir), and forcing them into
        // the per-window store has two downsides:
        //   (1) cache lives invisibly in <app-data> instead of the
        //       visible `<destination>.orbitxfer-pieces/` folder that
        //       the v0.1.55 design intended;
        //   (2) auto-cleanup-on-success in the CLI only fires for the
        //       per-destination store, so receives in the per-window
        //       store leave a full copy of the file lingering in
        //       <app-data> until the next app startup wipes store-*.
        // So: ONLY sends get ORBITXFER_STORE_DIR. Receives use the
        // CLI's default per-destination behavior.
        let store_dir = store_dir_for(app, &label)?;
        sidecar = sidecar.env(
            "ORBITXFER_STORE_DIR",
            store_dir.to_string_lossy().as_ref(),
        );

        let dir = per_file_identity_dir(app)?;
        sidecar = sidecar.env(
            "ORBITXFER_PER_FILE_IDENTITY_DIR",
            dir.to_string_lossy().as_ref(),
        );

        // Connection mode chosen by the user in the Send panel. CLI accepts
        // "full" (relay + direct IPs), "direct_only" (no relay), or
        // "relay_only" (no direct IPs). Unset = "full" by default in the
        // CLI, so we only forward an explicit value.
        if let Some(mode) = ticket_mode {
            sidecar = sidecar.env("ORBITXFER_TICKET_MODE", mode);
        }
    }

    let sidecar = sidecar.args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    if let Some(state) = app.try_state::<AppState>() {
        replace_in_slot(&state, &label, slot, Some(child));
    }

    // Bump the active-transfer counter; if this is the first transfer in
    // flight across the app, acquire the cross-platform sleep inhibitor.
    // The matching release runs when this sidecar's event stream ends.
    acquire_keep_awake(app);

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app_clone
                        .emit_to(&label, &format!("{event_prefix}:stdout"), line);
                }
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    let _ = app_clone
                        .emit_to(&label, &format!("{event_prefix}:stderr"), line);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_clone
                        .emit_to(&label, &format!("{event_prefix}:exit"), payload.code);
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app_clone
                        .emit_to(&label, &format!("{event_prefix}:error"), err);
                    break;
                }
                _ => {}
            }
        }
        clear_slot(&app_clone, &label, slot);
        // Matching release for the acquire above. Runs on the natural
        // termination path AND on kill-from-outside (which closes rx).
        release_keep_awake(&app_clone);
    });

    Ok(())
}

#[tauri::command]
async fn start_send(
    app: AppHandle,
    window: WebviewWindow,
    file_path: String,
    connection_mode: Option<String>,
) -> Result<(), String> {
    let mode_ref = connection_mode.as_deref();
    run_sidecar(
        &app,
        window.label().to_string(),
        &["send", &file_path],
        "send",
        Slot::Send,
        mode_ref,
    )
}

#[tauri::command]
async fn stop_send(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let child = state
        .windows
        .lock()
        .map_err(|e| format!("state poisoned: {e}"))?
        .get_mut(window.label())
        .and_then(|ws| ws.sender.take());
    if let Some(child) = child {
        child.kill().map_err(|e| format!("kill failed: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn start_receive(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    output_path: String,
) -> Result<(), String> {
    run_sidecar(
        &app,
        window.label().to_string(),
        &["receive", &ticket, &output_path],
        "recv",
        Slot::Recv,
        None,
    )
}

#[tauri::command]
async fn stop_receive(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let child = state
        .windows
        .lock()
        .map_err(|e| format!("state poisoned: {e}"))?
        .get_mut(window.label())
        .and_then(|ws| ws.receiver.take());
    if let Some(child) = child {
        child.kill().map_err(|e| format!("kill failed: {e}"))?;
    }
    Ok(())
}

/// Open a new transfer window. The frontend's "+ New Window" button
/// invokes this so window creation happens in Rust (where we can also
/// rebuild the menu to include the new window in the Window submenu).
#[tauri::command]
async fn open_new_window(app: AppHandle) -> Result<(), String> {
    create_transfer_window(&app)
        .map(|_| ())
        .map_err(|e| format!("new window failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState::default())
        .setup(|app| {
            // Wipe any stale per-window store dirs from previous sessions
            // so orphan CLI sidecars (which can survive parent death and
            // hold an exclusive flock on blobs.db) don't hang our new
            // sends at ticket_hashing_start.
            cleanup_old_stores(&app.handle());

            // One-time cleanup of v0.1.60's single global identity.key.
            // From v0.1.61 onward we use per-file identities instead;
            // the old file would just sit there unused otherwise.
            cleanup_legacy_identity_key(&app.handle());

            // Build the full menu (OrbitXfer / File / Edit / View / Window)
            // including the dynamic list of currently-open windows in the
            // Window submenu. The default Tauri Cmd-Q on macOS bypasses
            // every cancellable event (RunEvent::ExitRequested AND
            // WindowEvent::CloseRequested both fail to fire), which is why
            // we own the OrbitXfer → Quit OrbitXfer item.
            let menu = build_menu(&app.handle())?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                let id = event.id().as_ref();
                match id {
                    MENU_ID_QUIT => handle_app_quit(app),
                    MENU_ID_RESET_IDENTITY => confirm_and_reset_identity(app),
                    MENU_ID_NEW_WINDOW => {
                        let _ = create_transfer_window(app);
                    }
                    MENU_ID_RESUME_LAST_SEND => {
                        if let Some(window) = focused_window(app) {
                            let _ = window.emit("menu:resume-last-send", ());
                        }
                    }
                    MENU_ID_VIEW_ZOOM_IN => {
                        if let Some(window) = focused_window(app) {
                            let _ = window.emit("view:zoom-in", ());
                        }
                    }
                    MENU_ID_VIEW_ZOOM_OUT => {
                        if let Some(window) = focused_window(app) {
                            let _ = window.emit("view:zoom-out", ());
                        }
                    }
                    MENU_ID_VIEW_ACTUAL_SIZE => {
                        if let Some(window) = focused_window(app) {
                            let _ = window.emit("view:actual-size", ());
                        }
                    }
                    _ if id.starts_with(MENU_ID_WINDOW_PREFIX) => {
                        // Window submenu list item: bring that window to
                        // front. The label is the menu-id suffix.
                        let label = &id[MENU_ID_WINDOW_PREFIX.len()..];
                        if let Some(window) = app.get_webview_window(label) {
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // If this window has an active sender or receiver, the
                    // user is about to lose an in-progress transfer. Prevent
                    // the close, ask them to confirm, and only then kill the
                    // sidecars and close.
                    let label = window.label().to_string();
                    let active_kinds: Vec<&str> = if let Some(state) =
                        window.app_handle().try_state::<AppState>()
                    {
                        if let Ok(map) = state.windows.lock() {
                            if let Some(ws) = map.get(&label) {
                                let mut kinds = Vec::new();
                                if ws.sender.is_some() {
                                    kinds.push("send");
                                }
                                if ws.receiver.is_some() {
                                    kinds.push("receive");
                                }
                                kinds
                            } else {
                                Vec::new()
                            }
                        } else {
                            Vec::new()
                        }
                    } else {
                        Vec::new()
                    };

                    if active_kinds.is_empty() {
                        // No active transfer — let the close proceed.
                        return;
                    }

                    api.prevent_close();

                    let body = match active_kinds.as_slice() {
                        ["send"] => {
                            "A send is in progress in this window. Closing \
                             will stop the transfer. Close anyway?"
                        }
                        ["receive"] => {
                            "A receive is in progress in this window. Closing \
                             will stop the download. Close anyway?"
                        }
                        _ => {
                            "Transfers are in progress in this window. \
                             Closing will stop them. Close anyway?"
                        }
                    };

                    let window_clone = window.clone();
                    let label_clone = label.clone();
                    window
                        .dialog()
                        .message(body)
                        .title("OrbitXfer")
                        .kind(MessageDialogKind::Warning)
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Close anyway".to_string(),
                            "Cancel".to_string(),
                        ))
                        .show(move |confirmed| {
                            if !confirmed {
                                return;
                            }
                            // Kill the sidecars first, then re-issue close.
                            // The next CloseRequested will see no active
                            // transfer and let the close proceed.
                            if let Some(state) =
                                window_clone.app_handle().try_state::<AppState>()
                            {
                                if let Ok(mut map) = state.windows.lock() {
                                    if let Some(ws) = map.get_mut(&label_clone) {
                                        if let Some(child) = ws.sender.take() {
                                            let _ = child.kill();
                                        }
                                        if let Some(child) = ws.receiver.take() {
                                            let _ = child.kill();
                                        }
                                    }
                                }
                            }
                            let _ = window_clone.close();
                        });
                }
                WindowEvent::Destroyed => {
                    // Final cleanup: drop the window's state map entry. Any
                    // surviving sidecar (e.g. user closed without active
                    // transfer) gets killed here too.
                    let label = window.label().to_string();
                    let app_handle = window.app_handle();
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        if let Ok(mut map) = state.windows.lock() {
                            if let Some(mut ws) = map.remove(&label) {
                                if let Some(child) = ws.sender.take() {
                                    let _ = child.kill();
                                }
                                if let Some(child) = ws.receiver.take() {
                                    let _ = child.kill();
                                }
                            }
                        }
                    }

                    // Rebuild the menu so the Window submenu's dynamic list
                    // reflects the closed window's absence. (Opens trigger
                    // their rebuild from create_transfer_window().)
                    if let Ok(menu) = build_menu(app_handle) {
                        let _ = app_handle.set_menu(menu);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_send,
            stop_send,
            start_receive,
            stop_receive,
            open_new_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
