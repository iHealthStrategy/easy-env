// easy-env desktop app entry. Wires plugins, exposes Tauri commands that
// manage the embedded daemon, install the Claude Code skill, and write
// the MCP server config — everything the old Web UI couldn't do.

mod daemon;
mod docker;
mod paths;
mod skill;
mod mcp_config;

use std::sync::Mutex;
use tauri::Manager;
#[allow(unused_imports)]
use tauri::Emitter;
use tauri::menu::{AboutMetadata, MenuBuilder, SubmenuBuilder};
use tauri::{WebviewUrl, WebviewWindowBuilder};

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

// Open (or focus) the dedicated update window. Called by:
//  - the brand-area "new" badge in the React sidebar
//  - the native "更新 → 检查更新…" menu item
// Kept in Rust so both entry points hit the same window-creation code
// and we never end up with two stacked update windows.
fn ensure_update_window(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    if let Some(w) = app.get_webview_window("update") {
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        "update",
        // HashRouter on the frontend dispatches to <Updater /> for this path
        // — same bundle, no second entry point.
        WebviewUrl::App("index.html#/update".into()),
    )
    .title("软件更新 — easy-env")
    .inner_size(520.0, 420.0)
    .min_inner_size(440.0, 360.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .center()
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .hidden_title(true)
    .build()?;
    Ok(())
}

#[tauri::command]
fn open_update_window(app: tauri::AppHandle) -> Result<(), String> {
    ensure_update_window(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn docker_status() -> Result<docker::DockerStatus, String> {
    // Run the blocking probe on a worker thread so the IPC reply channel
    // stays responsive — docker info can take a second or two on cold
    // engines.
    tokio::task::spawn_blocking(docker::status)
        .await
        .map_err(|e| e.to_string())
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
        // Self-update over HTTP. Frontend calls check()/downloadAndInstall()
        // via @tauri-apps/plugin-updater; the bundled minisign pubkey
        // (configured in tauri.conf.json plugins.updater.pubkey) verifies
        // every downloaded artifact before it touches disk.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Required so the frontend can call relaunch() after an install
        // — without it `process:allow-restart` capability has no
        // backing command.
        .plugin(tauri_plugin_process::init())
        .manage(AppState {
            daemon: Mutex::new(daemon::DaemonHandle::new()),
        })
        // Build the native menu bar (macOS app menu + standard Edit menu +
        // a small Help submenu hosting "检查更新…"). Set in `setup` rather
        // than via `.menu()` on the builder so we can use the AppHandle
        // for predefined items that need it (about, services, etc.).
        .setup(|app| {
            // Tell paths.rs where the bundled mcp-server lives. In a
            // production .app this is Contents/Resources/. In `tauri dev`
            // resource_dir() points at app/src-tauri/, which also happens
            // to be where prepare-mcp-server.sh stages the tree — so dev
            // builds get the bundled path too when they prep first;
            // otherwise paths.rs falls back to the monorepo walk.
            if let Ok(dir) = app.path().resource_dir() {
                paths::set_resource_dir(dir);
            }
            let handle = app.handle();
            let app_menu = SubmenuBuilder::new(handle, "easy-env")
                .about(Some(AboutMetadata {
                    name: Some("easy-env".into()),
                    version: Some(env!("CARGO_PKG_VERSION").into()),
                    ..Default::default()
                }))
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view_menu = SubmenuBuilder::new(handle, "View")
                .fullscreen()
                .build()?;
            let window_menu = SubmenuBuilder::new(handle, "Window")
                .minimize()
                .build()?;
            // Custom submenu — IDs are referenced in on_menu_event below.
            // Keep them short and stable; the strings are not localized.
            let help_menu = SubmenuBuilder::new(handle, "帮助")
                .text("check-update", "检查更新…")
                .build()?;
            let menu = MenuBuilder::new(handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "check-update" {
                    let _ = ensure_update_window(app);
                }
            });
            Ok(())
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
            docker_status,
            open_update_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
