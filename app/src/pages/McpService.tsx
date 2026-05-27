import { useState } from 'react';
import { useActivity, useTools } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtRelative, fmtTime } from '../components/format';
import { describeTool } from '../i18n/tools';

const REFRESH_MS = 5_000;

type Tab = 'tools' | 'activity';

export function McpService() {
  const [tab, setTab] = useState<Tab>('tools');
  const tools = useTools();
  const activity = useActivity({ refetchInterval: REFRESH_MS });

  return (
    <div className="page">
      <div className="page-header">
        <h2>MCP 服务</h2>
        <span className="meta">每 {REFRESH_MS / 1000} 秒自动刷新</span>
      </div>
      <div className="page-body">

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'tools'}
          className={`tab ${tab === 'tools' ? 'active' : ''}`}
          onClick={() => setTab('tools')}
        >
          工具
        </button>
        <button
          role="tab"
          aria-selected={tab === 'activity'}
          className={`tab ${tab === 'activity' ? 'active' : ''}`}
          onClick={() => setTab('activity')}
        >
          调用
        </button>
      </div>

      {tab === 'tools' ? (
        <div className="card">
          <h3>可用工具</h3>
          <QueryState query={tools}>
            {(data) => (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 180 }}>名称</th>
                    <th>说明</th>
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
      ) : (
        <>
          {/* Activity stats */}
          <div className="card">
            <h3>调用统计</h3>
            {activity.isPending ? (
              <div className="loading">加载中…</div>
            ) : activity.isError ? (
              <div className="error-banner">{(activity.error as Error).message}</div>
            ) : (
              <dl className="dl">
                <dt>总调用数</dt>
                <dd><code>{activity.data.stats.total}</code></dd>
                <dt>成功</dt>
                <dd><code style={{ color: 'var(--green)' }}>{activity.data.stats.ok}</code></dd>
                <dt>失败</dt>
                <dd><code style={{ color: 'var(--red)' }}>{activity.data.stats.error}</code></dd>
              </dl>
            )}
          </div>

          {/* Recent activity table */}
          <div className="card">
            <h3>最近调用</h3>
            <QueryState
              query={activity}
              empty={(d) => d.entries.length === 0}
              emptyMessage="自守护进程启动以来还没有任何工具调用记录。"
            >
              {(data) => (
                <table>
                  <thead>
                    <tr>
                      <th>工具</th>
                      <th>开始时间</th>
                      <th>耗时</th>
                      <th>状态</th>
                      <th>错误</th>
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
                            {e.status === 'ok' ? '成功' : '失败'}
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
        </>
      )}
      </div>
    </div>
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
