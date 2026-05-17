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
          <Link to="/snapshots">Snapshots</Link> / <code>{id}</code>
        </h2>
      </div>

      <QueryState query={query}>
        {(snap) => {
          const mongoCollections = Object.keys(snap.mongo);
          const redisKeys = Object.keys(snap.redis);
          return (
            <>
              <div className="card">
                <h3>Meta</h3>
                <dl className="dl">
                  <dt>takenAt</dt>
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
                  <dt>Redis keys</dt>
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
