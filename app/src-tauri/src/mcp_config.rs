// Register/unregister easy-env's MCP stdio server in the user's Claude Code
// config (~/.claude.json). The MCP server itself is the existing
// `dist/src/server.js` from packages/mcp-server; it auto-spawns the daemon
// on its first call, so the user just needs the JSON entry to point at it.
//
// We touch only the `mcpServers.easy-env` key — every other key in the user
// config is preserved verbatim. The Tauri app is the GUI for this operation;
// the user can still hand-edit the file if they prefer.

use crate::paths;
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;

pub const SERVER_KEY: &str = "easy-env";

#[derive(Debug, Serialize, Clone)]
pub struct McpStatus {
    pub config_path: String,
    pub registered: bool,
    pub server_entry: String,
    pub server_entry_exists: bool,
    pub current_command: Option<String>,
    pub current_args: Option<Vec<String>>,
}

pub fn status() -> Result<McpStatus> {
    let info = paths::info()?;
    let path = PathBuf::from(&info.claude_config_path);
    let (registered, current_command, current_args) = if path.exists() {
        let txt = fs::read_to_string(&path).unwrap_or_default();
        let v: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
        let entry = v
            .get("mcpServers")
            .and_then(|m| m.get(SERVER_KEY))
            .cloned();
        match entry {
            Some(Value::Object(obj)) => (
                true,
                obj.get("command").and_then(|c| c.as_str()).map(String::from),
                obj.get("args").and_then(|a| a.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                }),
            ),
            _ => (false, None, None),
        }
    } else {
        (false, None, None)
    };

    Ok(McpStatus {
        config_path: path.display().to_string(),
        registered,
        server_entry_exists: info.server_entry_exists,
        server_entry: info.server_entry,
        current_command,
        current_args,
    })
}

pub fn register() -> Result<()> {
    let info = paths::info()?;
    let path = PathBuf::from(&info.claude_config_path);
    if !info.server_entry_exists {
        anyhow::bail!(
            "MCP server entry not built: {} — run `npm run build --workspace easy-env-mcp` first",
            info.server_entry
        );
    }
    let node = info
        .node_binary
        .clone()
        .unwrap_or_else(|| "node".to_string());

    let mut root: Map<String, Value> = if path.exists() {
        let txt = fs::read_to_string(&path)
            .with_context(|| format!("read {}", path.display()))?;
        if txt.trim().is_empty() {
            Map::new()
        } else {
            serde_json::from_str(&txt)
                .with_context(|| format!("parse {}", path.display()))?
        }
    } else {
        Map::new()
    };

    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers_obj = servers
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("mcpServers is not an object in {}", path.display()))?;

    servers_obj.insert(
        SERVER_KEY.to_string(),
        json!({
            "command": node,
            "args": [info.server_entry],
        }),
    );

    let pretty = serde_json::to_string_pretty(&Value::Object(root))? + "\n";
    if let Some(parent) = path.parent() {
        paths::ensure_dir(parent)?;
    }
    fs::write(&path, pretty)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn unregister() -> Result<()> {
    let info = paths::info()?;
    let path = PathBuf::from(&info.claude_config_path);
    if !path.exists() {
        return Ok(());
    }
    let txt = fs::read_to_string(&path)?;
    if txt.trim().is_empty() {
        return Ok(());
    }
    let mut root: Map<String, Value> = serde_json::from_str(&txt)
        .with_context(|| format!("parse {}", path.display()))?;
    if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
        servers.remove(SERVER_KEY);
    }
    let pretty = serde_json::to_string_pretty(&Value::Object(root))? + "\n";
    fs::write(&path, pretty)?;
    Ok(())
}
