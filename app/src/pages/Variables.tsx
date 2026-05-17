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

const LS_KEY = 'easy-env.web.selected-project';

export function Variables() {
  const projectsQuery = useProjects();
  const [selected, setSelected] = useState<string | null>(
    () => (typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null),
  );

  // Auto-select the first project once they load (or honour the persisted choice).
  useEffect(() => {
    const list = projectsQuery.data?.projects ?? [];
    if (list.length === 0) return;
    const persisted = selected && list.find((p) => p.name === selected) ? selected : null;
    const next = persisted ?? list[0].name;
    if (next !== selected) setSelected(next);
  }, [projectsQuery.data, selected]);

  // Persist user selection.
  useEffect(() => {
    if (selected) localStorage.setItem(LS_KEY, selected);
  }, [selected]);

  const project = projectsQuery.data?.projects.find((p) => p.name === selected) ?? null;

  return (
    <>
      <div className="page-header">
        <h2>Variables</h2>
        <span className="meta">
          {projectsQuery.data?.projects.length === 0
            ? 'no projects registered'
            : project
              ? <>project: <code>{project.name}</code> · <code>{project.projectRoot}</code></>
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
                  No project registered yet. From an AI session inside a project
                  with <code>easy-env.json</code>, call <code>env.init</code> to
                  register it. The daemon never reads project directories — every
                  project is identified by what the AI submits.
                </div>
              </div>
            );
          }
          return (
            <>
              <div className="card">
                <h3>Project</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <select
                    value={selected ?? ''}
                    onChange={(e) => setSelected(e.target.value)}
                    style={{
                      background: 'var(--bg)', color: 'var(--fg)',
                      border: '1px solid var(--border)', padding: '6px 10px',
                      borderRadius: 4, fontFamily: 'inherit', fontSize: 13,
                    }}
                  >
                    {data.projects.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name} ({p.variableCount} vars)
                      </option>
                    ))}
                  </select>
                  {project && (
                    <DeleteProjectButton
                      projectName={project.name}
                      projectRoot={project.projectRoot}
                      onDeleted={() => setSelected(null)}
                    />
                  )}
                </div>
              </div>

              {project && <ProjectVariables projectName={project.name} projectRoot={project.projectRoot} />}
            </>
          );
        }}
      </QueryState>
    </>
  );
}

