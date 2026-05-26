// Prevent additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Repair PATH for GUI launches before anything spawns a subprocess.
    // Without this, `which docker` / `which node` fail when the app is
    // opened from Finder/Dock because launchd hands us a minimal PATH.
    let _ = fix_path_env::fix();
    easy_env_app_lib::run()
}
