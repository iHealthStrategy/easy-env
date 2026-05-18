// Detects whether Docker is usable on this machine. Two failure modes the
// daemon cares about: (1) docker binary missing entirely — easy-env can't
// spawn any containers; (2) docker binary present but the engine isn't
// running — typical macOS case where the user installed Docker Desktop but
// hasn't opened it yet. We surface both with separate states so the UI can
// give targeted guidance ("install Docker" vs "start Docker Desktop").

use serde::Serialize;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum DockerState {
    /// docker binary on PATH and `docker info` succeeded.
    Running,
    /// docker binary found but `docker info` failed (engine not started).
    NotRunning,
    /// `which docker` returned nothing.
    NotInstalled,
}

#[derive(Serialize, Clone, Debug)]
pub struct DockerStatus {
    pub state: DockerState,
    pub binary: Option<String>,
    pub server_version: Option<String>,
    pub error: Option<String>,
}

pub fn status() -> DockerStatus {
    let binary = which::which("docker").ok().map(|p| p.to_string_lossy().into_owned());
    let Some(bin) = binary.clone() else {
        return DockerStatus {
            state: DockerState::NotInstalled,
            binary: None,
            server_version: None,
            error: None,
        };
    };

    // `docker info` is the canonical "engine reachable?" probe — it talks to
    // the daemon socket. Limit format output so we don't pull a giant blob.
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(["info", "--format", "{{.ServerVersion}}"]);
    // Don't inherit stdin/out — we only care about exit code + stdout.
    cmd.stdin(std::process::Stdio::null());

    let output = match run_with_timeout(cmd, Duration::from_secs(4)) {
        Ok(o) => o,
        Err(e) => {
            return DockerStatus {
                state: DockerState::NotRunning,
                binary: Some(bin),
                server_version: None,
                error: Some(e),
            };
        }
    };

    if output.status.success() {
        let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
        DockerStatus {
            state: DockerState::Running,
            binary: Some(bin),
            server_version: if v.is_empty() { None } else { Some(v) },
            error: None,
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        DockerStatus {
            state: DockerState::NotRunning,
            binary: Some(bin),
            server_version: None,
            error: if stderr.is_empty() { None } else { Some(stderr) },
        }
    }
}

// std::process::Command::output() blocks forever if the docker socket hangs,
// so wrap it in a thread with a wait timeout. Returns Err on timeout or
// spawn failure — both map to NotRunning in the caller.
fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle = std::thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send((status, stdout, stderr));
    });
    match rx.recv_timeout(timeout) {
        Ok((Ok(status), stdout, stderr)) => {
            use std::io::Read;
            let mut so = Vec::new();
            let mut se = Vec::new();
            if let Some(mut s) = stdout { let _ = s.read_to_end(&mut so); }
            if let Some(mut s) = stderr { let _ = s.read_to_end(&mut se); }
            let _ = handle.join();
            Ok(std::process::Output { status, stdout: so, stderr: se })
        }
        Ok((Err(e), _, _)) => Err(e.to_string()),
        Err(_) => Err(format!("docker info timed out after {}s", timeout.as_secs())),
    }
}
