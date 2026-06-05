import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEnv, useEnvDown, useMonitorConfig, useSetMonitorConfig, useTraffic } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { envStatusLabel, fmtTime } from '../components/format';
import type { ContainerHandle } from '../api/types';

export function EnvDetail() {
  const { envId = '' } = useParams();
  const query = useEnv(envId);

  return (
    <div className="page">
      <div className="page-header">
        <h2>
          <Link to="/">环境</Link> / <code>{envId}</code>
        </h2>
        <DestroyEnvButton envId={envId} />
      </div>
      <div className="page-body">

      <QueryState query={query}>
        {(env) => (
          <>
            <div className="card">
              <h3>状态</h3>
              <dl className="dl">
                <dt>项目</dt>
                <dd>{env.projectName ? <code>{env.projectName}</code> : <span className="meta">—</span>}</dd>
                <dt>状态</dt>
                <dd>
                  <span className={`badge ${env.status}`}>{envStatusLabel(env.status)}</span>
                  {env.status === 'starting' && env.pullingImage && (
                    <span className="pulling-tag" title={`正在下载镜像 ${env.pullingImage}`}>
                      ⬇ 正在下载 <code>{env.pullingImage}</code>(首次较慢)
                    </span>
                  )}
                </dd>
                <dt>创建时间</dt>
                <dd>{fmtTime(env.createdAt)}</dd>
                <dt>Mongo 可达</dt>
                <dd>{env.health.mongoReachable ? '是' : '否'}</dd>
                <dt>Redis 可达</dt>
                <dd>{env.health.redisReachable ? '是' : '否'}</dd>
                {env.containers.rabbit && (
                  <>
                    <dt>Rabbit 可达</dt>
                    <dd>{env.health.rabbitReachable ? '是' : '否'}</dd>
                  </>
                )}
                {env.containers.clickhouse && (
                  <>
                    <dt>ClickHouse 可达</dt>
                    <dd>{env.health.clickhouseReachable ? '是' : '否'}</dd>
                  </>
                )}
                {env.error && (
                  <>
                    <dt>错误</dt>
                    <dd><code>{env.error}</code></dd>
                  </>
                )}
              </dl>
            </div>

            <div className="card">
              <h3>解析后的 URL</h3>
              <dl className="dl">
                {env.resolved.mongoUrl && (
                  <>
                    <dt>mongoUrl</dt>
                    <dd><code>{env.resolved.mongoUrl}</code></dd>
                  </>
                )}
                {env.resolved.redisUrl && (
                  <>
                    <dt>redisUrl</dt>
                    <dd><code>{env.resolved.redisUrl}</code></dd>
                  </>
                )}
                {env.resolved.rabbitUrl && (
                  <>
                    <dt>rabbitUrl</dt>
                    <dd><code>{env.resolved.rabbitUrl}</code></dd>
                  </>
                )}
                {env.resolved.rabbitManagementUrl && (
                  <>
                    <dt>rabbitManagementUrl</dt>
                    <dd><a href={env.resolved.rabbitManagementUrl} target="_blank" rel="noreferrer"><code>{env.resolved.rabbitManagementUrl}</code></a></dd>
                  </>
                )}
                {env.resolved.clickhouseUrl && (
                  <>
                    <dt>clickhouseUrl</dt>
                    <dd><code>{env.resolved.clickhouseUrl}</code></dd>
                  </>
                )}
                {env.resolved.clickhouseDbName && (
                  <>
                    <dt>clickhouseDbName</dt>
                    <dd><code>{env.resolved.clickhouseDbName}</code></dd>
                  </>
                )}
                {env.resolved.clickhouseCluster && (
                  <>
                    <dt>clickhouseCluster</dt>
                    <dd><code>{env.resolved.clickhouseCluster}</code> <span className="meta">(Keeper + 单节点集群)</span></dd>
                  </>
                )}
                {env.resolved.dbName && (
                  <>
                    <dt>dbName</dt>
                    <dd><code>{env.resolved.dbName}</code></dd>
                  </>
                )}
                {env.resolved.baseUrl && (
                  <>
                    <dt>baseUrl</dt>
                    <dd><code>{env.resolved.baseUrl}</code></dd>
                  </>
                )}
              </dl>
            </div>

            {env.containers.mongo && env.status === 'ready' && <TrafficPanel envId={envId} />}

            <ContainerCard title="Mongo" handle={env.containers.mongo} />
            <ContainerCard title="Redis" handle={env.containers.redis} />
            <ContainerCard title="Rabbit" handle={env.containers.rabbit} />
            <ContainerCard title="ClickHouse" handle={env.containers.clickhouse} />

            {Object.keys(env.labels).length > 0 && (
              <div className="card">
                <h3>标签</h3>
                <dl className="dl">
                  {Object.entries(env.labels).map(([k, v]) => (
                    <span key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd><code>{v}</code></dd>
                    </span>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}
      </QueryState>
      </div>
    </div>
  );
}

// Teardown from the detail view (mirrors the list's row button). Two-step
// confirm, then navigate back to the list once the env is destroyed.
function DestroyEnvButton({ envId }: { envId: string }) {
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const down = useEnvDown();

  if (!confirming) {
    return (
      <button className="btn-ghost-danger" onClick={() => setConfirming(true)}>
        销毁环境
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="meta">停止容器并移除?</span>
      <button
        className="btn-danger"
        disabled={down.isPending}
        onClick={() => down.mutate(envId, { onSuccess: () => navigate('/') })}
      >
        {down.isPending ? '销毁中…' : '确认销毁'}
      </button>
      <button disabled={down.isPending} onClick={() => setConfirming(false)}>
        取消
      </button>
    </span>
  );
}

// MongoDB traffic monitoring. Two cards: a database picker + capture toggle,
// and a live table of captured operations. Only rendered for ready envs that
// have a Mongo backend.
function TrafficPanel({ envId }: { envId: string }) {
  const cfg = useMonitorConfig(envId);
  const setCfg = useSetMonitorConfig(envId);
  const enabled = cfg.data?.enabled ?? false;
  const traffic = useTraffic(envId, enabled);

  const selected = new Set(cfg.data?.selected ?? []);
  const available = cfg.data?.available ?? [];
  // Show available dbs plus any persisted selection that isn't currently
  // present (db not created yet / dropped) — we keep, never silently drop it.
  const allDbs = [...new Set([...available, ...selected])].sort();
  // Can't capture with nothing selected — enabling would be a silent no-op.
  const canEnable = selected.size > 0;

  // Toggling a db while capture is ON must re-reconcile the running profiler,
  // not just persist intent — so carry `enabled:true` along (the daemon
  // persists-then-re-enables in the right order).
  const toggleDb = (db: string) => {
    const next = new Set(selected);
    if (next.has(db)) next.delete(db);
    else next.add(db);
    setCfg.mutate({ databases: [...next], ...(enabled ? { enabled: true } : {}) });
  };

  // Counts + the actually-monitored set come from the traffic snapshot when
  // available, so the buffered count and the table rows share one source;
  // fall back to the monitor-config snapshot before the first traffic fetch.
  const st = traffic.data?.status;
  const monitoring = st?.databases ?? cfg.data?.monitoring ?? [];
  const buffered = st?.buffered ?? cfg.data?.buffered ?? 0;
  const dropped = st?.dropped ?? cfg.data?.dropped ?? 0;

  return (
    <>
      <div className="card">
        <h3>流量监听 (MongoDB)</h3>
        <div className="toggle-row">
          <div>
            <div className="toggle-label">启用监听</div>
            <div className="toggle-desc">
              对选中的数据库逐库开启 Profiler(level 2),捕获每一次操作。会增加数据库负载,适合短时段调试,用完请关闭。
              {!enabled && !canEnable && <strong>(先在下方勾选要监听的数据库)</strong>}
            </div>
          </div>
          <label className={`switch ${enabled ? 'on' : ''} ${!enabled && !canEnable ? 'disabled' : ''}`}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={setCfg.isPending || cfg.isPending || (!enabled && !canEnable)}
              onChange={() => setCfg.mutate({ enabled: !enabled })}
            />
            <span className="slider" />
          </label>
        </div>

        <QueryState query={cfg}>
          {() =>
            allDbs.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>
                未发现可监听的用户数据库(应用尚未创建任何库)。
              </div>
            ) : (
              <>
                <p className="meta" style={{ margin: '4px 0 8px' }}>选择要监听的数据库:</p>
                {allDbs.map((db) => {
                  const unavailable = !available.includes(db);
                  return (
                    <label key={db} className="radio-row" style={{ cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={selected.has(db)}
                        disabled={setCfg.isPending}
                        onChange={() => toggleDb(db)}
                      />
                      <span>
                        <code>{db}</code>
                        {unavailable && <span className="meta"> (未发现,已保留选择)</span>}
                      </span>
                    </label>
                  );
                })}
              </>
            )
          }
        </QueryState>

        {cfg.data && (
          <p className="meta" style={{ marginTop: 10 }}>
            {enabled
              ? `正在监听:${monitoring.join('、') || '—'} · 已缓冲 ${buffered} 条` +
                (dropped > 0 ? `(已丢弃最旧 ${dropped} 条)` : '')
              : buffered > 0
                ? `监听已暂停 · 仍保留 ${buffered} 条历史(销毁环境前可继续查看)。`
                : '监听已关闭。'}
          </p>
        )}
      </div>

      <div className="card">
        <h3>实时流量</h3>
        <QueryState query={traffic}>
          {(t) =>
            t.entries.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>
                {enabled
                  ? '尚未捕获到操作(在应用里触发一些读写后会出现在这里)。'
                  : '启用监听后,这里显示捕获到的 MongoDB 操作。'}
              </div>
            ) : (
              <>
                {!enabled && (
                  <p className="meta" style={{ margin: '0 0 8px' }}>
                    监听已暂停 — 显示最近捕获的 {t.entries.length} 条。
                  </p>
                )}
                <table>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>op</th>
                      <th>集合</th>
                      <th>耗时</th>
                      <th>返回</th>
                      <th>命令</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.entries.map((e) => (
                      <tr key={`${e.db}:${e.id}`}>
                        <td className="meta">{fmtTime(e.ts)}</td>
                        <td><code>{e.op}</code></td>
                        <td><code>{e.db === e.collection ? e.ns : `${e.db}.${e.collection}`}</code></td>
                        <td>{e.durationMs}ms</td>
                        <td>{e.nreturned ?? '—'}</td>
                        <td>
                          <code style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>{e.command}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          }
        </QueryState>
      </div>
    </>
  );
}

function ContainerCard({ title, handle }: { title: string; handle: ContainerHandle | null }) {
  if (!handle) {
    return (
      <div className="card">
        <h3>{title}</h3>
        <div className="empty" style={{ padding: '20px' }}>未启动</div>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <dl className="dl">
        <dt>镜像</dt>
        <dd><code>{handle.image}</code></dd>
        <dt>containerId</dt>
        <dd><code>{handle.containerId.slice(0, 16)}</code></dd>
        <dt>端口</dt>
        <dd><code>{handle.hostPort}</code> → <code>{handle.internalPort}</code></dd>
      </dl>
    </div>
  );
}
