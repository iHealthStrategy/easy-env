import { Link, useParams } from 'react-router-dom';
import { useEnv } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { envStatusLabel, fmtTime } from '../components/format';
import type { ContainerHandle } from '../api/types';

export function EnvDetail() {
  const { envId = '' } = useParams();
  const query = useEnv(envId);

  return (
    <>
      <div className="page-header">
        <h2>
          <Link to="/">环境</Link> / <code>{envId}</code>
        </h2>
      </div>

      <QueryState query={query}>
        {(env) => (
          <>
            <div className="card">
              <h3>Status</h3>
              <dl className="dl">
                <dt>Status</dt>
                <dd><span className={`badge ${env.status}`}>{env.status}</span></dd>
                <dt>Created</dt>
                <dd>{fmtTime(env.createdAt)}</dd>
                <dt>Mongo reachable</dt>
                <dd>{env.health.mongoReachable ? 'yes' : 'no'}</dd>
                <dt>Redis reachable</dt>
                <dd>{env.health.redisReachable ? 'yes' : 'no'}</dd>
                {env.error && (
                  <>
                    <dt>Error</dt>
                    <dd><code>{env.error}</code></dd>
                  </>
                )}
              </dl>
            </div>

            <div className="card">
              <h3>解析后的 URL</h3>
              <dl className="dl">
                {env.resolved.mongoUrl && (
                  <>
                    <dt>mongoUrl</dt>
                    <dd><code>{env.resolved.mongoUrl}</code></dd>
                  </>
                )}
                {env.resolved.redisUrl && (
                  <>
                    <dt>redisUrl</dt>
                    <dd><code>{env.resolved.redisUrl}</code></dd>
                  </>
                )}
                <dt>dbName</dt>
                <dd><code>{env.resolved.dbName}</code></dd>
                {env.resolved.baseUrl && (
                  <>
                    <dt>baseUrl</dt>
                    <dd><code>{env.resolved.baseUrl}</code></dd>
                  </>
                )}
              </dl>
            </div>

            <ContainerCard title="Mongo" handle={env.containers.mongo} />
            <ContainerCard title="Redis" handle={env.containers.redis} />

            {Object.keys(env.labels).length > 0 && (
              <div className="card">
                <h3>Labels</h3>
                <dl className="dl">
                  {Object.entries(env.labels).map(([k, v]) => (
                    <span key={k} style={{ display: 'contents' }}>
                      <dt>{k}</dt>
                      <dd><code>{v}</code></dd>
                    </span>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}

function ContainerCard({ title, handle }: { title: string; handle: ContainerHandle | null }) {
  if (!handle) {
    return (
      <div className="card">
        <h3>{title}</h3>
        <div className="empty" style={{ padding: '20px' }}>未启动</div>
      </div>
    );
  }
  return (
    <div className="card">
      <h3>{title}</h3>
      <dl className="dl">
        <dt>镜像</dt>
        <dd><code>{handle.image}</code></dd>
        <dt>containerId</dt>
        <dd><code>{handle.containerId.slice(0, 16)}</code></dd>
        <dt>端口</dt>
        <dd><code>{handle.hostPort}</code> → <code>{handle.internalPort}</code></dd>
      </dl>
    </div>
  );
}
