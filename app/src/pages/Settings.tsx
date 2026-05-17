// The Settings page is the heart of the Tauri-only experience: instead of
// driving Skill install / MCP registration / daemon lifecycle from a separate
// CLI, the user flips toggles here. Each toggle round-trips through a Tauri
// command and re-reads status, so the UI always reflects the on-disk truth.
import { useEffect, useState } from 'react';
import {
  tauri,
  type DaemonStatus,
  type McpStatus,
  type PathsInfo,
  type SkillStatus,
} from '../api/tauri';

type Loading = 'idle' | 'loading' | 'busy';

export function Settings() {
  const [paths, setPaths] = useState<PathsInfo | null>(null);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [skill, setSkill] = useState<SkillStatus | null>(null);
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [state, setState] = useState<Loading>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!tauri.isTauri) {
      setError(
        'Tauri runtime not detected. Launch via `npm run tauri:dev` to use Settings.',
      );
      setState('idle');
      return;
    }
    setState('loading');
    setError(null);
    try {
      const [p, d, s, m] = await Promise.all([
        tauri.paths(),
        tauri.daemon.status(),
        tauri.skill.status(),
        tauri.mcp.status(),
      ]);
      setPaths(p);
      setDaemon(d);
      setSkill(s);
      setMcp(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setState('idle');
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // Poll daemon status every 2s so the toggle stays in sync when state
  // changes outside this page (sidebar Stop button, external `kill`, MCP
  // server auto-spawn, etc.). Skill/MCP statuses are filesystem state that
  // only this page mutates, so they don't need polling.
  useEffect(() => {
    if (!tauri.isTauri) return;
    let alive = true;
    const tick = async () => {
      try {
        const d = await tauri.daemon.status();
        if (alive) setDaemon(d);
      } catch {
        // Silent — a transient command failure shouldn't flip the toggle UI.
      }
    };
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const runToggle = async (kind: 'skill' | 'mcp' | 'daemon') => {
    setState('busy');
    setError(null);
    try {
      if (kind === 'skill') {
        if (skill?.all_installed) setSkill(await tauri.skill.uninstall());
        else setSkill(await tauri.skill.install());
      }
      if (kind === 'mcp') {
        if (mcp?.registered) setMcp(await tauri.mcp.unregister());
        else setMcp(await tauri.mcp.register());
      }
      if (kind === 'daemon') {
        if (daemon?.healthy) setDaemon(await tauri.daemon.stop());
        else setDaemon(await tauri.daemon.start());
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setState('idle');
    }
  };

  return (
    <div>
      <div className="page-header">
        <h2>Settings</h2>
        <span className="meta">All actions write to your local filesystem only.</span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {state === 'loading' && <div className="loading">Loading…</div>}

      <div className="card">
        <h3>Daemon</h3>
        <ToggleRow
          label="Run easy-env daemon"
          description={
            daemon?.healthy
              ? `Listening on ${daemon.url}${daemon.version ? ` (v${daemon.version})` : ''}.`
              : 'Spawns the Node.js daemon as a child process. Required for env / snapshot / diff endpoints.'
          }
          on={!!daemon?.healthy}
          busy={state === 'busy'}
          onChange={() => runToggle('daemon')}
        />
        {daemon?.last_error && (
          <div className="error-banner">Last error: {daemon.last_error}</div>
        )}
      </div>

      <div className="card">
        <h3>Claude Code skill</h3>
        <ToggleRow
          label="Install easy-env skill into ~/.claude/skills"
          description={
            skill
              ? `${skill.entries.length} skill file(s). Target: ${skill.target_dir}`
              : 'Copy the bootstrap markdown into your Claude Code skills directory.'
          }
          on={!!skill?.all_installed}
          busy={state === 'busy'}
          onChange={() => runToggle('skill')}
        />
        {skill && skill.entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Skill</th>
                <th>Installed</th>
                <th>Up to date</th>
              </tr>
            </thead>
            <tbody>
              {skill.entries.map((e) => (
                <tr key={e.name}>
                  <td><code>{e.name}</code></td>
                  <td>
                    {e.installed ? (
                      <span className="badge ready">Yes</span>
                    ) : (
                      <span className="badge destroyed">No</span>
                    )}
                  </td>
                  <td>
                    {e.up_to_date ? (
                      <span className="badge ready">Yes</span>
                    ) : (
                      <span className="badge starting">Stale</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Claude Code MCP server</h3>
        <ToggleRow
          label="Register easy-env in ~/.claude.json"
          description={
            mcp?.registered
              ? `Registered: ${mcp.current_command} ${mcp.current_args?.join(' ') ?? ''}`
              : 'Adds the easy-env MCP stdio server to your Claude Code config. Requires the mcp-server package to be built.'
          }
          on={!!mcp?.registered}
          busy={state === 'busy'}
          onChange={() => runToggle('mcp')}
          disabled={!mcp?.server_entry_exists}
        />
        {mcp && !mcp.server_entry_exists && (
          <div className="error-banner">
            Server entry not built. Run{' '}
            <code>npm run build --workspace easy-env-mcp</code> first.
          </div>
        )}
      </div>

      <div className="card">
        <h3>Paths</h3>
        <dl className="dl">
          <dt>Repo root</dt>
          <dd><code>{paths?.repo_root ?? '—'}</code></dd>
          <dt>MCP server dir</dt>
          <dd><code>{paths?.mcp_server_dir ?? '—'}</code></dd>
          <dt>Daemon entry</dt>
          <dd>
            <code>{paths?.daemon_entry ?? '—'}</code>{' '}
            {paths && (
              <span className={`badge ${paths.daemon_entry_exists ? 'ready' : 'destroyed'}`}>
                {paths.daemon_entry_exists ? 'present' : 'missing'}
              </span>
            )}
          </dd>
          <dt>MCP server entry</dt>
          <dd>
            <code>{paths?.server_entry ?? '—'}</code>{' '}
            {paths && (
              <span className={`badge ${paths.server_entry_exists ? 'ready' : 'destroyed'}`}>
                {paths.server_entry_exists ? 'present' : 'missing'}
              </span>
            )}
          </dd>
          <dt>Claude skills dir</dt>
          <dd><code>{paths?.claude_skills_dir ?? '—'}</code></dd>
          <dt>Claude config</dt>
          <dd><code>{paths?.claude_config_path ?? '—'}</code></dd>
          <dt>Node binary</dt>
          <dd><code>{paths?.node_binary ?? 'not found'}</code></dd>
        </dl>
      </div>
    </div>
  );
}

function ToggleRow(props: {
  label: string;
  description: string;
  on: boolean;
  busy: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <div className="toggle-label">{props.label}</div>
        <div className="toggle-desc">{props.description}</div>
      </div>
      <label className={`switch ${props.on ? 'on' : ''} ${props.disabled ? 'disabled' : ''}`}>
        <input
          type="checkbox"
          checked={props.on}
          onChange={props.onChange}
          disabled={props.busy || props.disabled}
        />
        <span className="slider" />
      </label>
    </div>
  );
}
