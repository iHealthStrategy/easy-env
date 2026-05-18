import { Link, useParams } from 'react-router-dom';
import { useSnapshot } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { fmtTime } from '../components/format';

export function SnapshotDetail() {
  const { id = '' } = useParams();
  const query = useSnapshot(id);

  return (
    <>
      <div className="page-header">
        <h2>
          <Link to="/snapshots">快照</Link> / <code>{id}</code>
        </h2>
      </div>

      <QueryState query={query}>
        {(snap) => {
          const mongoCollections = Object.keys(snap.mongo);
          const redisKeys = Object.keys(snap.redis);
          return (
            <>
              <div className="card">
                <h3>元信息</h3>
                <dl className="dl">
                  <dt>项目</dt>
                  <dd>
                    {snap.projectName
                      ? <code>{snap.projectName}</code>
                      : <span style={{ color: 'var(--fg-dim)' }}>未关联</span>}
                  </dd>
                  <dt>环境</dt>
                  <dd>
                    {snap.envId
                      ? <Link to={`/envs/${snap.envId}`}><code>{snap.envId}</code></Link>
                      : <span style={{ color: 'var(--fg-dim)' }}>未关联</span>}
                  </dd>
                  <dt>拍摄时间</dt>
                  <dd>{fmtTime(snap.takenAt)}</dd>
                  <dt>Mongo collections</dt>
                  <dd>
                    {mongoCollections.length === 0
                      ? '—'
                      : mongoCollections.map((c) => (
                          <code key={c} style={{ marginRight: 8 }}>
                            {c} ({snap.mongo[c].length})
                          </code>
                        ))}
                  </dd>
                  <dt>Redis keys 数</dt>
                  <dd>{redisKeys.length}</dd>
                </dl>
              </div>

              {mongoCollections.length > 0 && (
                <div className="card">
                  <h3>Mongo</h3>
                  <pre className="json">{JSON.stringify(snap.mongo, null, 2)}</pre>
                </div>
              )}

              {redisKeys.length > 0 && (
                <div className="card">
                  <h3>Redis</h3>
                  <pre className="json">{JSON.stringify(snap.redis, null, 2)}</pre>
                </div>
              )}
            </>
          );
        }}
      </QueryState>
    </>
  );
}
