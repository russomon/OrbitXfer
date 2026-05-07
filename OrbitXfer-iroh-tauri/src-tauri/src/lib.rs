use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

fn run_sidecar(
    app: &AppHandle,
    label: String,
    args: &[&str],
    event_prefix: &'static str,
    slot: Slot,
) -> Result<(), String> {
    let sidecar = app
        .shell()
        .sidecar("orbitxfer-iroh-cli")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
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
        .on_window_event(|window, event| {
            // When a window is destroyed, kill any sidecars it owns and drop
            // its state. Without this, closing window B mid-transfer would
            // orphan the sidecar.
            if matches!(event, WindowEvent::Destroyed) {
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
