// Top-of-window banner that warns when Docker isn't usable. easy-env relies
// on Docker to spawn mongo/redis containers, so without it nothing past
// env.up works. We probe once on mount, then re-probe every 8s while the
// state is bad — that way the banner disappears the moment the user starts
// Docker Desktop without forcing them to restart the app. When Docker is
// fine we stop polling.
import { useEffect, useState } from 'react';
import { tauri, type DockerStatus } from '../api/tauri';

const POLL_BAD_MS = 8000;

export function DockerBanner() {
  const [status, setStatus] = useState<DockerStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!tauri.isTauri) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = async () => {
      try {
        const s = await tauri.docker.status();
        if (!alive) return;
        setStatus(s);
        if (s.state !== 'running') {
          timer = setTimeout(probe, POLL_BAD_MS);
        }
      } catch {
        // ignore — banner just won't show
      }
    };
    probe();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // If status came back ok, drop the dismissal so a future regression shows
  // the banner again.
  useEffect(() => {
    if (status?.state === 'running' && dismissed) setDismissed(false);
  }, [status, dismissed]);

  if (!tauri.isTauri) return null;
  if (!status || status.state === 'running' || dismissed) return null;

  const isMissing = status.state === 'not-installed';
  return (
    <div className={`docker-banner ${isMissing ? 'danger' : 'warn'}`}>
      <span className="docker-banner-icon">{isMissing ? '⛔' : '⚠️'}</span>
      <div className="docker-banner-body">
        <div className="docker-banner-title">
          {isMissing ? '未检测到 Docker' : 'Docker 未运行'}
        </div>
        <div className="docker-banner-desc">
          {isMissing ? (
            <>
              easy-env 需要 Docker 来启动 Mongo / Redis 容器。请先安装{' '}
              <a
                href="https://www.docker.com/products/docker-desktop/"
                target="_blank"
                rel="noreferrer"
              >
                Docker Desktop
              </a>
              ,然后重新打开本应用。
            </>
          ) : (
            <>
              检测到 Docker 已安装(<code>{status.binary}</code>),但引擎没有响应。
              请启动 Docker Desktop 后稍等几秒,横幅会自动消失。
              {status.error && (
                <div className="docker-banner-err">{status.error}</div>
              )}
            </>
          )}
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
