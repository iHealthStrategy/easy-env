// Resolves a per-user GitHub token at runtime so the updater can fetch
// private-repo release assets without the binary having to ship any
// shared secret. Two sources, tried in order:
//
//   1. `gh auth token` — the GitHub CLI. Coworkers with private repo
//      access almost always have this installed + authenticated. Their
//      token is scoped to *their* GitHub identity and respects repo
//      ACLs; revoking access on github.com instantly cuts off updates.
//
//   2. `$GITHUB_TOKEN` / `$GH_TOKEN` env vars — fallback for users who
//      prefer to manage credentials manually or run in headless
//      environments where gh isn't set up.
//
// Returns token=None when neither source yields a token; the UI uses
// the accompanying hint to render an actionable error instead of just
// silently failing the update check.
use serde::Serialize;
use std::env;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum TokenSource {
    GhCli,
    EnvVar,
    None,
}

#[derive(Serialize, Clone, Debug)]
pub struct TokenResult {
    pub token: Option<String>,
    pub source: TokenSource,
    /// Human-readable explanation when source = none; lets the UI
    /// produce an actionable error.
    pub hint: Option<String>,
}

pub fn resolve() -> TokenResult {
    if let Some(tok) = from_gh_cli() {
        return TokenResult {
            token: Some(tok),
            source: TokenSource::GhCli,
            hint: None,
        };
    }
    if let Some(tok) = from_env() {
        return TokenResult {
            token: Some(tok),
            source: TokenSource::EnvVar,
            hint: None,
        };
    }
    TokenResult {
        token: None,
        source: TokenSource::None,
        hint: Some(
            "未检测到 GitHub 凭证。请运行 `gh auth login`,或在启动 easy-env 前设置 GITHUB_TOKEN 环境变量。"
                .to_string(),
        ),
    }
}

fn from_gh_cli() -> Option<String> {
    let gh = which::which("gh").ok()?;
    let mut child = Command::new(gh)
        .arg("auth")
        .arg("token")
        // Pin to github.com so users with multiple hostnames (e.g.
        // GitHub Enterprise) don't accidentally get a token for the
        // wrong server.
        .arg("--hostname")
        .arg("github.com")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Poll with a hard cap — gh auth token is local and usually <100ms,
    // but a locked keychain can stall it. Don't let that freeze the
    // updater check at app launch.
    let start = Instant::now();
    let exited = loop {
        match child.try_wait() {
            Ok(Some(_status)) => break true,
            Ok(None) if start.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(40));
            }
            _ => break false,
        }
    };

    if !exited {
        let _ = child.kill();
        return None;
    }

    let mut buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut buf);
    }
    let token = String::from_utf8(buf).ok()?.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn from_env() -> Option<String> {
    env::var("GITHUB_TOKEN")
        .ok()
        .or_else(|| env::var("GH_TOKEN").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
