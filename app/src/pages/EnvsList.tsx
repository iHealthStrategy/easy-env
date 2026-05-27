import { useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useEnvs, useEnvDown } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import { envStatusLabel, fmtRelative, fmtTime, shortId } from '../components/format';

export function EnvsList() {
  const envs = useEnvs();
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="page-header">
        <h2>环境</h2>
      </div>
      <div className="page-body">

      <QueryState
        query={envs}
        empty={(d) => d.envs.length === 0}
        emptyMessage={
          <>
            暂无环境。环境由 AI 通过 MCP 的 <code>env.up</code> 创建。
            {' '}不知道怎么开始?<Link to="/help">查看使用帮助 →</Link>
          </>
        }
      >
        {(data) => (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>envId</th>
                  <th>项目</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {data.envs.map((e) => {
                  const isActive = e.envId === data.activeEnvId;
                  return (
                    <tr
                      key={e.envId}
                      className="row-link"
                      onClick={() => navigate(`/envs/${e.envId}`)}
                    >
                      <td>
                        <code>{shortId(e.envId, 16)}</code>{' '}
                        {isActive && <span className="badge active">活跃</span>}
                      </td>
                      <td>{e.projectName ? <code>{e.projectName}</code> : <span className="meta">—</span>}</td>
                      <td>
                        <span className={`badge ${e.status}`}>{envStatusLabel(e.status)}</span>
                        {e.status === 'starting' && e.pullingImage && (
                          <span className="pulling-tag" title={`正在下载镜像 ${e.pullingImage}`}>
                            ⬇ 拉取 <code>{e.pullingImage}</code>
                          </span>
                        )}
                      </td>
                      <td title={fmtTime(e.createdAt)}>{fmtRelative(e.createdAt)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <DeleteEnvButton envId={e.envId} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryState>
      </div>
    </div>
  );
}

// Per-row teardown: stop the env's containers and drop it from the registry.
// Two-step confirm inline so a stray click can't nuke an env, and
// stopPropagation everywhere so neither step triggers the row's navigation.
function DeleteEnvButton({ envId }: { envId: string }) {
  const [confirming, setConfirming] = useState(false);
  const down = useEnvDown();
  const stop = (e: MouseEvent) => e.stopPropagation();

  if (!confirming) {
    return (
      <button
        className="btn-ghost-danger"
        title="销毁该环境:停止容器并从注册表移除"
        onClick={(e) => {
          stop(e);
          setConfirming(true);
        }}
      >
        清除
      </button>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }} onClick={stop}>
      <span className="meta">销毁?</span>
      <button
        className="btn-danger"
        disabled={down.isPending}
        onClick={(e) => {
          stop(e);
          down.mutate(envId, { onSuccess: () => setConfirming(false) });
        }}
      >
        {down.isPending ? '销毁中…' : '确认'}
      </button>
      <button
        disabled={down.isPending}
        onClick={(e) => {
          stop(e);
          setConfirming(false);
        }}
      >
        取消
      </button>
    </span>
  );
}
