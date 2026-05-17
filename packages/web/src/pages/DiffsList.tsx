import { useNavigate } from 'react-router-dom';
import { useDiffs } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtBytes, fmtRelative, fmtTime } from '../components/format';

export function DiffsList() {
  const query = useDiffs();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-header">
        <h2>Diffs</h2>
        <span className="meta">diff.compare artifacts</span>
      </div>

      <QueryState
        query={query}
        empty={(d) => d.diffs.length === 0}
        emptyMessage="No diffs yet. Use the diff.compare MCP tool after two state.capture calls."
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>diffId</th>
                  <th>After taken</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {data.diffs.map((d) => (
                  <tr key={d.id} className="row-link" onClick={() => navigate(`/diffs/${d.id}`)}>
                    <td><code>{d.id}</code></td>
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
