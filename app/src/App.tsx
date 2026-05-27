import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { EnvsList } from './pages/EnvsList';
import { EnvDetail } from './pages/EnvDetail';
import { McpService } from './pages/McpService';
import { Variables } from './pages/Variables';
import { Settings } from './pages/Settings';
import { Help } from './pages/Help';
import { Updater } from './pages/Updater';
import { DaemonStatusBar } from './components/DaemonStatusBar';
import { DockerBanner } from './components/DockerBanner';
import { BrandHeader } from './components/BrandHeader';
import { CloseDialog } from './components/CloseDialog';
import { IS_TAURI, useUpdater } from './hooks/useUpdater';

// Explicit drag handler — more reliable than data-tauri-drag-region,
// which depends on Tauri's mousedown delegation matching event.target.
function startDrag(e: MouseEvent) {
  if (e.buttons !== 1) return;
  if (!IS_TAURI) return;
  getCurrentWindow().startDragging().catch(() => {});
}

// Delegated drag for the sticky page header: grabbing anywhere on the bar
// moves the window, but never when the user is grabbing an interactive
// element or a selectable id (links, buttons, inputs, <code> ids).
function startHeaderDrag(e: MouseEvent) {
  if (e.buttons !== 1) return;
  if (!IS_TAURI) return;
  const target = e.target as HTMLElement;
  if (!target.closest('.page-header')) return;
  if (target.closest('a, button, input, select, textarea, code')) return;
  getCurrentWindow().startDragging().catch(() => {});
}

export default function App() {
  const { pathname } = useLocation();

  // The dedicated update window loads the same bundle but at #/update.
  // Render only the Updater there — no sidebar / nav / daemon chrome.
  if (pathname === '/update') {
    return (
      <Routes>
        <Route path="/update" element={<Updater />} />
      </Routes>
    );
  }

  return <MainShell />;
}

function MainShell() {
  // Main window owns the auto-poll. The update window does its own
  // on-demand check (autoPoll: false) so we don't double-poll.
  const { hasUpdate } = useUpdater({ autoPoll: true });

  return (
    <div className="app">
      <CloseDialog />
      <aside className="sidebar">
        <BrandHeader hasUpdate={hasUpdate} />
        <nav>
          <NavLink to="/" end>环境</NavLink>
          <NavLink to="/vars">变量</NavLink>
          <NavLink to="/mcp">MCP 服务</NavLink>
          <NavLink to="/settings">设置</NavLink>
          <NavLink to="/help">帮助</NavLink>
        </nav>
        <DaemonStatusBar />
      </aside>
      <main className="main" onMouseDown={startHeaderDrag}>
        <div className="drag-strip" onMouseDown={startDrag} />
        <DockerBanner />
        <Routes>
          <Route path="/" element={<EnvsList />} />
          <Route path="/envs/:envId" element={<EnvDetail />} />
          <Route path="/mcp" element={<McpService />} />
          <Route path="/vars" element={<Variables />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/help" element={<Help />} />
        </Routes>
      </main>
    </div>
  );
}
