// Sidebar footer: shows whether the embedded daemon is reachable, with a
// one-click start/stop. Polls every 2s so the user sees the daemon coming up
// after they flip the Settings toggle without having to refresh.
import { useEffect, useState } from 'react';
import { tauri, type DaemonStatus } from '../api/tauri';

export function DaemonStatusBar() {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!tauri.isTauri) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await tauri.daemon.status();
        if (alive) setStatus(s);
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!tauri.isTauri) return null;

  const onToggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (status?.healthy) {
        setStatus(await tauri.daemon.stop());
      } else {
        setStatus(await tauri.daemon.start());
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const healthy = !!status?.healthy;
  return (
    <div className="daemon-bar">
      <div className="daemon-bar-head">
        <span className={`dot ${healthy ? 'ok' : 'off'}`} />
        <span className="daemon-bar-title">守护进程</span>
        <button
          onClick={onToggle}
          disabled={busy}
          className={`daemon-bar-action ${healthy ? 'danger' : 'primary'}`}
        >
          {busy ? '…' : healthy ? '停止' : '启动'}
        </button>
      </div>

      <div className="daemon-bar-tags">
        <span className={`daemon-bar-state ${healthy ? 'on' : 'off'}`}>
          {healthy ? '运行中' : '已停止'}
        </span>
        {status?.external && <span className="daemon-bar-tag">外部启动</span>}
      </div>

      {status && (
        <div className="daemon-bar-meta">
          <code className="daemon-bar-url" title={status.url}>{status.url}</code>
          {status.pid && (
            <div className="daemon-bar-meta-line">
              pid <code>{status.pid}</code>
            </div>
          )}
        </div>
      )}

      {err && <div className="daemon-bar-err">{err}</div>}
    </div>
  );
}
