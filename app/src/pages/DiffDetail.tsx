import { Link, useParams } from 'react-router-dom';
import { useDiff } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtTime } from '../components/format';

export function DiffDetail() {
  const { id = '' } = useParams();
  const query = useDiff(id);

  return (
    <>
      <div className="page-header">
        <h2>
          <Link to="/diffs">Diffs</Link> / <code>{id}</code>
        </h2>
      </div>

      <QueryState query={query}>
        {(diff) => {
          const mongoCounts = Object.entries(diff.mongo).map(([col, d]) => ({
            col,
            added: d.added.length,
            removed: d.removed.length,
            modified: d.modified.length,
          }));
          const redisAdded = Object.keys(diff.redis.added).length;
          const redisRemoved = Object.keys(diff.redis.removed).length;
          const redisModified = Object.keys(diff.redis.modified).length;
          return (
            <>
              <div className="card">
                <h3>Meta</h3>
                <dl className="dl">
                  <dt>before</dt>
                  <dd>
                    <Link to={`/snapshots/${diff.beforeSnapshotId}`}>
                      <code>{diff.beforeSnapshotId}</code>
                    </Link>{' '}
                    @ {fmtTime(diff.beforeTakenAt)}
                  </dd>
                  <dt>after</dt>
                  <dd>
                    <Link to={`/snapshots/${diff.afterSnapshotId}`}>
                      <code>{diff.afterSnapshotId}</code>
                    </Link>{' '}
                    @ {fmtTime(diff.afterTakenAt)}
                  </dd>
                </dl>
              </div>

              <div className="card">
                <h3>Mongo</h3>
                {mongoCounts.length === 0 ? (
                  <div className="empty" style={{ padding: 20 }}>no mongo diff</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Collection</th>
                        <th>Added</th>
                        <th>Removed</th>
                        <th>Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mongoCounts.map((c) => (
                        <tr key={c.col}>
                          <td><code>{c.col}</code></td>
                          <td>{c.added}</td>
                          <td>{c.removed}</td>
                          <td>{c.modified}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="card">
                <h3>Redis</h3>
                <dl className="dl">
                  <dt>added</dt><dd>{redisAdded}</dd>
                  <dt>removed</dt><dd>{redisRemoved}</dd>
                  <dt>modified</dt><dd>{redisModified}</dd>
                </dl>
              </div>

              <div className="card">
                <h3>Full JSON</h3>
                <pre className="json">{JSON.stringify(diff, null, 2)}</pre>
              </div>
            </>
          );
        }}
      </QueryState>
    </>
  );
}
