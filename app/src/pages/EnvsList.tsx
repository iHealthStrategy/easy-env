import { useNavigate } from 'react-router-dom';
import { useEnvs, useHealth } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { envStatusLabel, fmtRelative, fmtTime, shortId } from '../components/format';

export function EnvsList() {
  const envs = useEnvs();
  const health = useHealth();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>环境</h2>
        <span className="meta">
          {health.data ? (
            <>守护进程 v{health.data.version} · 已运行 {Math.floor(health.data.uptimeMs / 1000)}s</>
          ) : (
            <>守护进程离线</>
          )}
        </span>
      </div>

      <QueryState
        query={envs}
        empty={(d) => d.envs.length === 0}
        emptyMessage="暂无环境。请在 MCP 客户端中运行 `env.up` 创建一个。"
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>envId</th>
                  <th>项目</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th>Mongo</th>
                  <th>Redis</th>
                  <th>Rabbit</th>
                </tr>
              </thead>
              <tbody>
                {data.envs.map((e) => {
                  const isActive = e.envId === data.activeEnvId;
                  return (
                    <tr
                      key={e.envId}
                      className="row-link"
                      onClick={() => navigate(`/envs/${e.envId}`)}
                    >
                      <td>
                        <code>{shortId(e.envId, 16)}</code>{' '}
                        {isActive && <span className="badge active">活跃</span>}
                      </td>
                      <td>{e.projectName ? <code>{e.projectName}</code> : <span className="meta">—</span>}</td>
                      <td>
                        <span className={`badge ${e.status}`}>{envStatusLabel(e.status)}</span>
                      </td>
                      <td title={fmtTime(e.createdAt)}>{fmtRelative(e.createdAt)}</td>
                      <td><code>{e.images.mongo ?? '—'}</code></td>
                      <td><code>{e.images.redis ?? '—'}</code></td>
                      <td><code>{e.images.rabbit ?? '—'}</code></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </>
  );
}
