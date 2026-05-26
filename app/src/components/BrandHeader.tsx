// Sidebar brand block: logo, version stamp under it, and an optional red
// "NEW" pill that surfaces when the background updater has spotted a new
// release. Clicking the pill opens the dedicated update window (handled
// in Rust via `open_update_window` so both this and the menu item share
// one code path / one window).
import type { MouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import logoUrl from '../assets/logo.png';
import { IS_TAURI } from '../hooks/useUpdater';

function startDrag(e: MouseEvent) {
  if (e.buttons !== 1) return;
  if (!IS_TAURI) return;
  getCurrentWindow().startDragging().catch(() => {});
}

interface Props {
  hasUpdate: boolean;
}

export function BrandHeader({ hasUpdate }: Props) {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    if (!IS_TAURI) return;
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);

  const onBadgeClick = (e: MouseEvent) => {
    // Stop the drag handler above from swallowing the click as a window drag.
    e.stopPropagation();
    if (!IS_TAURI) return;
    invoke('open_update_window').catch(() => {});
  };

  return (
    <div className="brand" onMouseDown={startDrag}>
      {hasUpdate && (
        <button
          type="button"
          className="brand-new-badge"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onBadgeClick}
          title="发现新版本,点击安装"
          aria-label="发现新版本"
        >
          NEW
        </button>
      )}
      <img src={logoUrl} alt="easy-env" width={96} height={96} />
      {version && <div className="brand-version">v{version}</div>}
    </div>
  );
}
