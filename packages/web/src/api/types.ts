// Type mirrors of the daemon API responses. Hand-maintained — the daemon
// itself has Zod schemas in packages/mcp-server/src/schemas/. If the schemas
// change, update these to match (or codegen later).

export type EnvStatus = 'starting' | 'ready' | 'destroyed' | 'error';

export interface ContainerHandle {
  containerId: string;
  image: string;
  internalPort: number;
  hostPort: number;
}

export interface ResolvedUrls {
  mongoUrl?: string;
  redisUrl?: string;
  dbName: string;
  baseUrl?: string;
}

// Returned by GET /api/envs (env.list).
export interface EnvListItem {
  envId: string;
  createdAt: string;
  status: EnvStatus;
  resolved: ResolvedUrls;
  images: {
    mongo: string | null;
    redis: string | null;
  };
}

export interface EnvListResponse {
  activeEnvId: string | null;
  envs: EnvListItem[];
}

// Returned by GET /api/envs/:envId (env.status).
export interface EnvDetailResponse {
  envId: string;
  createdAt: string;
  status: EnvStatus;
  resolved: ResolvedUrls;
  health: {
    mongoReachable: boolean;
    redisReachable: boolean;
  };
  containers: {
    mongo: ContainerHandle | null;
    redis: ContainerHandle | null;
  };
  labels: Record<string, string>;
  error?: string;
}

export interface ArtifactSummary {
  id: string;
  takenAt: string;
  sizeBytes: number;
}

export interface SnapshotsListResponse {
  snapshots: ArtifactSummary[];
}

export interface DiffsListResponse {
  diffs: ArtifactSummary[];
}

// Snapshot / Diff details — typed as `unknown` JSON since their inner shape
// is large + free-form (mongo collections, redis keys, etc.). We render
// them as JSON; views that need typed access can refine locally.
export type SnapshotDetailResponse = {
  snapshotId: string;
  takenAt: string;
  mongo: Record<string, unknown[]>;
  redis: Record<string, unknown>;
};

export type DiffDetailResponse = {
  diffId: string;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  beforeTakenAt: string;
  afterTakenAt: string;
  mongo: Record<string, { added: unknown[]; removed: unknown[]; modified: unknown[] }>;
  redis: {
    added: Record<string, unknown>;
    removed: Record<string, unknown>;
    modified: Record<string, unknown>;
  };
};

export interface HealthResponse {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: string;
  uptimeMs: number;
}

export interface ToolsListResponse {
  tools: Array<{ name: string; description: string }>;
}

export interface ActivityEntry {
  id: number;
  tool: string;
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorMessage?: string;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
  stats: { total: number; ok: number; error: number };
}

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ── vars ───────────────────────────────────────────────────────────────────
export type VarValue = string | number | boolean | null;
export type VarSource = 'user' | 'container' | 'unset';

export interface VarEntry {
  value: VarValue;
  source: VarSource;
}

export interface VarsListResponse {
  projectName: string | null;
  variables: Record<string, VarEntry>;
}

export interface VarsInitCandidate {
  name: string;
  evidence: string[];
}

export interface VarsInitResponse {
  applied: boolean;
  existing: string[];
  additions: VarsInitCandidate[];
  unchanged: VarsInitCandidate[];
  configPath: string;
  projectName: string | null;
  mergedVariables?: string[];
}
