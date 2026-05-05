use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct AppState {
    sender: Mutex<Option<CommandChild>>,
}

#[tauri::command]
async fn start_send(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Result<(), String> {
    if let Ok(mut guard) = state.sender.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    let sidecar = app
        .shell()
        .sidecar("orbitxfer-iroh-cli")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(["send", &file_path]);

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;

    if let Ok(mut guard) = state.sender.lock() {
        *guard = Some(child);
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).to_string();
                    let _ = app_clone.emit("send:stdout", line);
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).to_string();
                    let _ = app_clone.emit("send:stderr", line);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_clone.emit("send:exit", payload.code);
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app_clone.emit("send:error", err);
                    break;
                }
                _ => {}
            }
        }
        if let Some(state) = app_clone.try_state::<AppState>() {
            if let Ok(mut guard) = state.sender.lock() {
                let _ = guard.take();
            }
        }
    });

    Ok(())
}

#[tauri::command]
async fn stop_send(state: State<'_, AppState>) -> Result<(), String> {
    let child = state
        .sender
        .lock()
        .map_err(|e| format!("state poisoned: {e}"))?
        .take();
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
        .invoke_handler(tauri::generate_handler![start_send, stop_send])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
