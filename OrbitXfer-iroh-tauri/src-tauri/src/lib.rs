use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct AppState {
    sender: Mutex<Option<CommandChild>>,
    receiver: Mutex<Option<CommandChild>>,
}

fn replace_child(slot: &Mutex<Option<CommandChild>>, new: Option<CommandChild>) {
    if let Ok(mut guard) = slot.lock() {
        if let Some(prev) = guard.take() {
            let _ = prev.kill();
        }
        *guard = new;
    }
}

fn clear_child(app: &AppHandle, slot_pick: fn(&AppState) -> &Mutex<Option<CommandChild>>) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = slot_pick(&state).lock() {
            let _ = guard.take();
        }
    }
}

fn spawn_sidecar(
    app: &AppHandle,
    args: &[&str],
    event_prefix: &'static str,
    slot_pick: fn(&AppState) -> &Mutex<Option<CommandChild>>,
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
        replace_child(slot_pick(&state), Some(child));
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line).to_string();
                    let _ = app_clone.emit(&format!("{event_prefix}:stdout"), line);
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line).to_string();
                    let _ = app_clone.emit(&format!("{event_prefix}:stderr"), line);
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_clone.emit(&format!("{event_prefix}:exit"), payload.code);
                    break;
                }
                CommandEvent::Error(err) => {
                    let _ = app_clone.emit(&format!("{event_prefix}:error"), err);
                    break;
                }
                _ => {}
            }
        }
        clear_child(&app_clone, slot_pick);
    });

    Ok(())
}

#[tauri::command]
async fn start_send(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
) -> Result<(), String> {
    replace_child(&state.sender, None);
    spawn_sidecar(&app, &["send", &file_path], "send", |s| &s.sender)
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

#[tauri::command]
async fn start_receive(
    app: AppHandle,
    state: State<'_, AppState>,
    ticket: String,
    output_path: String,
) -> Result<(), String> {
    replace_child(&state.receiver, None);
    spawn_sidecar(
        &app,
        &["receive", &ticket, &output_path],
        "recv",
        |s| &s.receiver,
    )
}

#[tauri::command]
async fn stop_receive(state: State<'_, AppState>) -> Result<(), String> {
    let child = state
        .receiver
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
        .invoke_handler(tauri::generate_handler![
            start_send,
            stop_send,
            start_receive,
            stop_receive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
