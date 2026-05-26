// Resolves the paths the app depends on at runtime:
//   - the bundled (or in-repo) mcp-server directory
//   - the daemon entry script (Node, ESM)
//   - the bundled skill directory
//   - the user's ~/.claude directory + skills/MCP config
//
// Production layout: the `.app` bundle carries mcp-server under
// Contents/Resources/mcp-server/ (staged by app/scripts/prepare-mcp-server.sh
// and declared in tauri.conf.json bundle.resources). We learn that path
// from Tauri's AppHandle::path().resource_dir() during setup() and stash
// it in a process-local OnceCell so the various paths::info() callers
// don't need to thread the handle around.
//
// Dev layout (tauri dev / cargo run): the binary lives inside the
// monorepo, so we walk upward from CARGO_MANIFEST_DIR / current_exe /
// cwd until we find packages/mcp-server/package.json. This path is the
// fallback when the resource dir lookup misses, so cargo-driven tests
// keep working with no extra config.

use anyhow::{anyhow, Context, Result};
use once_cell::sync::OnceCell;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
pub struct PathsInfo {
    pub repo_root: String,
    pub mcp_server_dir: String,
    pub daemon_entry: String,
    pub server_entry: String,
    pub skill_source_dir: String,
    pub claude_home: String,
    pub claude_skills_dir: String,
    pub claude_config_path: String,
    pub node_binary: Option<String>,
    pub daemon_entry_exists: bool,
    pub server_entry_exists: bool,
    /// True when mcp_server_dir was resolved from the bundled .app
    /// resources rather than the on-disk monorepo. Used by the UI to
    /// hide "repo root" framing for end users.
    pub bundled: bool,
}

/// Set by setup() in lib.rs with the AppHandle's resource_dir(). Once
/// set, paths::info() prefers <resource_dir>/mcp-server over the
/// monorepo walk. If the bundle didn't ship mcp-server (e.g. running
/// under `cargo run` without prep-script), the dev walk still works.
static RESOURCE_DIR: OnceCell<PathBuf> = OnceCell::new();

pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

pub fn info() -> Result<PathsInfo> {
    let (mcp_server_dir, bundled) = locate_mcp_server();
    let daemon_entry = mcp_server_dir.join("dist").join("src").join("daemon").join("start.js");
    let server_entry = mcp_server_dir.join("dist").join("src").join("server.js");
    let skill_source_dir = mcp_server_dir.join("skills");
    let claude_home = home()?.join(".claude");
    let claude_skills_dir = claude_home.join("skills");
    let claude_config_path = home()?.join(".claude.json");

    // The "repo_root" field is kept for compatibility with the Settings
    // page wiring. For bundled installs we report the resource dir so
    // the UI shows a real on-disk path; for dev we report the monorepo
    // root.
    let repo_root = if bundled {
        RESOURCE_DIR
            .get()
            .cloned()
            .unwrap_or_else(|| mcp_server_dir.parent().map(Path::to_path_buf).unwrap_or_default())
    } else {
        mcp_server_dir
            .parent() // …/packages
            .and_then(|p| p.parent()) // monorepo root
            .map(Path::to_path_buf)
            .unwrap_or_default()
    };

    Ok(PathsInfo {
        repo_root: repo_root.display().to_string(),
        mcp_server_dir: mcp_server_dir.display().to_string(),
        daemon_entry_exists: daemon_entry.exists(),
        daemon_entry: daemon_entry.display().to_string(),
        server_entry_exists: server_entry.exists(),
        server_entry: server_entry.display().to_string(),
        skill_source_dir: skill_source_dir.display().to_string(),
        claude_home: claude_home.display().to_string(),
        claude_skills_dir: claude_skills_dir.display().to_string(),
        claude_config_path: claude_config_path.display().to_string(),
        node_binary: which::which("node").ok().map(|p| p.display().to_string()),
        bundled,
    })
}

pub fn home() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not resolve user home directory"))
}

/// Returns (mcp_server_dir, bundled?). Prefers the bundled resource
/// directory; falls back to the monorepo walk for dev builds. Always
/// returns SOME path — if everything fails, we still return the bundled
/// candidate so the UI's "缺失" badge points at a sensible location.
fn locate_mcp_server() -> (PathBuf, bool) {
    if let Some(dir) = RESOURCE_DIR.get() {
        let candidate = dir.join("mcp-server");
        // Trust the bundled location even if package.json is briefly
        // missing — once it exists Tauri's resource dir is the source
        // of truth. The exists() check just prevents us from preferring
        // it over a working dev repo when nothing was bundled.
        if candidate.join("package.json").exists() {
            return (candidate, true);
        }
    }
    match repo_root() {
        Ok(root) => (root.join("packages").join("mcp-server"), false),
        Err(_) => {
            // No bundle, no repo — return the bundled candidate path
            // anyway so error messages quote a stable location.
            let placeholder = RESOURCE_DIR
                .get()
                .map(|d| d.join("mcp-server"))
                .unwrap_or_else(|| PathBuf::from("<mcp-server>"));
            (placeholder, true)
        }
    }
}

/// Dev-mode locator: walk upward from CARGO_MANIFEST_DIR / current_exe /
/// cwd until we find packages/mcp-server/package.json.
pub fn repo_root() -> Result<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = climb_for_marker(&manifest_dir) {
        return Ok(root);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = climb_for_marker(&exe) {
            return Ok(root);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = climb_for_marker(&cwd) {
            return Ok(root);
        }
    }
    Err(anyhow!(
        "could not locate easy-env repo root (looking for packages/mcp-server)"
    ))
}

fn climb_for_marker(start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start.to_path_buf());
    while let Some(p) = cur {
        let marker = p.join("packages").join("mcp-server").join("package.json");
        if marker.exists() {
            return Some(p);
        }
        cur = p.parent().map(|q| q.to_path_buf());
    }
    None
}

pub fn ensure_dir(p: &Path) -> Result<()> {
    std::fs::create_dir_all(p).with_context(|| format!("create_dir_all {}", p.display()))
}
