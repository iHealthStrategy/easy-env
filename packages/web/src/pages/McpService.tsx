import { useActivity, useHealth, useTools } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtRelative, fmtTime } from '../components/format';
import { describeTool } from '../i18n/tools';

const REFRESH_MS = 5_000;

export function McpService() {
  const health = useHealth({ refetchInterval: REFRESH_MS });
  const tools = useTools();
  const activity = useActivity({ refetchInterval: REFRESH_MS });

  return (
    <>
      <div className="page-header">
        <h2>MCP Service</h2>
        <span className="meta">auto-refresh every {REFRESH_MS / 1000}s</span>
      </div>

      {/* Daemon health */}
      <div className="card">
        <h3>Daemon</h3>
        {health.isPending ? (
          <div className="loading">checking…</div>
        ) : health.isError ? (
          <div className="error-banner">Daemon unreachable: {(health.error as Error).message}</div>
        ) : (
          <dl className="dl">
            <dt>Status</dt>
            <dd><span className="badge ready">running</span></dd>
            <dt>Version</dt>
            <dd><code>{health.data.version}</code></dd>
            <dt>PID</dt>
            <dd><code>{health.data.pid}</code></dd>
            <dt>Started</dt>
            <dd>
              {fmtTime(health.data.startedAt)}{' '}
              <span style={{ color: 'var(--fg-dim)' }}>({fmtUptime(health.data.uptimeMs)})</span>
            </dd>
          </dl>
        )}
      </div>

      {/* Activity stats */}
      <div className="card">
        <h3>Activity</h3>
        {activity.isPending ? (
          <div className="loading">loading…</div>
        ) : activity.isError ? (
          <div className="error-banner">{(activity.error as Error).message}</div>
        ) : (
          <dl className="dl">
            <dt>Total calls</dt>
            <dd><code>{activity.data.stats.total}</code></dd>
            <dt>Successful</dt>
            <dd><code style={{ color: 'var(--green)' }}>{activity.data.stats.ok}</code></dd>
            <dt>Errors</dt>
            <dd><code style={{ color: 'var(--red)' }}>{activity.data.stats.error}</code></dd>
          </dl>
        )}
      </div>

      {/* Recent activity table */}
      <div className="card">
        <h3>Recent calls</h3>
        <QueryState
          query={activity}
          empty={(d) => d.entries.length === 0}
          emptyMessage="No tool calls recorded since daemon started."
        >
          {(data) => (
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Status</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td><code>{e.tool}</code></td>
                    <td title={fmtTime(e.startedAt)}>{fmtRelative(e.startedAt)}</td>
                    <td>{e.durationMs}ms</td>
                    <td>
                      <span className={`badge ${e.status === 'ok' ? 'ready' : 'error'}`}>
                        {e.status}
                      </span>
                    </td>
                    <td>
                      {e.errorMessage ? (
                        <code
                          style={{ color: 'var(--red)' }}
                          title={e.errorMessage}
                        >
                          {summarizeError(e.errorMessage)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryState>
      </div>

      {/* Tools registry */}
      <div className="card">
        <h3>Available tools</h3>
        <QueryState query={tools}>
          {(data) => (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Name</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {data.tools.map((t) => (
                  <tr key={t.name}>
                    <td><code>{t.name}</code></td>
                    <td style={{ color: 'var(--fg-dim)' }}>{describeTool(t.name, t.description)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryState>
      </div>
    </>
  );
}

// Pull a one-line summary out of an error message. Zod errors arrive as
// a JSON-stringified array; we extract the human messages. Other errors
// are just collapsed to a single line.
function summarizeError(msg: string): string {
  const trimmed = msg.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const parts = parsed
          .map((p) => {
            if (p && typeof p === 'object' && 'path' in p && 'message' in p) {
              const path = Array.isArray((p as { path: unknown[] }).path)
                ? (p as { path: unknown[] }).path.join('.')
                : '';
              return path ? `${path}: ${(p as { message: string }).message}` : (p as { message: string }).message;
            }
            return JSON.stringify(p);
          })
          .join('; ');
        return truncate(parts, 100);
      }
    } catch {
      // fall through
    }
  }
  return truncate(trimmed.replace(/\s+/g, ' '), 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}
