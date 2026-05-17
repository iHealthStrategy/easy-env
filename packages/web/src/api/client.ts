// Thin typed fetch wrapper around the daemon HTTP API. In dev, Vite proxies
// /api → daemon (see vite.config.ts). In prod, the daemon serves the SPA
// itself, so same-origin requests work without a proxy.
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
  VarsListResponse,
  VarsInitResponse,
  VarValue,
  ApiError,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = (parsed && typeof parsed === 'object' && 'error' in parsed)
      ? (parsed as ApiError).error
      : { code: String(res.status), message: res.statusText };
    throw new ApiCallError(err.code, err.message, res.status, err.details);
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
  activity: (limit = 50) => request<ActivityResponse>(`/api/activity?limit=${limit}`),
  listEnvs: () => request<EnvListResponse>('/api/envs'),
  getEnv: (envId: string) => request<EnvDetailResponse>(`/api/envs/${encodeURIComponent(envId)}`),
  listSnapshots: () => request<SnapshotsListResponse>('/api/snapshots'),
  getSnapshot: (id: string) => request<SnapshotDetailResponse>(`/api/snapshots/${encodeURIComponent(id)}`),
  listDiffs: () => request<DiffsListResponse>('/api/diffs'),
  getDiff: (id: string) => request<DiffDetailResponse>(`/api/diffs/${encodeURIComponent(id)}`),
  listVars: () => request<VarsListResponse>('/api/vars'),
  setVar: (name: string, value: VarValue) =>
    request<{ name: string; value: VarValue; source: 'user' }>(`/api/vars/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  unsetVar: (name: string) =>
    request<{ name: string; cleared: true }>(`/api/vars/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  initVars: (dryRun: boolean) =>
    request<VarsInitResponse>(`/api/vars/init?dryRun=${dryRun ? '1' : '0'}`, { method: 'POST' }),
};
