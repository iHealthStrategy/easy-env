// Top-of-window banner that announces an available self-update and lets
// the user kick off download+install with one click. Runs only inside the
// Tauri shell — in `vite dev` (browser) we silently render nothing so the
// dev surface stays unchanged.
//
// Repo is public, so manifest + release assets are anonymously fetchable;
// no GitHub token plumbing. Updates are verified by the minisign keypair
// configured in plugins.updater.pubkey — Apple Developer ID is NOT
// required for this flow. See app/scripts/make-latest-json.sh.
import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

type Phase =
  | { kind: 'idle' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; downloaded: number; total: number | null }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

// Re-check periodically while the app is open so a user who leaves it
// running for days picks up newer releases without a restart. 6 hours
// is gentle on the manifest server (GitHub Releases handles much more,
// but no reason to spam).
const RECHECK_MS = 6 * 60 * 60 * 1000;

const IS_TAURI =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

export function UpdateBanner() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const probe = async () => {
      try {
        const update = await check();
        if (!alive) return;
        if (update?.available) {
          setPhase({ kind: 'available', update });
        }
      } catch (e) {
        // Endpoint unreachable, manifest missing, signature mismatch —
        // all surface here. Keep silent (don't nag the user) and try
        // again on the next interval; if the user wants to know we'd
        // need an explicit "check now" button somewhere else.
        // eslint-disable-next-line no-console
        console.warn('[updater] check failed:', e);
      } finally {
        if (alive) timer = setTimeout(probe, RECHECK_MS);
      }
    };
    probe();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!IS_TAURI || dismissed) return null;
  if (phase.kind === 'idle' || phase.kind === 'error') return null;

  const install = async () => {
    if (phase.kind !== 'available') return;
    const update = phase.update;
    setPhase({ kind: 'downloading', downloaded: 0, total: null });
    try {
      let total: number | null = null;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            setPhase({ kind: 'downloading', downloaded: 0, total });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setPhase({ kind: 'downloading', downloaded, total });
            break;
          case 'Finished':
            setPhase({ kind: 'ready' });
            break;
        }
      });
    } catch (e) {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    // downloadAndInstall already swapped the binary on disk; relaunch
    // boots the new version in-place.
    await relaunch();
  };

  return (
    <div className="docker-banner warn">
      <span className="docker-banner-icon">⬆️</span>
      <div className="docker-banner-body">
        {phase.kind === 'available' && (
          <>
            <div className="docker-banner-title">
              发现新版本 <code>{phase.update.version}</code>
              {phase.update.currentVersion && (
                <span className="meta" style={{ marginLeft: 8 }}>
                  (当前 {phase.update.currentVersion})
                </span>
              )}
            </div>
            <div className="docker-banner-desc">
              {phase.update.body
                ? <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{phase.update.body}</pre>
                : '下载并安装后会自动重启应用。'}
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <button onClick={install}>下载并安装</button>
                <button onClick={() => setDismissed(true)}>稍后</button>
              </div>
            </div>
          </>
        )}
        {phase.kind === 'downloading' && (
          <>
            <div className="docker-banner-title">正在下载更新…</div>
            <div className="docker-banner-desc">
              {phase.total
                ? `${formatBytes(phase.downloaded)} / ${formatBytes(phase.total)}`
                : formatBytes(phase.downloaded)}
            </div>
          </>
        )}
        {phase.kind === 'ready' && (
          <>
            <div className="docker-banner-title">更新已安装,正在重启…</div>
            <div className="docker-banner-desc">若没有自动重启,请手动关闭并重新打开 easy-env。</div>
          </>
        )}
      </div>
      {phase.kind === 'available' && (
        <button
          className="docker-banner-close"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
          title="本次会话不再提示"
        >
          ×
        </button>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
