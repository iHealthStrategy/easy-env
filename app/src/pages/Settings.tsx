// The Settings page is the heart of the Tauri-only experience: instead of
// driving Skill install / MCP registration / daemon lifecycle from a separate
// CLI, the user flips toggles here. Each toggle round-trips through a Tauri
// command and re-reads status, so the UI always reflects the on-disk truth.
import { useEffect, useState } from 'react';
import {
  tauri,
  type CloseBehavior,
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
  const [closeBehavior, setCloseBehavior] = useState<CloseBehavior>('ask');
  const [nodeVer, setNodeVer] = useState<string | null>(null);
  const [state, setState] = useState<Loading>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    if (!tauri.isTauri) {
      setError(
        '未检测到 Tauri 运行时。请通过 `npm run tauri:dev` 启动后使用设置页。',
      );
      setState('idle');
      return;
    }
    setState('loading');
    setError(null);
    try {
      const [p, d, s, m, cb, nv] = await Promise.all([
        tauri.paths(),
        tauri.daemon.status(),
        tauri.skill.status(),
        tauri.mcp.status(),
        tauri.closeBehavior.get(),
        tauri.nodeVersion(),
      ]);
      setPaths(p);
      setDaemon(d);
      setSkill(s);
      setMcp(m);
      setCloseBehavior(cb);
      setNodeVer(nv);
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

  const changeCloseBehavior = async (b: CloseBehavior) => {
    const prev = closeBehavior;
    setCloseBehavior(b); // optimistic
    try {
      await tauri.closeBehavior.set(b);
    } catch (e) {
      setCloseBehavior(prev);
      setError(String(e));
    }
  };

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
    <div className="page">
      <div className="page-header">
        <h2>设置</h2>
        <span className="meta">所有操作仅写入本地文件系统。</span>
      </div>
      <div className="page-body">

      {error && <div className="error-banner">{error}</div>}
      {state === 'loading' && <div className="loading">加载中…</div>}

      <div className="card">
        <h3>守护进程</h3>
        <ToggleRow
          label="运行 easy-env 守护进程"
          description={
            daemon?.healthy
              ? `正在监听 ${daemon.url}。`
              : '以子进程方式启动 Node.js 守护进程。env / snapshot / diff 等接口都依赖它。'
          }
          on={!!daemon?.healthy}
          busy={state === 'busy'}
          onChange={() => runToggle('daemon')}
        />
        {daemon?.last_error && (
          <div className="error-banner">上次错误:{daemon.last_error}</div>
        )}
      </div>

      <div className="card">
        <h3>Claude Code 技能</h3>
        <ToggleRow
          label="将 easy-env 技能安装到 ~/.claude/skills"
          description={
            skill
              ? `${skill.entries.length} 个技能文件。目标目录:${skill.target_dir}`
              : '把引导用的 markdown 复制到 Claude Code 的 skills 目录。'
          }
          on={!!skill?.all_installed}
          busy={state === 'busy'}
          onChange={() => runToggle('skill')}
        />
        {skill && skill.entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>技能</th>
                <th>已安装</th>
                <th>是否最新</th>
              </tr>
            </thead>
            <tbody>
              {skill.entries.map((e) => (
                <tr key={e.name}>
                  <td><code>{e.name}</code></td>
                  <td>
                    {e.installed ? (
                      <span className="badge ready">是</span>
                    ) : (
                      <span className="badge destroyed">否</span>
                    )}
                  </td>
                  <td>
                    {e.up_to_date ? (
                      <span className="badge ready">最新</span>
                    ) : (
                      <span className="badge starting">过期</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Claude Code MCP 服务器</h3>
        <ToggleRow
          label="在 ~/.claude.json 中注册 easy-env"
          description={
            mcp?.registered
              ? `已注册:${mcp.current_command} ${mcp.current_args?.join(' ') ?? ''}`
              : '把 easy-env MCP stdio 服务器添加到 Claude Code 配置中。需要先构建 mcp-server 包。'
          }
          on={!!mcp?.registered}
          busy={state === 'busy'}
          onChange={() => runToggle('mcp')}
          disabled={!mcp?.server_entry_exists}
        />
        {mcp && !mcp.server_entry_exists && (
          <div className="error-banner">
            服务器入口尚未构建。请先运行{' '}
            <code>npm run build --workspace easy-env-mcp</code>。
          </div>
        )}
      </div>

      <div className="card">
        <h3>关闭按钮行为</h3>
        <p className="meta" style={{ margin: '0 0 12px' }}>
          点窗口左上角关闭按钮时的行为。随时可在这里修改。
        </p>
        {([
          ['ask', '每次询问', '弹窗让你选择收起还是退出。'],
          ['minimize', '收起到菜单栏', '隐藏窗口,守护进程在后台继续运行;点菜单栏图标可重新打开。'],
          ['quit', '退出应用', '停止守护进程并退出。'],
        ] as [CloseBehavior, string, string][]).map(([value, label, desc]) => (
          <label key={value} className="radio-row">
            <input
              type="radio"
              name="close-behavior"
              checked={closeBehavior === value}
              onChange={() => changeCloseBehavior(value)}
            />
            <span>
              <span className="radio-label">{label}</span>
              <span className="radio-desc">{desc}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="card">
        <h3>路径</h3>
        <dl className="dl">
          <dt>仓库根目录</dt>
          <dd><code>{paths?.repo_root ?? '—'}</code></dd>
          <dt>MCP server 目录</dt>
          <dd><code>{paths?.mcp_server_dir ?? '—'}</code></dd>
          <dt>守护进程入口</dt>
          <dd>
            <code>{paths?.daemon_entry ?? '—'}</code>{' '}
            {paths && (
              <span className={`badge ${paths.daemon_entry_exists ? 'ready' : 'destroyed'}`}>
                {paths.daemon_entry_exists ? '存在' : '缺失'}
              </span>
            )}
          </dd>
          <dt>MCP 服务器入口</dt>
          <dd>
            <code>{paths?.server_entry ?? '—'}</code>{' '}
            {paths && (
              <span className={`badge ${paths.server_entry_exists ? 'ready' : 'destroyed'}`}>
                {paths.server_entry_exists ? '存在' : '缺失'}
              </span>
            )}
          </dd>
          <dt>Claude skills 目录</dt>
          <dd><code>{paths?.claude_skills_dir ?? '—'}</code></dd>
          <dt>Claude 配置文件</dt>
          <dd><code>{paths?.claude_config_path ?? '—'}</code></dd>
          <dt>Node 可执行文件</dt>
          <dd><code>{paths?.node_binary ?? '未找到'}</code></dd>
          <dt>Node 版本</dt>
          <dd><NodeVersionBadge version={nodeVer} /></dd>
        </dl>
      </div>
      </div>
    </div>
  );
}

// Shows the detected Node version with a pass/fail badge against the 18+
// requirement. The daemon spawns the system `node`, so an old / missing Node
// here means env.up will fail on this machine.
function NodeVersionBadge({ version }: { version: string | null }) {
  if (!version) {
    return (
      <>
        <code>未检测到</code>{' '}
        <span className="badge destroyed">需要 Node 18+</span>
      </>
    );
  }
  const major = parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  const ok = Number.isFinite(major) && major >= 18;
  return (
    <>
      <code>{version}</code>{' '}
      <span className={`badge ${ok ? 'ready' : 'destroyed'}`}>
        {ok ? '满足要求' : '需要 18+'}
      </span>
    </>
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
