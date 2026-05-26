// Dedicated update window. Mounted only when the WebviewWindow labeled
// `update` (opened from Rust via ensure_update_window) loads index.html
// at hash #/update. Owns its own check/install loop (autoPoll: false)
// because we want a deterministic user-driven flow per window open; the
// main window already polls in the background.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { formatBytes, IS_TAURI, useUpdater, type UpdaterPhase } from '../hooks/useUpdater';

export function Updater() {
  const { phase, check, install } = useUpdater({ autoPoll: false });

  useEffect(() => {
    if (IS_TAURI) check();
  }, [check]);

  const close = () => {
    if (!IS_TAURI) return;
    getCurrentWindow().close().catch(() => {});
  };

  return (
    <div className="updater-window">
      {/* titleBarStyle: Overlay hides chrome but keeps traffic lights.
          This strip gives the user a drag handle in the header area. */}
      <div className="updater-drag" />
      <div className="updater-card">
        <UpdaterBody phase={phase} onCheck={check} onInstall={install} onClose={close} />
      </div>
    </div>
  );
}

interface BodyProps {
  phase: UpdaterPhase;
  onCheck: () => void;
  onInstall: () => void;
  onClose: () => void;
}

function UpdaterBody({ phase, onCheck, onInstall, onClose }: BodyProps) {
  switch (phase.kind) {
    case 'idle':
    case 'checking':
      return (
        <Layout title="正在检查更新…" icon="🔄" tone="info">
          <p className="updater-desc">连接更新服务器,稍候。</p>
          <Spinner />
        </Layout>
      );
    case 'up-to-date':
      return (
        <Layout title="已是最新版本" icon="✅" tone="ok">
          <p className="updater-desc">你已经在使用最新的 easy-env。</p>
          <Actions>
            <button onClick={onCheck}>重新检查</button>
            <button className="primary" onClick={onClose}>关闭</button>
          </Actions>
        </Layout>
      );
    case 'available':
      return (
        <Layout title="发现新版本" icon="⬆️" tone="info">
          <div className="updater-version-row">
            {phase.update.currentVersion && (
              <span className="updater-version old">v{phase.update.currentVersion}</span>
            )}
            <span className="updater-arrow">→</span>
            <span className="updater-version new">v{phase.update.version}</span>
          </div>
          {phase.update.body && (
            <div className="updater-notes">
              <div className="updater-notes-label">更新内容</div>
              <pre>{phase.update.body}</pre>
            </div>
          )}
          <Actions>
            <button onClick={onClose}>稍后</button>
            <button className="primary" onClick={onInstall}>立即安装</button>
          </Actions>
        </Layout>
      );
    case 'downloading': {
      const pct = phase.total ? Math.min(100, (phase.downloaded / phase.total) * 100) : null;
      return (
        <Layout title="正在下载更新" icon="⬇️" tone="info">
          <div className="updater-progress">
            <div className="updater-progress-track">
              <div
                className={`updater-progress-fill${pct == null ? ' indeterminate' : ''}`}
                style={pct != null ? { width: `${pct}%` } : undefined}
              />
            </div>
            <div className="updater-progress-text">
              {phase.total
                ? `${formatBytes(phase.downloaded)} / ${formatBytes(phase.total)} (${pct?.toFixed(0)}%)`
                : formatBytes(phase.downloaded)}
            </div>
          </div>
          <p className="updater-desc">下载完成后会自动重启应用。</p>
          <SlowDownloadHint version={phase.update.version} />
        </Layout>
      );
    }
    case 'ready':
      return (
        <Layout title="安装完成,正在重启…" icon="🚀" tone="ok">
          <p className="updater-desc">若没有自动重启,请手动关闭并重新打开 easy-env。</p>
          <Spinner />
        </Layout>
      );
    case 'error':
      return (
        <Layout title="更新失败" icon="⚠️" tone="error">
          <pre className="updater-error">{phase.message}</pre>
          <Actions>
            <button onClick={onClose}>关闭</button>
            <button className="primary" onClick={onCheck}>重试</button>
          </Actions>
        </Layout>
      );
  }
}

function Layout({
  title,
  icon,
  tone,
  children,
}: {
  title: string;
  icon: string;
  tone: 'info' | 'ok' | 'error';
  children: ReactNode;
}) {
  return (
    <>
      <div className={`updater-header tone-${tone}`}>
        <div className="updater-icon" aria-hidden>{icon}</div>
        <h1 className="updater-title">{title}</h1>
      </div>
      <div className="updater-body">{children}</div>
    </>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="updater-actions">{children}</div>;
}

function Spinner() {
  return <div className="updater-spinner" aria-hidden />;
}

// Mainland China users hitting GitHub Releases over Fastly often get
// 30–80 KB/s — even a 12 MB updater archive can take several minutes,
// and the progress bar looks "stuck" to anyone who hasn't been told
// that's normal. After 15 s in the downloading state we surface an
// escape hatch: open the GitHub Release page in the user's default
// browser so they can grab the DMG via whatever network path their
// browser uses (corp proxy, VPN, scientific bridge, etc.). The
// in-app updater keeps trying in the background regardless.
function SlowDownloadHint({ version }: { version: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 15_000);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  const url = `https://github.com/iHealthStrategy/easy-env/releases/tag/v${version}`;
  const openInBrowser = () => {
    if (!IS_TAURI) return;
    openUrl(url).catch(() => {});
  };
  return (
    <div className="updater-slow-hint">
      <span>下载较慢?GitHub 在国内常常只有几十 KB/s,可以直接在浏览器里下载 DMG 手动安装。</span>
      <button type="button" className="link" onClick={openInBrowser}>打开发布页 ↗</button>
    </div>
  );
}
