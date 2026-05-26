import { useEffect, useState } from 'react';
import {
  useDeclareVars,
  useDeleteProject,
  useProjects,
  useSetVar,
  useUnsetVar,
  useVars,
} from '../api/hooks';
import { QueryState } from '../components/QueryState';
import type { ContainersHandle, VarEntry, VarsDeclareItem, VarValue } from '../api/types';

// Persisted UI state: the SLUG (ProjectSummary.key) of the project the
// user last picked. Persisting the human name would be ambiguous now
// that two worktrees can share it.
const LS_KEY = 'easy-env.web.selected-project-key';

export function Variables() {
  const projectsQuery = useProjects();
  const [selected, setSelected] = useState<string | null>(
    () => (typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null),
  );

  // Auto-select the first project once they load (or honour the persisted choice).
  useEffect(() => {
    const list = projectsQuery.data?.projects ?? [];
    if (list.length === 0) return;
    const persisted = selected && list.find((p) => p.key === selected) ? selected : null;
    const next = persisted ?? list[0].key;
    if (next !== selected) setSelected(next);
  }, [projectsQuery.data, selected]);

  // Persist user selection.
  useEffect(() => {
    if (selected) localStorage.setItem(LS_KEY, selected);
  }, [selected]);

  const project = projectsQuery.data?.projects.find((p) => p.key === selected) ?? null;

  return (
    <>
      <div className="page-header">
        <h2>变量</h2>
        <span className="meta">
          {projectsQuery.data?.projects.length === 0
            ? '暂无已注册项目'
            : project
              ? <>项目:<code>{project.name}</code> · <code>{project.projectRoot}</code></>
              : <>—</>
          }
        </span>
      </div>

      <QueryState query={projectsQuery}>
        {(data) => {
          if (data.projects.length === 0) {
            return (
              <div className="card">
                <div className="empty" style={{ padding: 20, lineHeight: 1.6 }}>
                  暂无已注册的项目。请在含有 <code>easy-env.json</code> 的项目中,
                  通过 AI session 调用 <code>env.init</code> 完成注册。
                  守护进程从不读取项目目录 —— 每个项目都由 AI 提交的信息标识。
                </div>
              </div>
            );
          }
          return (
            <>
              <div className="card">
                <h3>项目</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={selected ?? ''}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {data.projects.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name} — {p.projectRoot}({p.variableCount} 个变量)
                      </option>
                    ))}
                  </select>
                  {project && (
                    <DeleteProjectButton
                      projectKey={project.key}
                      projectName={project.name}
                      projectRoot={project.projectRoot}
                      onDeleted={() => setSelected(null)}
                    />
                  )}
                </div>
              </div>

              {project && (
                <ProjectVariables
                  projectKey={project.key}
                  projectName={project.name}
                  projectRoot={project.projectRoot}
                />
              )}
            </>
          );
        }}
      </QueryState>
    </>
  );
}

