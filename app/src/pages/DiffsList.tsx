import { Link, useNavigate } from 'react-router-dom';
import { useDiffs } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtBytes, fmtRelative, fmtTime, shortId } from '../components/format';

export function DiffsList() {
  const query = useDiffs();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>差异</h2>
        <span className="meta">diff.compare 产物</span>
      </div>

      <QueryState
        query={query}
        empty={(d) => d.diffs.length === 0}
        emptyMessage="暂无差异。先用 state.capture 拍两次快照,再调用 diff.compare。"
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>diffId</th>
                  <th>项目</th>
                  <th>环境</th>
                  <th>after 拍摄时间</th>
                  <th>大小</th>
                </tr>
              </thead>
              <tbody>
                {data.diffs.map((d) => (
                  <tr key={d.id} className="row-link" onClick={() => navigate(`/diffs/${d.id}`)}>
                    <td><code>{d.id}</code></td>
                    <td>
                      {d.projectName
                        ? <code>{d.projectName}</code>
                        : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {d.envId
                        ? <Link to={`/envs/${d.envId}`}><code>{shortId(d.envId, 14)}</code></Link>
                        : <span style={{ color: 'var(--fg-dim)' }}>—</span>}
                    </td>
                    <td title={fmtTime(d.takenAt)}>{fmtRelative(d.takenAt)}</td>
                    <td>{fmtBytes(d.sizeBytes)}</td>
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
