// Close-button prompt. The Rust side intercepts the main window's close
// (when closeBehavior is "ask"), prevents it, and emits `close-requested`.
// We surface the choice here — collapse to the menu-bar tray (daemon keeps
// running) or quit — with an optional "remember this" that writes the
// preference so the prompt won't show again (changeable later in Settings).
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { tauri } from '../api/tauri';

export function CloseDialog() {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!tauri.isTauri) return;
    const unlisten = listen('close-requested', () => {
      setRemember(false);
      setOpen(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!open) return null;

  const choose = async (action: 'minimize' | 'quit') => {
    setBusy(true);
    try {
      await tauri.closeBehavior.resolve(action, remember);
      // 'minimize' just hides the window; close the dialog so a later reopen
      // starts clean. 'quit' exits the process, so this is moot there.
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => !busy && setOpen(false)}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">关闭 easy-env?</h3>
        <p className="modal-desc">
          收起到菜单栏会让守护进程在后台继续运行(环境/容器不中断);退出则会停止守护进程。
        </p>
        <div className="modal-actions">
          <button disabled={busy} onClick={() => choose('minimize')}>
            收起到菜单栏
          </button>
          <button className="btn-danger" disabled={busy} onClick={() => choose('quit')}>
            退出应用
          </button>
        </div>
        <label className="modal-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
          />
          记住我的选择(以后可在「设置」里修改)
        </label>
      </div>
    </div>
  );
}