function ProjectVariables({ projectName, projectRoot }: { projectName: string; projectRoot: string }) {
  const query = useVars(projectName);
  const [declareOpen, setDeclareOpen] = useState(false);

  return (
    <>
      <QueryState query={query}>
        {(data) => {
          const entries = Object.entries(data.variables).sort(([a], [b]) => a.localeCompare(b));
          return (
            <>
              <div className="card">
                <h3>Actions</h3>
                <button onClick={() => setDeclareOpen(true)}>Declare variable…</button>
                <div style={{ marginTop: 10, color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
                  The AI (via MCP) is the authoritative declarer of this project's
                  env vars — it reads <code>easy-env.json</code> /
                  <code> docker-compose</code> / source / README and posts{' '}
                  <code>vars.declare</code>. Use this dialog for ad-hoc additions.
                </div>
              </div>

              <ContainersCard containers={data.containers} />

              <div className="card">
                <h3>Variables</h3>
                {entries.length === 0 ? (
                  <div className="empty" style={{ padding: 20 }}>
                    No variables declared yet. Use "Declare variable" or have the AI run vars.declare.
                  </div>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 240 }}>Name</th>
                        <th>Value</th>
                        <th style={{ width: 120 }}>Source</th>
                        <th style={{ width: 140 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map(([name, entry]) => (
                        <VarRow
                          key={name}
                          name={name}
                          entry={entry}
                          projectName={projectName}
                          projectRoot={projectRoot}
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
  projectName,
  projectRoot,
}: {
  name: string;
  entry: VarEntry;
  projectName: string;
  projectRoot: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatForEdit(entry.value));
  const setVar = useSetVar(projectName, projectRoot);
  const unsetVar = useUnsetVar(projectName);

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
          <span style={{ color: 'var(--fg-dim)', fontStyle: 'italic' }}>not set</span>
        ) : (
          <code>{String(entry.value)}</code>
        )}
      </td>
      <td><span className={`badge ${badgeClassFor(entry.source)}`}>{entry.source}</span></td>
      <td>
        {editing ? (
          <>
            <button onClick={handleSave} disabled={setVar.isPending}>Save</button>{' '}
            <button onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button onClick={() => { setDraft(formatForEdit(entry.value)); setEditing(true); }}>
              {entry.source === 'unset' ? 'Set' : 'Edit'}
            </button>{' '}
            {entry.source === 'user' && (
              <button onClick={() => unsetVar.mutate(name)} disabled={unsetVar.isPending}>Clear</button>
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
        <h3>Active env containers</h3>
        <div className="empty" style={{ padding: 14, fontSize: 12, color: 'var(--fg-dim)' }}>
          No active env. Run <code>env.up</code> to start mongo / redis containers.
        </div>
      </div>
    );
  }
  const rows: Array<[string, string | number | undefined]> = [
    ['envId', containers.envId],
    ['mongoUrl', containers.mongoUrl],
    ['redisUrl', containers.redisUrl],
    ['dbName', containers.dbName],
    ['mongoHostPort', containers.mongoHostPort],
    ['redisHostPort', containers.redisHostPort],
  ];
  return (
    <div className="card">
      <h3>Active env containers</h3>
      <div style={{ marginBottom: 8, color: 'var(--fg-dim)', fontSize: 12, lineHeight: 1.5 }}>
        Use these to populate the project's actual variable names via{' '}
        <code>vars.set</code>. For example:{' '}
        <code>MONGO_BG = `${'$'}{containers.mongoUrl}/bg`</code> or{' '}
        <code>REDIS_PORT = ${'$'}{'{'}containers.redisHostPort{'}'}</code>.
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
  projectName,
  projectRoot,
  onClose,
}: {
  projectName: string;
  projectRoot: string;
  onClose: () => void;
}) {
  const declare = useDeclareVars(projectName, projectRoot);
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
    <Modal onClose={onClose} title="Declare a variable">
      <div style={{ marginBottom: 12, color: 'var(--fg-dim)', fontSize: 12 }}>
        Adds the name to the daemon-side manifest; if you provide a value
        it's written into the per-project store (existing values are never
        overwritten).
      </div>

      <Field label="Name (UPPER_SNAKE_CASE)">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="JWT_SECRET"
          autoFocus
          style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 4, fontFamily: 'inherit' }}
        />
        {name && !nameValid && (
          <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 4 }}>
            Must match /^[A-Z_][A-Z0-9_]*$/
          </div>
        )}
      </Field>

      <Field label="Initial value (optional)">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: '100%', background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', padding: '6px 10px', borderRadius: 4, fontFamily: 'inherit' }}
        />
      </Field>

      <Field label="Evidence (optional)">
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
          ✓ Declared {declare.data?.results[0]?.name} ({declare.data?.results[0]?.declared}).
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose}>Cancel</button>
        <button
          onClick={submit}
          disabled={!nameValid || declare.isPending}
          style={{ background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
        >
          Declare
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
  projectName,
  projectRoot,
  onDeleted,
}: {
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
        title={`Delete ~/.easy-env/projects/${projectName}/ (manifest + values). Source tree's easy-env.json stays.`}
      >
        Delete project…
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
        Delete <code>{projectName}</code>?
        <span style={{ display: 'block', fontSize: 11, marginTop: 2 }}>
          Removes manifest + all variable values from <code>~/.easy-env/projects/{projectName}/</code>.
          Source tree <code>easy-env.json</code> at <code>{projectRoot}</code> is untouched.
        </span>
      </span>
      <button
        onClick={() =>
          deleteProject.mutate(projectName, {
            onSuccess: () => {
              setConfirming(false);
              onDeleted();
            },
          })
        }
        disabled={deleteProject.isPending}
        style={{ background: 'var(--red, #c33)', color: 'white', borderColor: 'var(--red, #c33)' }}
      >
        {deleteProject.isPending ? 'Deleting…' : 'Confirm'}
      </button>
      <button onClick={() => setConfirming(false)} disabled={deleteProject.isPending}>
        Cancel
      </button>
      {deleteProject.isError && (
        <div style={{ color: 'var(--red, #c33)', fontSize: 11 }}>
          {(deleteProject.error as Error).message}
        </div>
      )}
    </div>
  );
}
