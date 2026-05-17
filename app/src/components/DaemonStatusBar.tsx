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

  return (
    <div className="daemon-bar">
      <div className="daemon-bar-row">
        <span className={`dot ${status?.healthy ? 'ok' : 'off'}`} />
        <span className="daemon-bar-label">
          Daemon {status?.healthy ? 'running' : 'stopped'}
          {status?.external ? ' (external)' : ''}
        </span>
        <button onClick={onToggle} disabled={busy} className="mini">
          {busy ? '…' : status?.healthy ? 'Stop' : 'Start'}
        </button>
      </div>
      <div className="daemon-bar-url">
        {status ? status.url : '—'}
        {status?.pid ? ` · pid ${status.pid}` : ''}
        {status?.version ? ` · v${status.version}` : ''}
      </div>
      {err && <div className="daemon-bar-err">{err}</div>}
    </div>
  );
}
