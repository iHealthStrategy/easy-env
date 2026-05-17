// Resolves the paths the app depends on at runtime:
//   - the easy-env monorepo root (so we can locate the bundled mcp-server)
//   - the daemon entry script (Node, ESM)
//   - the bundled skill directory
//   - the user's ~/.claude directory + skills/MCP config
//
// The app is designed to live INSIDE the monorepo at `app/`. In dev that's
// always true. For a packaged release, the resources are expected to be
// bundled alongside the binary — we look there first, then fall back to the
// repo layout for `tauri dev`.

use anyhow::{anyhow, Context, Result};
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
}

pub fn info() -> Result<PathsInfo> {
    let repo_root = repo_root()?;
    let mcp_server_dir = repo_root.join("packages").join("mcp-server");
    let daemon_entry = mcp_server_dir.join("dist").join("src").join("daemon").join("start.js");
    let server_entry = mcp_server_dir.join("dist").join("src").join("server.js");
    let skill_source_dir = mcp_server_dir.join("skills");
    let claude_home = home()?.join(".claude");
    let claude_skills_dir = claude_home.join("skills");
    let claude_config_path = home()?.join(".claude.json");

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
    })
}

pub fn home() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| anyhow!("could not resolve user home directory"))
}

/// Returns the monorepo root by walking upwards from CARGO_MANIFEST_DIR
/// (compile-time) or the current exe location (runtime). The signal we look
/// for is `packages/mcp-server/package.json`.
pub fn repo_root() -> Result<PathBuf> {
    // 1. Compile-time hint — works in `tauri dev` and `cargo run`.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = climb_for_marker(&manifest_dir) {
        return Ok(root);
    }

    // 2. Runtime hint — current_exe(). Walk up looking for the marker.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = climb_for_marker(&exe) {
            return Ok(root);
        }
    }

    // 3. CWD fallback.
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
