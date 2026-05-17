import { useState } from 'react';
import { useInitVars, useSetVar, useUnsetVar, useVars } from '../api/hooks';
import { QueryState } from '../components/QueryState';
import type { VarEntry, VarsInitResponse } from '../api/types';

export function Variables() {
  const query = useVars();
  const [initOpen, setInitOpen] = useState(false);

  return (
    <>
      <div className="page-header">
        <h2>Variables</h2>
        <span className="meta">
          {query.data?.projectName ? (
            <>project: <code>{query.data.projectName}</code></>
          ) : (
            <>no project name in easy-env.json</>
          )}
        </span>
      </div>

      <QueryState query={query}>
        {(data) => {
          const entries = Object.entries(data.variables).sort(([a], [b]) => a.localeCompare(b));
          return (
            <>
              <div className="card">
                <h3>Actions</h3>
                <button onClick={() => setInitOpen(true)} disabled={!data.projectName}>
                  Init from project…
                </button>
                <span style={{ marginLeft: 12, color: 'var(--fg-dim)', fontSize: 12 }}>
                  Scan .env / docker-compose / source for variable names and add them to easy-env.json.
                </span>
              </div>

              <div className="card">
                <h3>Variables</h3>
                {entries.length === 0 ? (
                  <div className="empty" style={{ padding: 20 }}>
                    {data.projectName
                      ? 'No variables declared yet. Use "Init from project" to bootstrap.'
                      : 'Add a "name" field to easy-env.json to enable variables.'}
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
                        <VarRow key={name} name={name} entry={entry} />
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          );
        }}
      </QueryState>

      {initOpen && <InitModal onClose={() => setInitOpen(false)} />}
    </>
  );
}

function VarRow({ name, entry }: { name: string; entry: VarEntry }) {
  const isContainer = entry.source === 'container';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatForEdit(entry.value));
  const setVar = useSetVar();
  const unsetVar = useUnsetVar();

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
        {isContainer ? (
          <code>{String(entry.value)}</code>
        ) : editing ? (
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
        {isContainer ? (
          <span style={{ color: 'var(--fg-dim)' }}>—</span>
        ) : editing ? (
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

function InitModal({ onClose }: { onClose: () => void }) {
  const init = useInitVars();
  const [proposal, setProposal] = useState<VarsInitResponse | null>(null);

  if (!proposal && !init.isPending && !init.isError) {
    init.mutate(true, { onSuccess: setProposal });
  }

  const handleApply = () => {
    init.mutate(false, {
      onSuccess: (data) => {
        setProposal(data);
        // close after a brief moment so user sees the result
        setTimeout(onClose, 600);
      },
    });
  };

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
          padding: 24, maxWidth: 720, width: '90%', maxHeight: '80vh', overflow: 'auto',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Initialize variables from project</h3>

        {init.isPending && !proposal ? (
          <div className="loading">Scanning project…</div>
        ) : init.isError ? (
          <div className="error-banner">{(init.error as Error).message}</div>
        ) : proposal ? (
          <>
            {proposal.applied && (
              <div style={{ color: 'var(--green)', marginBottom: 12 }}>
                ✓ Applied. Wrote {proposal.mergedVariables?.length ?? 0} variables to{' '}
                <code>{proposal.configPath}</code>
              </div>
            )}

            <div style={{ marginBottom: 16 }}>
              <strong>Proposed additions ({proposal.additions.length})</strong>
              {proposal.additions.length === 0 ? (
                <div style={{ color: 'var(--fg-dim)', marginTop: 6 }}>Nothing new to add.</div>
              ) : (
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr><th>Name</th><th>Evidence</th></tr>
                  </thead>
                  <tbody>
                    {proposal.additions.map((c) => (
                      <tr key={c.name}>
                        <td><code>{c.name}</code></td>
                        <td style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
                          {c.evidence.slice(0, 3).join('; ')}
                          {c.evidence.length > 3 ? ` (+${c.evidence.length - 3} more)` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {proposal.unchanged.length > 0 && (
              <div style={{ marginBottom: 16, color: 'var(--fg-dim)', fontSize: 12 }}>
                Already declared ({proposal.unchanged.length}):{' '}
                {proposal.unchanged.map((c) => c.name).join(', ')}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button onClick={onClose}>Close</button>
              {!proposal.applied && proposal.additions.length > 0 && (
                <button
                  onClick={handleApply}
                  disabled={init.isPending}
                  style={{ background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}
                >
                  Apply ({proposal.additions.length})
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function badgeClassFor(source: VarEntry['source']): string {
  switch (source) {
    case 'user': return 'ready';
    case 'container': return 'active';
    case 'unset': return 'starting';
  }
}

function formatForEdit(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return String(v);
}

// Convert the input string back into a typed value. Booleans and numbers
// pass through; everything else stays as string.
function parseValue(input: string): string | number | boolean {
  const trimmed = input.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return input;
}

