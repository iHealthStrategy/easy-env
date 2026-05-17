import { useNavigate } from 'react-router-dom';
import { useEnvs, useHealth } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtRelative, fmtTime, shortId } from '../components/format';

export function EnvsList() {
  const envs = useEnvs();
  const health = useHealth();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>Environments</h2>
        <span className="meta">
          {health.data ? (
            <>daemon v{health.data.version} · up {Math.floor(health.data.uptimeMs / 1000)}s</>
          ) : (
            <>daemon offline</>
          )}
        </span>
      </div>

      <QueryState
        query={envs}
        empty={(d) => d.envs.length === 0}
        emptyMessage="No environments yet. Run `env.up` from your MCP client to create one."
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>envId</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Mongo</th>
                  <th>Redis</th>
                  <th>DB</th>
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
                        {isActive && <span className="badge active">active</span>}
                      </td>
                      <td>
                        <span className={`badge ${e.status}`}>{e.status}</span>
                      </td>
                      <td title={fmtTime(e.createdAt)}>{fmtRelative(e.createdAt)}</td>
                      <td><code>{e.images.mongo ?? '—'}</code></td>
                      <td><code>{e.images.redis ?? '—'}</code></td>
                      <td><code>{e.resolved.dbName}</code></td>
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
