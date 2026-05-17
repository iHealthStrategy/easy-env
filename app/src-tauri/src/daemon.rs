// Manages the lifecycle of the embedded easy-env daemon (a Node.js process).
//
// The daemon can be in three states from our perspective:
//   1. Spawned by THIS Tauri session — we own `self.child`, regular SIGTERM
//      via that handle.
//   2. Running externally — started by a previous Tauri session that exited
//      uncleanly, by `npm run daemon`, or auto-spawned by the MCP stdio
//      server. We don't have a child handle but we DO have the pidfile at
//      `~/.easy-env/daemon.pid` to identify the PID.
//   3. Not running — pidfile missing or stale.
//
// `start()` adopts case 2 (no double-spawn — port 7193 would collide anyway).
// `stop()` works in both cases 1 and 2 by falling back to the pidfile.

use crate::paths;
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

#[derive(Debug, Serialize, Clone)]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub url: String,
    pub healthy: bool,
    pub version: Option<String>,
    pub uptime_ms: Option<u64>,
    pub last_error: Option<String>,
    /// True when the daemon is running but wasn't spawned by this Tauri
    /// process — useful for the UI to explain "stop will signal an external
    /// process via its pidfile".
    pub external: bool,
}

const DEFAULT_PORT: u16 = 7193;

pub struct DaemonHandle {
    /// Child handle if we spawned the daemon in this session.
    child: Option<Child>,
    port: u16,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct DaemonMeta {
    pub port: u16,
    /// PID of the daemon we spawned, if any.
    pub child_pid: Option<u32>,
    pub last_error: Option<String>,
}

/// Pidfile record format — must match what the Node daemon writes
/// (`packages/mcp-server/src/daemon/pidfile.ts`). Only `pid` is read today;
/// the other fields are kept so we don't fail JSON parse when the schema
/// adds metadata.
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct PidRecord {
    pid: u32,
    #[serde(rename = "startedAt")]
    started_at: Option<String>,
    port: Option<u16>,
}

impl DaemonHandle {
    pub fn new() -> Self {
        Self { child: None, port: DEFAULT_PORT, last_error: None }
    }

    pub fn clone_meta(&self) -> DaemonMeta {
        DaemonMeta {
            port: self.port,
            child_pid: self.child.as_ref().map(|c| c.id()),
            last_error: self.last_error.clone(),
        }
    }

