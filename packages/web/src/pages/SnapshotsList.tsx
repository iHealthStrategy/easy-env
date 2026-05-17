import { useNavigate } from 'react-router-dom';
import { useSnapshots } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtBytes, fmtRelative, fmtTime } from '../components/format';

export function SnapshotsList() {
  const query = useSnapshots();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>Snapshots</h2>
        <span className="meta">state.capture artifacts</span>
      </div>

      <QueryState
        query={query}
        empty={(d) => d.snapshots.length === 0}
        emptyMessage="No snapshots yet. Use the state.capture MCP tool to create one."
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>snapshotId</th>
                  <th>Taken</th>
                  <th>Size</th>
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
