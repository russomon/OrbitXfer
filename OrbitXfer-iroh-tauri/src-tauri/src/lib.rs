use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::{
    AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MENU_ID_QUIT: &str = "ox-quit";
const MENU_ID_RESET_IDENTITY: &str = "ox-reset-identity";

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

/// Confirm the user really wants to rotate their iroh identity, then do
/// it. Triggered by the "Reset Identity…" menu item.
fn confirm_and_reset_identity(app: &AppHandle) {
    let app_clone = app.clone();
    app.dialog()
        .message(
            "Reset your OrbitXfer identity?\n\n\
             This will:\n\
             • Stop every in-progress transfer in every window\n\
             • Invalidate every share ticket you've ever sent\n\
             • Generate a fresh identity for new transfers\n\n\
             Recipients holding old tickets will no longer be able to \
             reach your Mac, and they won't be able to probe whether \
             your Mac is on iroh.\n\n\
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

/// App-wide persistent identity key location. Lives OUTSIDE the per-window
/// `store-*` directories so `cleanup_old_stores()` doesn't accidentally
/// wipe it on app startup. The CLI's `load_or_create_secret_key()` reads
/// this file via the `ORBITXFER_KEY_PATH` env var (we set it on every
/// sidecar spawn) and creates it on first use.
///
/// With this in place, the same file sent twice produces the same ticket —
/// share once, reuse for life. Security caveat: anyone with an old ticket
/// can probe whether this identity is online on the iroh network. Mitigated
/// by `cleanup_old_stores()` wiping the FsStore between sessions (old
/// recipients can connect but get "blob not found" for anything you're not
/// actively serving), and by the user-initiated `reset_app_identity()`
/// flow which deletes the key and invalidates every old ticket.
fn identity_key_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir lookup failed: {e}"))?;
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("create app data dir {}: {e}", base.display()))?;
    Ok(base.join("identity.key"))
}

/// Kill every active sidecar, delete the persistent identity key, and
/// wipe every per-window FsStore. Effectively rotates the iroh Node ID:
/// every ticket we've ever issued becomes inert, and old recipients can
/// no longer probe the (now-deleted) old Node ID.
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

    if let Ok(path) = identity_key_path(app) {
        let _ = std::fs::remove_file(&path);
    }

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

fn run_sidecar(
    app: &AppHandle,
    label: String,
    args: &[&str],
    event_prefix: &'static str,
    slot: Slot,
) -> Result<(), String> {
    let store_dir = store_dir_for(app, &label)?;
    let key_path = identity_key_path(app)?;
    let sidecar = app
        .shell()
        .sidecar("orbitxfer-iroh-cli")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .env("ORBITXFER_STORE_DIR", store_dir.to_string_lossy().as_ref())
        .env("ORBITXFER_KEY_PATH", key_path.to_string_lossy().as_ref())
        .args(args);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    if let Some(state) = app.try_state::<AppState>() {
        replace_in_slot(&state, &label, slot, Some(child));
    }

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
    });

    Ok(())
}

#[tauri::command]
async fn start_send(
    app: AppHandle,
    window: WebviewWindow,
    file_path: String,
) -> Result<(), String> {
    run_sidecar(&app, window.label().to_string(), &["send", &file_path], "send", Slot::Send)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Wipe any stale per-window store dirs from previous sessions
            // so orphan CLI sidecars (which can survive parent death and
            // hold an exclusive flock on blobs.db) don't hang our new
            // sends at ticket_hashing_start.
            cleanup_old_stores(&app.handle());

            // Build a minimal menu that overrides the default macOS Quit
            // item. Without this, Cmd-Q bypasses every cancellable event
            // (RunEvent::ExitRequested and WindowEvent::CloseRequested both
            // fail to fire) and the app exits silently.
            let custom_quit = MenuItemBuilder::new("Quit OrbitXfer")
                .id(MENU_ID_QUIT)
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;

            // No keyboard shortcut — destructive action, intentional speed
            // bump. The ellipsis follows the macOS convention indicating the
            // item opens a confirmation dialog before doing anything.
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

            // Edit submenu so cut/copy/paste/select-all keyboard shortcuts
            // keep working in textareas once we install our own menu.
            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_submenu)
                .item(&edit_submenu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    MENU_ID_QUIT => handle_app_quit(app),
                    MENU_ID_RESET_IDENTITY => confirm_and_reset_identity(app),
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
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
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
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_send,
            stop_send,
            start_receive,
            stop_receive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
