import { NavLink, Route, Routes } from 'react-router-dom';
import { EnvsList } from './pages/EnvsList';
import { EnvDetail } from './pages/EnvDetail';
import { SnapshotsList } from './pages/SnapshotsList';
import { SnapshotDetail } from './pages/SnapshotDetail';
import { DiffsList } from './pages/DiffsList';
import { DiffDetail } from './pages/DiffDetail';
import { McpService } from './pages/McpService';
import { Variables } from './pages/Variables';

export default function App() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>easy-env</h1>
        <nav>
          <NavLink to="/" end>Environments</NavLink>
          <NavLink to="/vars">Variables</NavLink>
          <NavLink to="/snapshots">Snapshots</NavLink>
          <NavLink to="/diffs">Diffs</NavLink>
          <NavLink to="/mcp">MCP Service</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<EnvsList />} />
          <Route path="/envs/:envId" element={<EnvDetail />} />
          <Route path="/snapshots" element={<SnapshotsList />} />
          <Route path="/snapshots/:id" element={<SnapshotDetail />} />
          <Route path="/diffs" element={<DiffsList />} />
          <Route path="/diffs/:id" element={<DiffDetail />} />
          <Route path="/mcp" element={<McpService />} />
          <Route path="/vars" element={<Variables />} />
        </Routes>
      </main>
    </div>
  );
}
