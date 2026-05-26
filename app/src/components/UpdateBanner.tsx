// Top-of-window banner that announces an available self-update and lets
// the user kick off download+install with one click. Runs only inside the
// Tauri shell — in `vite dev` (browser) or when the updater plugin isn't
// reachable we silently render nothing so the dev surface stays unchanged.
//
// Authentication model: the release artifacts live in a PRIVATE GitHub
// repo. To avoid shipping a shared secret in the bundle, we resolve a
// per-user GitHub token at runtime (gh CLI or $GITHUB_TOKEN) and inject
// it as an Authorization header for every updater HTTP request. Users
// without gh installed / authenticated get a friendly "no credentials"
// banner instead of a silent failure.
//
// Updates themselves are verified by the minisign keypair configured
// in plugins.updater.pubkey — Apple Developer ID is NOT required for
// this flow. See app/scripts/make-latest-json.sh for the release flow.
import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { tauri } from '../api/tauri';

type Phase =
  | { kind: 'idle' }
  | { kind: 'no-credentials'; hint: string }
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
        // Per-user token — never embedded in the bundle. If the user
        // has no gh login + no env var, surface a banner and skip the
        // check entirely (no point trying to hit private endpoints).
        const auth = await tauri.github.token();
        if (!auth.token) {
          if (alive) setPhase({ kind: 'no-credentials', hint: auth.hint ?? '' });
          return;
        }
        const headers: Record<string, string> = {
          Authorization: `Bearer ${auth.token}`,
          // Both the raw.githubusercontent manifest fetch AND the
          // /releases/assets/<id> binary download tolerate this Accept
          // value. Raw URLs ignore it; the assets endpoint requires it
          // for binary delivery. One header that works for both calls.
          Accept: 'application/octet-stream',
        };
        const update = await check({ headers });
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

  if (phase.kind === 'no-credentials') {
    return (
      <div className="docker-banner warn">
        <span className="docker-banner-icon">🔑</span>
        <div className="docker-banner-body">
          <div className="docker-banner-title">无法检查更新:未配置 GitHub 凭证</div>
          <div className="docker-banner-desc">
            {phase.hint || '请运行 `gh auth login`,或在启动 easy-env 前导出 GITHUB_TOKEN。'}
          </div>
        </div>
        <button
          className="docker-banner-close"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
          title="本次会话不再提示"
        >
          ×
        </button>
      </div>
    );
  }

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
