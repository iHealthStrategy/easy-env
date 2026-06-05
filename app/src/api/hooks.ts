// React Query hooks. Wraps the typed api client so pages get caching,
// loading/error state, and refetch out of the box.
//
// Polling cadence: queries that watch state which can change without the
// user's input (envs spawning/exiting, vars set from another session,
// daemon health, activity feed) poll periodically so the UI stays live
// even when the user doesn't navigate away and back. Static-ish things
// (tools registry, immutable snapshots/diffs) don't poll.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { VarValue, VarsDeclareItem, MonitorConfigResponse } from './types';

// Default cadence for "live state" queries. Cheap (one local HTTP roundtrip
// per refresh) and frequent enough that env.up / vars.set / project.delete
// from any source (MCP, CLI, another window) shows up within ~2s.
const LIVE_REFETCH_MS = 2000;
const ACTIVITY_REFETCH_MS = 3000;
const HEALTH_REFETCH_MS = 5000;
// Traffic is the most "live" view — poll a touch faster so a captured query
// shows up promptly while the user is watching.
const TRAFFIC_REFETCH_MS = 1500;

export const queryKeys = {
  health: ['health'] as const,
  tools: ['tools'] as const,
  activity: ['activity'] as const,
  envs: ['envs'] as const,
  env: (id: string) => ['envs', id] as const,
  snapshots: ['snapshots'] as const,
  snapshot: (id: string) => ['snapshots', id] as const,
  diffs: ['diffs'] as const,
  diff: (id: string) => ['diffs', id] as const,
  projects: ['projects'] as const,
  // The vars-cache key is the project slug, NOT the human projectName,
  // so two worktrees with the same projectName don't share cache entries.
  vars: (projectKey: string) => ['vars', projectKey] as const,
  monitor: (id: string) => ['envs', id, 'monitor'] as const,
  traffic: (id: string) => ['envs', id, 'traffic'] as const,
};

export const useHealth = (opts?: { refetchInterval?: number }) =>
  useQuery({
    queryKey: queryKeys.health,
    queryFn: api.health,
    refetchInterval: opts?.refetchInterval ?? HEALTH_REFETCH_MS,
  });

// Tools registry is effectively static for the lifetime of a daemon build.
export const useTools = () =>
  useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools, staleTime: 60_000 });

export const useActivity = (opts?: { refetchInterval?: number }) =>
  useQuery({
    queryKey: queryKeys.activity,
    queryFn: () => api.activity(50),
    refetchInterval: opts?.refetchInterval ?? ACTIVITY_REFETCH_MS,
  });

export const useEnvs = () =>
  useQuery({
    queryKey: queryKeys.envs,
    queryFn: () => api.listEnvs(),
    refetchInterval: LIVE_REFETCH_MS,
  });

export function useEnvDown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (envId: string) => api.downEnv(envId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.envs }),
  });
}

export const useEnv = (id: string) =>
  useQuery({
    queryKey: queryKeys.env(id),
    queryFn: () => api.getEnv(id),
    refetchInterval: LIVE_REFETCH_MS,
  });

// ── traffic monitoring ──────────────────────────────────────────────────
// Monitor config (available dbs + selection + running state) is live state
// (enable/disable can happen from MCP or another window), so it polls.
export const useMonitorConfig = (envId: string) =>
  useQuery({
    queryKey: queryKeys.monitor(envId),
    queryFn: () => api.getMonitorConfig(envId),
    refetchInterval: LIVE_REFETCH_MS,
  });

// Persist db selection and/or toggle capture. Optimistically updates the
// cached monitor config so the toggle/checkboxes reflect the intended state
// immediately and don't bounce against the 2s background poll; rolls back on
// error; reconciles with the server on settle.
export function useSetMonitorConfig(envId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { databases?: string[]; enabled?: boolean }) =>
      api.setMonitorConfig(envId, patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: queryKeys.monitor(envId) });
      const prev = qc.getQueryData<MonitorConfigResponse>(queryKeys.monitor(envId));
      if (prev) {
        qc.setQueryData<MonitorConfigResponse>(queryKeys.monitor(envId), {
          ...prev,
          ...(patch.databases !== undefined ? { selected: patch.databases } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        });
      }
      return { prev };
    },
    onError: (_e, _patch, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKeys.monitor(envId), ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.monitor(envId) });
      qc.invalidateQueries({ queryKey: queryKeys.traffic(envId) });
    },
  });
}

export const useTraffic = (envId: string, enabled: boolean) =>
  useQuery({
    queryKey: queryKeys.traffic(envId),
    queryFn: () => api.getTraffic(envId),
    // Only poll the stream while capture is on — no point hammering it when
    // the profiler is off.
    refetchInterval: enabled ? TRAFFIC_REFETCH_MS : false,
  });

// Snapshots / diffs are immutable artifacts once written; the LIST can
// gain new entries though, so poll the lists but not the details.
export const useSnapshots = () =>
  useQuery({
    queryKey: queryKeys.snapshots,
    queryFn: api.listSnapshots,
    refetchInterval: LIVE_REFETCH_MS,
  });
export const useSnapshot = (id: string) =>
  useQuery({ queryKey: queryKeys.snapshot(id), queryFn: () => api.getSnapshot(id) });
export const useDiffs = () =>
  useQuery({
    queryKey: queryKeys.diffs,
    queryFn: api.listDiffs,
    refetchInterval: LIVE_REFETCH_MS,
  });
export const useDiff = (id: string) =>
  useQuery({ queryKey: queryKeys.diff(id), queryFn: () => api.getDiff(id) });

export const useProjects = () =>
  useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.listProjects,
    refetchInterval: LIVE_REFETCH_MS,
  });

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectKey: string) => api.deleteProject(projectKey),
    onSuccess: (_, projectKey) => {
      qc.invalidateQueries({ queryKey: queryKeys.projects });
      qc.removeQueries({ queryKey: queryKeys.vars(projectKey) });
    },
  });
}

export const useVars = (projectKey: string | null) =>
  useQuery({
    queryKey: projectKey ? queryKeys.vars(projectKey) : ['vars', 'none'],
    queryFn: () => api.listVars(projectKey!),
    enabled: !!projectKey,
    refetchInterval: LIVE_REFETCH_MS,
  });

export function useSetVar(projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, value }: { name: string; value: VarValue }) =>
      api.setVar(projectKey, name, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vars(projectKey) }),
  });
}

export function useUnsetVar(projectKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.unsetVar(projectKey, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.vars(projectKey) }),
  });
}

export function useDeclareVars(projectKey: string, projectName: string, projectRoot: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ items, removeUndeclared = false }: { items: VarsDeclareItem[]; removeUndeclared?: boolean }) =>
      api.declareVars(projectName, projectRoot, items, removeUndeclared),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.vars(projectKey) });
      qc.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}
