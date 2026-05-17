// easy-env desktop app entry. Wires plugins, exposes Tauri commands that
// manage the embedded daemon, install the Claude Code skill, and write
// the MCP server config — everything the old Web UI couldn't do.

mod daemon;
mod paths;
mod skill;
mod mcp_config;

use std::sync::Mutex;
use tauri::Manager;
#[allow(unused_imports)]
use tauri::Emitter;

pub struct AppState {
    pub daemon: Mutex<daemon::DaemonHandle>,
}

#[tauri::command]
async fn daemon_status(state: tauri::State<'_, AppState>) -> Result<daemon::DaemonStatus, String> {
    // Scope the MutexGuard tightly so it's released before .await — otherwise
    // the generated future isn't Send and Tauri's invoke_handler rejects it.
    let meta = {
        let guard = state.daemon.lock().map_err(|e| e.to_string())?;
        guard.clone_meta()
    };
    Ok(daemon::status(&meta).await)
}

#[tauri::command]
async fn daemon_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<daemon::DaemonStatus, String> {
    let meta = {
        let mut guard = state.daemon.lock().map_err(|e| e.to_string())?;
        guard.start(&app).map_err(|e| e.to_string())?;
        guard.clone_meta()
    };
    Ok(daemon::status(&meta).await)
}

#[tauri::command]
async fn daemon_stop(state: tauri::State<'_, AppState>) -> Result<daemon::DaemonStatus, String> {
    let meta = {
        let mut guard = state.daemon.lock().map_err(|e| e.to_string())?;
        guard.stop().map_err(|e| e.to_string())?;
        guard.clone_meta()
    };
    Ok(daemon::status(&meta).await)
}

#[tauri::command]
fn skill_status() -> Result<skill::SkillStatus, String> {
    skill::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn skill_install() -> Result<skill::SkillStatus, String> {
    skill::install().map_err(|e| e.to_string())?;
    skill::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn skill_uninstall() -> Result<skill::SkillStatus, String> {
    skill::uninstall().map_err(|e| e.to_string())?;
    skill::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_status() -> Result<mcp_config::McpStatus, String> {
    mcp_config::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_register() -> Result<mcp_config::McpStatus, String> {
    mcp_config::register().map_err(|e| e.to_string())?;
    mcp_config::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_unregister() -> Result<mcp_config::McpStatus, String> {
    mcp_config::unregister().map_err(|e| e.to_string())?;
    mcp_config::status().map_err(|e| e.to_string())
}

#[tauri::command]
fn paths_info() -> Result<paths::PathsInfo, String> {
    paths::info().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DaemonFetchResponse {
    status: u16,
    ok: bool,
    body: serde_json::Value,
}

#[tauri::command]
async fn daemon_fetch(
    state: tauri::State<'_, AppState>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<DaemonFetchResponse, String> {
    let port = {
        let guard = state.daemon.lock().map_err(|e| e.to_string())?;
        guard.clone_meta().port
    };
    let url = format!("http://127.0.0.1:{}{}", port, path);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "PATCH" => client.patch(&url),
        other => return Err(format!("unsupported method: {}", other)),
    };
    let req = if let Some(b) = body { req.json(&b) } else { req };

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let ok = resp.status().is_success();
    let txt = resp.text().await.unwrap_or_default();
    let body = serde_json::from_str::<serde_json::Value>(&txt)
        .unwrap_or(serde_json::Value::String(txt));
    Ok(DaemonFetchResponse { status, ok, body })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            daemon: Mutex::new(daemon::DaemonHandle::new()),
        })
        // Tear down the daemon when the main window is closed. Keeps Docker
        // containers from being orphaned past app shutdown — the daemon itself
        // sweeps them via SIGTERM.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        if let Ok(mut guard) = state.daemon.lock() {
                            let _ = guard.stop();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            daemon_start,
            daemon_stop,
            daemon_fetch,
            skill_status,
            skill_install,
            skill_uninstall,
            mcp_status,
            mcp_register,
            mcp_unregister,
            paths_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
