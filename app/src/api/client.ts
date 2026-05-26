// Daemon API client for the Tauri app. Every request goes through the Rust
// `daemon_fetch` command — this avoids browser CORS (Tauri webview origin
// differs from http://127.0.0.1:7193) and lets us reuse the daemon's HTTP
// surface verbatim. In a plain Vite dev session (no Tauri runtime) we fall
// back to fetch() so `npm run dev` still works for UI-only iteration with
// the Vite proxy in vite.config.ts.
import { invoke } from '@tauri-apps/api/core';
import type {
  EnvListResponse,
  EnvDetailResponse,
  SnapshotsListResponse,
  SnapshotDetailResponse,
  DiffsListResponse,
  DiffDetailResponse,
  HealthResponse,
  ToolsListResponse,
  ActivityResponse,
  ProjectsListResponse,
  VarsListResponse,
  VarsDeclareResponse,
  VarsDeclareItem,
  VarValue,
  ApiError,
} from './types';

type DaemonFetchResponse = { status: number; ok: boolean; body: unknown };

const IS_TAURI =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const method = init?.method ?? 'GET';
  let status: number;
  let ok: boolean;
  let parsed: unknown;

  if (IS_TAURI) {
    const res = await invoke<DaemonFetchResponse>('daemon_fetch', {
      method,
      path,
      body: init?.body ?? null,
    });
    status = res.status;
    ok = res.ok;
    parsed = res.body;
  } else {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    status = res.status;
    ok = res.ok;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
  }

  if (!ok) {
    const err =
      parsed && typeof parsed === 'object' && 'error' in (parsed as ApiError)
        ? (parsed as ApiError).error
        : { code: String(status), message: 'request failed' };
    throw new ApiCallError(err.code, err.message, status, err.details);
  }
  return parsed as T;
}

export class ApiCallError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),
  listTools: () => request<ToolsListResponse>('/api/tools'),
  activity: (limit = 50) =>
    request<ActivityResponse>(`/api/activity?limit=${limit}`),
  listEnvs: (projectName?: string) =>
    request<EnvListResponse>(
      projectName ? `/api/envs?projectName=${encodeURIComponent(projectName)}` : '/api/envs',
    ),
  getEnv: (envId: string) =>
    request<EnvDetailResponse>(`/api/envs/${encodeURIComponent(envId)}`),
  listSnapshots: () => request<SnapshotsListResponse>('/api/snapshots'),
  getSnapshot: (id: string) =>
    request<SnapshotDetailResponse>(`/api/snapshots/${encodeURIComponent(id)}`),
  listDiffs: () => request<DiffsListResponse>('/api/diffs'),
  getDiff: (id: string) =>
    request<DiffDetailResponse>(`/api/diffs/${encodeURIComponent(id)}`),

  // ── projects ─────────────────────────────────────────────────────────────
  // `projectKey` is the slug returned in ProjectSummary.key — the daemon
  // resolves it back to (projectName, projectRoot) before dispatching the
  // underlying tool, so two worktrees with the same projectName never
  // collide on these routes.
  listProjects: () => request<ProjectsListResponse>('/api/projects'),
  deleteProject: (projectKey: string) =>
    request<{ projectName: string; deleted: boolean }>(
      `/api/projects/${encodeURIComponent(projectKey)}`,
      { method: 'DELETE' },
    ),

  // ── vars (per-project) ───────────────────────────────────────────────────
  listVars: (projectKey: string) =>
    request<VarsListResponse>(`/api/projects/${encodeURIComponent(projectKey)}/vars`),
  setVar: (projectKey: string, name: string, value: VarValue) =>
    request<{ name: string; value: VarValue; source: 'user' }>(
      `/api/projects/${encodeURIComponent(projectKey)}/vars/${encodeURIComponent(name)}`,
      { method: 'PUT', body: { value } },
    ),
  unsetVar: (projectKey: string, name: string) =>
    request<{ name: string; cleared: true }>(
      `/api/projects/${encodeURIComponent(projectKey)}/vars/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  // vars.declare still POSTs the real (projectName, projectRoot) because
  // the daemon uses them to load/init the manifest — slugs alone can't
  // express the "new worktree, no manifest yet" case.
  declareVars: (projectName: string, projectRoot: string, items: VarsDeclareItem[], removeUndeclared = false) =>
    request<VarsDeclareResponse>('/api/tools/vars.declare', {
      method: 'POST',
      body: { projectName, projectRoot, items, removeUndeclared },
    }),
};