    pub fn start(&mut self, _app: &tauri::AppHandle) -> Result<()> {
        // Re-check our own child first.
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(_)) => { self.child = None; }
                Ok(None) => return Ok(()), // already up
                Err(e) => self.last_error = Some(e.to_string()),
            }
        }

        // Adopt an externally-running daemon (matching pidfile PID is alive)
        // instead of trying to spawn a new one that would fail on the port.
        if let Some(rec) = read_pidfile() {
            if is_process_alive(rec.pid) {
                self.last_error = None;
                return Ok(());
            }
        }

        let info = paths::info().context("resolve paths")?;
        if !info.daemon_entry_exists {
            return Err(anyhow!(
                "daemon entry not found at {} — run `npm run build --workspace easy-env-mcp` first",
                info.daemon_entry
            ));
        }
        let node = info
            .node_binary
            .clone()
            .ok_or_else(|| anyhow!("`node` not found in PATH"))?;

        let mut cmd = Command::new(node);
        cmd.arg(&info.daemon_entry);
        cmd.env("EASY_ENV_DAEMON_PORT", self.port.to_string());
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());

        let child = cmd
            .spawn()
            .with_context(|| format!("spawn `node {}`", info.daemon_entry))?;
        self.child = Some(child);
        self.last_error = None;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<()> {
        // Path 1: we own the child handle — SIGTERM via the handle and wait.
        if let Some(mut child) = self.child.take() {
            send_term_unix(child.id() as i32);
            for _ in 0..50 {
                match child.try_wait() {
                    Ok(Some(_)) => return Ok(()),
                    Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                    Err(e) => {
                        self.last_error = Some(e.to_string());
                        break;
                    }
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }

        // Path 2: no child handle — look at the pidfile and SIGTERM that PID.
        // This covers daemons started by `npm run daemon`, a previous Tauri
        // session, or the MCP stdio server's auto-spawn.
        let Some(rec) = read_pidfile() else { return Ok(()); };
        if !is_process_alive(rec.pid) {
            // Stale pidfile — clean it up so the next start() doesn't see it.
            let _ = remove_pidfile();
            return Ok(());
        }

        send_term_unix(rec.pid as i32);

        // Wait up to ~6s for the daemon to exit cleanly (it has containers to
        // drain in its SIGTERM handler).
        for _ in 0..60 {
            if !is_process_alive(rec.pid) {
                let _ = remove_pidfile();
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        // Still alive — force kill.
        send_kill_unix(rec.pid as i32);
        for _ in 0..20 {
            if !is_process_alive(rec.pid) {
                let _ = remove_pidfile();
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        self.last_error = Some(format!(
            "daemon pid {} did not exit after SIGTERM+SIGKILL",
            rec.pid
        ));
        Err(anyhow!("daemon refused to stop"))
    }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
fn send_term_unix(pid: i32) {
    unsafe { let _ = kill(pid, 15); }
}

#[cfg(unix)]
fn send_kill_unix(pid: i32) {
    unsafe { let _ = kill(pid, 9); }
}

#[cfg(not(unix))]
fn send_term_unix(_pid: i32) {}

#[cfg(not(unix))]
fn send_kill_unix(_pid: i32) {}

/// Best-effort process liveness check by sending signal 0 (no-op signal).
#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    // signal 0: doesn't deliver, only validates pid + permissions.
    let rc = unsafe { kill(pid as i32, 0) };
    if rc == 0 {
        return true;
    }
    // errno EPERM (1) means process exists but we can't signal it. Treat as alive.
    let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    errno == 1
}

#[cfg(not(unix))]
fn is_process_alive(_pid: u32) -> bool {
    // TODO: implement via OpenProcess on Windows. For now assume alive if the
    // pidfile exists; stop will fall through to SIGKILL noop.
    true
}

fn pidfile_path() -> PathBuf {
    let home = std::env::var("EASY_ENV_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("STATE_DIFF_HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/"))
                .join(".easy-env")
        });
    home.join("daemon.pid")
}

fn read_pidfile() -> Option<PidRecord> {
    let path = pidfile_path();
    let raw = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<PidRecord>(&raw).ok()
}

fn remove_pidfile() -> std::io::Result<()> {
    std::fs::remove_file(pidfile_path())
}

pub async fn status(meta: &DaemonMeta) -> DaemonStatus {
    let url = format!("http://127.0.0.1:{}", meta.port);
    let health_url = format!("{}/api/health", url);

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return DaemonStatus {
                running: false,
                pid: meta.child_pid,
                port: meta.port,
                url,
                healthy: false,
                version: None,
                uptime_ms: None,
                last_error: meta.last_error.clone(),
                external: false,
            };
        }
    };

    let (healthy, version, uptime_ms) = match client.get(&health_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<serde_json::Value>().await {
                Ok(json) => (
                    true,
                    json.get("version").and_then(|v| v.as_str()).map(String::from),
                    json.get("uptimeMs").and_then(|v| v.as_u64()),
                ),
                Err(_) => (true, None, None),
            }
        }
        _ => (false, None, None),
    };

    // Determine the effective PID we'd act on:
    //   - prefer the one we spawned (child_pid)
    //   - else fall back to the pidfile so the UI shows SOMETHING when an
    //     external daemon is running
    let pidfile_pid = read_pidfile().map(|r| r.pid);
    let effective_pid = meta.child_pid.or(pidfile_pid);
    let external = meta.child_pid.is_none() && pidfile_pid.is_some() && healthy;

    DaemonStatus {
        running: effective_pid.is_some() || healthy,
        pid: effective_pid,
        port: meta.port,
        url,
        healthy,
        version,
        uptime_ms,
        last_error: meta.last_error.clone(),
        external,
    }
}
