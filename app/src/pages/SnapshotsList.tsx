import { Link, useNavigate } from 'react-router-dom';
import { useSnapshots } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtBytes, fmtRelative, fmtTime, shortId } from '../components/format';

export function SnapshotsList() {
  const query = useSnapshots();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>快照</h2>
        <span className="meta">state.capture 产物</span>
      </div>

      <QueryState
        query={query}
        empty={(d) => d.snapshots.length === 0}
        emptyMessage="暂无快照。使用 state.capture MCP 工具创建一个。"
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>snapshotId</th>
                  <th>项目</th>
                  <th>环境</th>
                  <th>拍摄时间</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {data.snapshots.map((s) => (
                  <tr
                    key={s.id}
                    className="row-link"
                    onClick={() => navigate(`/snapshots/${s.id}`)}
                  >
                    <td><code>{s.id}</code></td>
                    <td>
                      {s.projectName
                        ? <code>{s.projectName}</code>
                        : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {s.envId
                        ? <Link to={`/envs/${s.envId}`}><code>{shortId(s.envId, 14)}</code></Link>
                        : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
                    </td>
                    <td title={fmtTime(s.takenAt)}>{fmtRelative(s.takenAt)}</td>
                    <td>{fmtBytes(s.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
    </>
  );
}
