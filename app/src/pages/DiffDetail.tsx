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
          <Link to="/diffs">差异</Link> / <code>{id}</code>
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
                <h3>元信息</h3>
                <dl className="dl">
                  <dt>项目</dt>
                  <dd>
                    {diff.projectName
                      ? <code>{diff.projectName}</code>
                      : <span style={{ color: 'var(--fg-dim)' }}>未关联</span>}
                  </dd>
                  <dt>环境</dt>
                  <dd>
                    {diff.envId
                      ? <Link to={`/envs/${diff.envId}`}><code>{diff.envId}</code></Link>
                      : <span style={{ color: 'var(--fg-dim)' }}>未关联</span>}
                  </dd>
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
                  <div className="empty" style={{ padding: 20 }}>无 Mongo 差异</div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Collection</th>
                        <th>新增</th>
                        <th>删除</th>
                        <th>修改</th>
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
                  <dt>新增</dt><dd>{redisAdded}</dd>
                  <dt>删除</dt><dd>{redisRemoved}</dd>
                  <dt>修改</dt><dd>{redisModified}</dd>
                </dl>
              </div>

              <div className="card">
                <h3>完整 JSON</h3>
                <pre className="json">{JSON.stringify(diff, null, 2)}</pre>
              </div>
            </>
          );
        }}
      </QueryState>
    </>
  );
}
