import { Link, useParams } from 'react-router-dom';
import { useEnv } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { envStatusLabel, fmtTime } from '../components/format';
import type { ContainerHandle } from '../api/types';

export function EnvDetail() {
  const { envId = '' } = useParams();
  const query = useEnv(envId);

  return (
    <div className="page">
      <div className="page-header">
        <h2>
          <Link to="/">环境</Link> / <code>{envId}</code>
        </h2>
      </div>
      <div className="page-body">

      <QueryState query={query}>
        {(env) => (
          <>
            <div className="card">
              <h3>状态</h3>
              <dl className="dl">
                <dt>项目</dt>
                <dd>{env.projectName ? <code>{env.projectName}</code> : <span className="meta">—</span>}</dd>
                <dt>状态</dt>
                <dd><span className={`badge ${env.status}`}>{envStatusLabel(env.status)}</span></dd>
                <dt>创建时间</dt>
                <dd>{fmtTime(env.createdAt)}</dd>
                <dt>Mongo 可达</dt>
                <dd>{env.health.mongoReachable ? '是' : '否'}</dd>
                <dt>Redis 可达</dt>
                <dd>{env.health.redisReachable ? '是' : '否'}</dd>
                {env.containers.rabbit && (
                  <>
                    <dt>Rabbit 可达</dt>
                    <dd>{env.health.rabbitReachable ? '是' : '否'}</dd>
                  </>
                )}
                {env.error && (
                  <>
                    <dt>错误</dt>
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
                {env.resolved.rabbitUrl && (
                  <>
                    <dt>rabbitUrl</dt>
                    <dd><code>{env.resolved.rabbitUrl}</code></dd>
                  </>
                )}
                {env.resolved.rabbitManagementUrl && (
                  <>
                    <dt>rabbitManagementUrl</dt>
                    <dd><a href={env.resolved.rabbitManagementUrl} target="_blank" rel="noreferrer"><code>{env.resolved.rabbitManagementUrl}</code></a></dd>
                  </>
                )}
                {env.resolved.dbName && (
                  <>
                    <dt>dbName</dt>
                    <dd><code>{env.resolved.dbName}</code></dd>
                  </>
                )}
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
            <ContainerCard title="Rabbit" handle={env.containers.rabbit} />

            {Object.keys(env.labels).length > 0 && (
              <div className="card">
                <h3>标签</h3>
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
      </div>
    </div>
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
