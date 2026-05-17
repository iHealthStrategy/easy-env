// React Query hooks. Wraps the typed api client so pages get caching,
// loading/error state, and refetch out of the box.
import { useQuery } from '@tanstack/react-query';
import { api } from './client';

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
};

export const useHealth = (opts?: { refetchInterval?: number }) =>
  useQuery({ queryKey: queryKeys.health, queryFn: api.health, refetchInterval: opts?.refetchInterval });
export const useTools = () => useQuery({ queryKey: queryKeys.tools, queryFn: api.listTools, staleTime: 60_000 });
export const useActivity = (opts?: { refetchInterval?: number }) =>
  useQuery({ queryKey: queryKeys.activity, queryFn: () => api.activity(50), refetchInterval: opts?.refetchInterval });
export const useEnvs = () => useQuery({ queryKey: queryKeys.envs, queryFn: api.listEnvs });
export const useEnv = (id: string) => useQuery({ queryKey: queryKeys.env(id), queryFn: () => api.getEnv(id) });
export const useSnapshots = () => useQuery({ queryKey: queryKeys.snapshots, queryFn: api.listSnapshots });
export const useSnapshot = (id: string) => useQuery({ queryKey: queryKeys.snapshot(id), queryFn: () => api.getSnapshot(id) });
export const useDiffs = () => useQuery({ queryKey: queryKeys.diffs, queryFn: api.listDiffs });
export const useDiff = (id: string) => useQuery({ queryKey: queryKeys.diff(id), queryFn: () => api.getDiff(id) });
