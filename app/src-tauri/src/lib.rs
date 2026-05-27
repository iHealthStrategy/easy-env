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
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{WebviewUrl, WebviewWindowBuilder};

// Persisted UI preferences live in this store file (tauri-plugin-store).
// Rust reads `closeBehavior` in the window-close handler; the frontend
// Settings page + close dialog read/write it via the commands below.
const SETTINGS_FILE: &str = "settings.json";
const CLOSE_KEY: &str = "closeBehavior";

/// One of "ask" | "minimize" | "quit". Defaults to "ask" when unset.
fn read_close_behavior(app: &tauri::AppHandle) -> String {
    use tauri_plugin_store::StoreExt;
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|s| s.get(CLOSE_KEY))
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "ask".to_string())
}

fn write_close_behavior(app: &tauri::AppHandle, behavior: &str) -> Result<(), String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store(SETTINGS_FILE).map_err(|e| e.to_string())?;
    store.set(CLOSE_KEY, serde_json::json!(behavior));
    store.save().map_err(|e| e.to_string())
}

/// Bring the main window back to the foreground (from tray / hidden state).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Stop the embedded daemon (so its Docker containers don't outlive the app).
fn stop_daemon(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut guard) = state.daemon.lock() {
            let _ = guard.stop();
        }
    }
}

/// Carry out a close decision. "minimize" hides to the tray and leaves the
/// daemon running; anything else quits the app after stopping the daemon.
fn perform_close_action(app: &tauri::AppHandle, action: &str) {
    if action == "minimize" {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    } else {
        stop_daemon(app);
        app.exit(0);
    }
}

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
    .inner_size(400.0, 300.0)
    .min_inner_size(360.0, 260.0)
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

/// The version string of the `node` on PATH (e.g. "v20.11.1"), or None when
/// node isn't found / doesn't run. Surfaced in Settings so the user can see
/// at a glance whether they meet the Node 18+ requirement on this machine.
#[tauri::command]
fn node_version() -> Option<String> {
    let node = which::which("node").ok()?;
    let out = std::process::Command::new(node).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

#[tauri::command]
fn get_close_behavior(app: tauri::AppHandle) -> String {
    read_close_behavior(&app)
}

#[tauri::command]
fn set_close_behavior(app: tauri::AppHandle, behavior: String) -> Result<(), String> {
    write_close_behavior(&app, &behavior)
}

/// Invoked by the close dialog: optionally persist the choice, then act on it.
#[tauri::command]
fn resolve_close(app: tauri::AppHandle, action: String, remember: bool) -> Result<(), String> {
    if remember {
        write_close_behavior(&app, &action)?;
    }
    perform_close_action(&app, &action);
    Ok(())
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

            // Menu-bar tray. Lets the app keep running in the background when
            // the user "collapses" it on close (closeBehavior = "minimize").
            // Clicking the icon — or the Open item — restores the window;
            // Quit stops the daemon and exits.
            let tray_open = MenuItem::with_id(handle, "tray-open", "打开 easy-env", true, None::<&str>)?;
            let tray_quit = MenuItem::with_id(handle, "tray-quit", "退出 easy-env", true, None::<&str>)?;
            let tray_menu = MenuBuilder::new(handle).items(&[&tray_open, &tray_quit]).build()?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("easy-env")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray-open" => show_main(app),
                    "tray-quit" => {
                        stop_daemon(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            Ok(())
        })
        // Decide what the main window's close button does based on the saved
        // preference: "quit" tears down the daemon and exits (keeps Docker
        // containers from being orphaned); "minimize" hides to the tray and
        // leaves the daemon running; "ask" (default) holds the close and lets
        // the UI prompt the user.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let app = window.app_handle();
                    match read_close_behavior(app).as_str() {
                        "minimize" => {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                        "quit" => {
                            stop_daemon(app);
                            app.exit(0);
                        }
                        _ => {
                            // "ask": don't close yet — surface the dialog.
                            api.prevent_close();
                            let _ = app.emit("close-requested", ());
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
            node_version,
            get_close_behavior,
            set_close_behavior,
            resolve_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Single teardown point for EVERY exit path — window close,
            // tray Quit, app-menu Quit, and Cmd+Q all funnel through here —
            // so the daemon (and its Docker containers) never orphans.
            // Idempotent with the explicit stop_daemon calls on the quit
            // paths, which is fine.
            tauri::RunEvent::ExitRequested { .. } => stop_daemon(app),
            // Dock-icon click while collapsed to the tray (window hidden):
            // bring the main window back.
            tauri::RunEvent::Reopen { .. } => show_main(app),
            _ => {}
        });
}