function ProjectVariables({
  projectKey,
  projectName,
  projectRoot,
}: {
  projectKey: string;
  projectName: string;
  projectRoot: string;
}) {
  const query = useVars(projectKey);
  const [declareOpen, setDeclareOpen] = useState(false);

  return (
    <>
      <QueryState query={query}>
        {(data) => {
          const entries = Object.entries(data.variables).sort(([a], [b]) => a.localeCompare(b));
          return (
            <>
              <div className="card">
                <h3>操作</h3>
                <button onClick={() => setDeclareOpen(true)}>声明变量…</button>
                <div style={{ marginTop: 10, color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
                  本项目环境变量的权威声明方是 AI(通过 MCP)——
                  它会读取 <code>easy-env.json</code> /
                  <code> docker-compose</code> / 源代码 / README,
                  调用 <code>vars.declare</code> 提交。本对话框用于临时手动添加。
                </div>
              </div>

              <ContainersCard containers={data.containers} />

              <div className="card">
                <h3>变量</h3>
                {entries.length === 0 ? (
                  <div className="empty" style={{ padding: 20 }}>
                    暂无声明的变量。可点击「声明变量」,或让 AI 运行 vars.declare。
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 240 }}>名称</th>
                        <th>值</th>
                        <th style={{ width: 120 }}>来源</th>
                        <th style={{ width: 140 }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(([name, entry]) => (
                        <VarRow
                          key={name}
                          name={name}
                          entry={entry}
                          projectKey={projectKey}
                        />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          );
        }}
      </QueryState>

      {declareOpen && (
        <DeclareModal
          projectKey={projectKey}
          projectName={projectName}
          projectRoot={projectRoot}
          onClose={() => setDeclareOpen(false)}
        />
      )}
    </>
  );
}

function VarRow({
  name,
  entry,
  projectKey,
}: {
  name: string;
  entry: VarEntry;
  projectKey: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatForEdit(entry.value));
  const setVar = useSetVar(projectKey);
  const unsetVar = useUnsetVar(projectKey);

  const handleSave = () => {
    setVar.mutate(
      { name, value: parseValue(draft) },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <tr>
      <td><code>{name}</code></td>
      <td>
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') setEditing(false);
            }}
            autoFocus
            style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 4, fontFamily: 'inherit', fontSize: 12 }}
          />
        ) : entry.source === 'unset' ? (
          <span style={{ color: 'var(--fg-dim)', fontStyle: 'italic' }}>未设置</span>
        ) : (
          <code>{String(entry.value)}</code>
        )}
      </td>
      <td><span className={`badge ${badgeClassFor(entry.source)}`}>{sourceLabel(entry.source)}</span></td>
      <td>
        {editing ? (
          <>
            <button onClick={handleSave} disabled={setVar.isPending}>保存</button>{' '}
            <button onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            <button onClick={() => { setDraft(formatForEdit(entry.value)); setEditing(true); }}>
              {entry.source === 'unset' ? '设置' : '编辑'}
            </button>{' '}
            {entry.source === 'user' && (
              <button onClick={() => unsetVar.mutate(name)} disabled={unsetVar.isPending}>清除</button>
            )}
          </>
        )}
        {setVar.isError && editing && (
          <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>
            {(setVar.error as Error).message}
          </div>
        )}
      </td>
    </tr>
  );
}

