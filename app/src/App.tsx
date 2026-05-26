import type { MouseEvent } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { getCurrentWindow } from '@tauri-apps/api/window';
import logoUrl from './assets/logo.png';

// Explicit drag handler — more reliable than the data-tauri-drag-region
// attribute, which depends on Tauri's global mousedown delegation matching
// event.target exactly (so children with their own pointer events break it).
function startDrag(e: MouseEvent) {
  if (e.buttons !== 1) return;
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return;
  getCurrentWindow().startDragging().catch(() => {});
}
import { EnvsList } from './pages/EnvsList';
import { EnvDetail } from './pages/EnvDetail';
import { SnapshotsList } from './pages/SnapshotsList';
import { SnapshotDetail } from './pages/SnapshotDetail';
import { DiffsList } from './pages/DiffsList';
import { DiffDetail } from './pages/DiffDetail';
import { McpService } from './pages/McpService';
import { Variables } from './pages/Variables';
import { Settings } from './pages/Settings';
import { DaemonStatusBar } from './components/DaemonStatusBar';
import { DockerBanner } from './components/DockerBanner';
import { UpdateBanner } from './components/UpdateBanner';

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand" onMouseDown={startDrag}>
          <img src={logoUrl} alt="easy-env" width={96} height={96} />
        </div>
        <nav>
          <NavLink to="/" end>环境</NavLink>
          <NavLink to="/vars">变量</NavLink>
          <NavLink to="/snapshots">快照</NavLink>
          <NavLink to="/diffs">差异</NavLink>
          <NavLink to="/mcp">MCP 服务</NavLink>
          <NavLink to="/settings">设置</NavLink>
        </nav>
        <DaemonStatusBar />
      </aside>
      <main className="main">
        <div className="drag-strip" onMouseDown={startDrag} />
        <UpdateBanner />
        <DockerBanner />
        <Routes>
          <Route path="/" element={<EnvsList />} />
          <Route path="/envs/:envId" element={<EnvDetail />} />
          <Route path="/snapshots" element={<SnapshotsList />} />
          <Route path="/snapshots/:id" element={<SnapshotDetail />} />
          <Route path="/diffs" element={<DiffsList />} />
          <Route path="/diffs/:id" element={<DiffDetail />} />
          <Route path="/mcp" element={<McpService />} />
          <Route path="/vars" element={<Variables />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
