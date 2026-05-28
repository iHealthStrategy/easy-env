import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEnv, useEnvDown } from '../api/hooks';
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
        <DestroyEnvButton envId={envId} />
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
                <dd>
                  <span className={`badge ${env.status}`}>{envStatusLabel(env.status)}</span>
                  {env.status === 'starting' && env.pullingImage && (
                    <span className="pulling-tag" title={`正在下载镜像 ${env.pullingImage}`}>
                      ⬇ 正在下载 <code>{env.pullingImage}</code>(首次较慢)
                    </span>
                  )}
                </dd>
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
                {env.containers.clickhouse && (
                  <>
                    <dt>ClickHouse 可达</dt>
                    <dd>{env.health.clickhouseReachable ? '是' : '否'}</dd>
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
                {env.resolved.clickhouseUrl && (
                  <>
                    <dt>clickhouseUrl</dt>
                    <dd><code>{env.resolved.clickhouseUrl}</code></dd>
                  </>
                )}
                {env.resolved.clickhouseDbName && (
                  <>
                    <dt>clickhouseDbName</dt>
                    <dd><code>{env.resolved.clickhouseDbName}</code></dd>
                  </>
                )}
                {env.resolved.clickhouseCluster && (
                  <>
                    <dt>clickhouseCluster</dt>
                    <dd><code>{env.resolved.clickhouseCluster}</code> <span className="meta">(Keeper + 单节点集群)</span></dd>
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
            <ContainerCard title="ClickHouse" handle={env.containers.clickhouse} />

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

// Teardown from the detail view (mirrors the list's row button). Two-step
// confirm, then navigate back to the list once the env is destroyed.
function DestroyEnvButton({ envId }: { envId: string }) {
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();
  const down = useEnvDown();

  if (!confirming) {
    return (
      <button className="btn-ghost-danger" onClick={() => setConfirming(true)}>
        销毁环境
      </button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <span className="meta">停止容器并移除?</span>
      <button
        className="btn-danger"
        disabled={down.isPending}
        onClick={() => down.mutate(envId, { onSuccess: () => navigate('/') })}
      >
        {down.isPending ? '销毁中…' : '确认销毁'}
      </button>
      <button disabled={down.isPending} onClick={() => setConfirming(false)}>
        取消
      </button>
    </span>
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