function ContainersCard({ containers }: { containers: ContainersHandle | null }) {
  if (!containers) {
    return (
      <div className="card">
        <h3>活跃环境容器</h3>
        <div className="empty" style={{ padding: 14, fontSize: 12, color: 'var(--fg-dim)' }}>
          当前没有活跃环境。请运行 <code>env.up</code> 启动 mongo / redis / rabbit 容器。
        </div>
      </div>
    );
  }
  const rows: Array<[string, string | number | undefined]> = [
    ['envId', containers.envId],
    ['mongoUrl', containers.mongoUrl],
    ['redisUrl', containers.redisUrl],
    ['rabbitUrl', containers.rabbitUrl],
    ['rabbitManagementUrl', containers.rabbitManagementUrl],
    ['dbName', containers.dbName],
    ['mongoHostPort', containers.mongoHostPort],
    ['redisHostPort', containers.redisHostPort],
    ['rabbitHostPort', containers.rabbitHostPort],
  ];
  return (
    <div className="card">
      <h3>活跃环境容器</h3>
      <div style={{ marginBottom: 8, color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
        把这些值通过 <code>vars.set</code> 填到项目实际使用的变量名里。例如:
        <code>MONGO_BG = `${'$'}{containers.mongoUrl}/bg`</code> 或{' '}
        <code>REDIS_PORT = ${'$'}{'{'}containers.redisHostPort{'}'}</code>。
      </div>
      <table>
        <tbody>
          {rows.filter(([, v]) => v !== undefined).map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: 160 }}><code>{k}</code></td>
              <td><code>{String(v)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeclareModal({
  projectKey,
  projectName,
  projectRoot,
  onClose,
}: {
  projectKey: string;
  projectName: string;
  projectRoot: string;
  onClose: () => void;
}) {
  const declare = useDeclareVars(projectKey, projectName, projectRoot);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [evidence, setEvidence] = useState('');

  const submit = () => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return;
    const item: VarsDeclareItem = { name, evidence: evidence || undefined };
    if (value) item.value = value;
    declare.mutate({ items: [item] }, { onSuccess: () => setTimeout(onClose, 600) });
  };

  const nameValid = !!name && /^[A-Z_][A-Z0-9_]*$/.test(name);

  return (
    <Modal onClose={onClose} title="声明一个变量">
      <div style={{ marginBottom: 12, color: 'var(--fg-dim)', fontSize: 12 }}>
        将该名称添加到守护进程侧的清单;如果填了值,会写入该项目的存储(已有值不会被覆盖)。
      </div>

      <Field label="名称(UPPER_SNAKE_CASE)">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="JWT_SECRET"
          autoFocus
          style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 4, fontFamily: 'inherit' }}
        />
        {name && !nameValid && (
          <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>
            必须匹配 /^[A-Z_][A-Z0-9_]*$/
          </div>
        )}
      </Field>

      <Field label="初始值(可选)">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 4, fontFamily: 'inherit' }}
        />
      </Field>

      <Field label="证据出处(可选)">
        <input
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          placeholder="docker-compose.local.yml#api.environment"
          style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 4, fontFamily: 'inherit' }}
        />
      </Field>

      {declare.isError && (
        <div className="error-banner">{(declare.error as Error).message}</div>
      )}
      {declare.isSuccess && (
        <div style={{ color: 'var(--green)', marginBottom: 12 }}>
          ✓ 已声明 {declare.data?.results[0]?.name}({declare.data?.results[0]?.declared})。
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose}>取消</button>
        <button
          onClick={submit}
          disabled={!nameValid || declare.isPending}
          style={{ background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
        >
          声明
        </button>
      </div>
    </Modal>
  );
}

function Modal({ children, title, onClose }: { children: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 24, maxWidth: 760, width: '90%', maxHeight: '80vh', overflow: 'auto',
        }}
      >
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function badgeClassFor(source: VarEntry['source']): string {
  switch (source) {
    case 'user': return 'ready';
    case 'unset': return 'starting';
  }
}

function sourceLabel(source: VarEntry['source']): string {
  return { user: '用户', unset: '未设置' }[source];
}

function formatForEdit(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return String(v);
}

function parseValue(input: string): VarValue {
  const trimmed = input.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return input;
}

function DeleteProjectButton({
  projectKey,
  projectName,
  projectRoot,
  onDeleted,
}: {
  projectKey: string;
  projectName: string;
  projectRoot: string;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const deleteProject = useDeleteProject();

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        style={{ marginLeft: 'auto', color: 'var(--red, #c33)', borderColor: 'var(--red, #c33)' }}
        title={`删除 ~/.easy-env/projects/${projectKey}/(清单 + 值)。源码树里的 easy-env.json 不变。`}
      >
        删除项目…
      </button>
    );
  }

  return (
    <div
      style={{
        marginLeft: 'auto',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        fontSize: 12,
      }}
    >
      <span style={{ color: 'var(--fg-dim)' }}>
        删除 <code>{projectName}</code>?
        <span style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
          会移除 <code>~/.easy-env/projects/{projectKey}/</code> 下的清单和所有变量值。
          位于 <code>{projectRoot}</code> 的源码树 <code>easy-env.json</code> 不会被动。
        </span>
      </span>
      <button
        onClick={() =>
          deleteProject.mutate(projectKey, {
            onSuccess: () => {
              setConfirming(false);
              onDeleted();
            },
          })
        }
        disabled={deleteProject.isPending}
        style={{ background: 'var(--red, #c33)', color: 'white', borderColor: 'var(--red, #c33)' }}
      >
        {deleteProject.isPending ? '删除中…' : '确认删除'}
      </button>
      <button onClick={() => setConfirming(false)} disabled={deleteProject.isPending}>
        取消
      </button>
      {deleteProject.isError && (
        <div style={{ color: 'var(--red, #c33)', fontSize: 11 }}>
          {(deleteProject.error as Error).message}
        </div>
      )}
    </div>
  );
}
