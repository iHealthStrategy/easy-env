// Single source of truth for the self-updater state. Used by:
//  - the sidebar brand area (just needs to know "is there a new version?"
//    so it can show the red NEW pill);
//  - the dedicated update window (needs the full state machine to render
//    the install flow with progress + restart).
// Each window holds its own copy — they don't share state via Tauri events
// because `check()` is cheap and stateless on the plugin side, and keeping
// both windows independent avoids cross-window coupling bugs.
import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export type UpdaterPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; update: Update }
  | { kind: 'downloading'; downloaded: number; total: number | null; update: Update }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export const IS_TAURI =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

// 6h between background re-checks. GitHub Releases can take much more,
// but more frequent polling adds nothing useful — the user typically
// won't look at a sidebar badge twice an hour.
const RECHECK_MS = 6 * 60 * 60 * 1000;

interface UseUpdaterOptions {
  // Whether to poll automatically. Set false in the update window where
  // we want a single user-driven check.
  autoPoll?: boolean;
}

export function useUpdater(opts: UseUpdaterOptions = {}) {
  const { autoPoll = true } = opts;
  const [phase, setPhase] = useState<UpdaterPhase>({ kind: 'idle' });
  // Latch — once any check returns "available" we keep the badge on
  // regardless of subsequent phase transitions (downloading/ready/error)
  // so the sidebar pill doesn't flicker mid-install.
  const [hasUpdate, setHasUpdate] = useState(false);
  const aliveRef = useRef(true);

  const runCheck = useCallback(async () => {
    if (!IS_TAURI) return;
    setPhase((prev) => (prev.kind === 'idle' || prev.kind === 'up-to-date' || prev.kind === 'error' ? { kind: 'checking' } : prev));
    try {
      const update = await check();
      if (!aliveRef.current) return;
      if (update?.available) {
        setHasUpdate(true);
        setPhase({ kind: 'available', update });
      } else {
        setPhase({ kind: 'up-to-date' });
      }
    } catch (e) {
      if (!aliveRef.current) return;
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const install = useCallback(async () => {
    if (!IS_TAURI) return;
    // Read the current update off state at call time — we re-derive
    // instead of capturing in closure so a stale reference can't leak.
    setPhase((prev) => {
      if (prev.kind !== 'available') return prev;
      const update = prev.update;
      // Kick off the async install in a separate microtask so we can
      // still return the new "downloading" state synchronously.
      void (async () => {
        try {
          let total: number | null = null;
          let downloaded = 0;
          await update.downloadAndInstall((event) => {
            if (!aliveRef.current) return;
            switch (event.event) {
              case 'Started':
                total = event.data.contentLength ?? null;
                setPhase({ kind: 'downloading', downloaded: 0, total, update });
                break;
              case 'Progress':
                downloaded += event.data.chunkLength;
                setPhase({ kind: 'downloading', downloaded, total, update });
                break;
              case 'Finished':
                setPhase({ kind: 'ready' });
                break;
            }
          });
        } catch (e) {
          if (!aliveRef.current) return;
          setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
          return;
        }
        // downloadAndInstall already swapped the binary on disk.
        try {
          await relaunch();
        } catch {
          // If relaunch fails the user can still quit manually — leave
          // the "ready" state up.
        }
      })();
      return { kind: 'downloading', downloaded: 0, total: null, update };
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    if (!IS_TAURI || !autoPoll) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await runCheck();
      if (aliveRef.current) timer = setTimeout(tick, RECHECK_MS);
    };
    tick();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [autoPoll, runCheck]);

  return { phase, hasUpdate, check: runCheck, install };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
