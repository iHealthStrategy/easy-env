import { z } from 'zod';
import { CaptureSpec, BackendUrls } from './capture.js';

export const HttpRequestSpec = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1),
  body: z.unknown().optional(),
  capture: z.object({
    from_response: z.string(),
    as: z.string(),
  }).optional(),
});

export const SettleConditionOutboxDrained = z.object({
  kind: z.literal('outbox_drained'),
  probePath: z.string().default('/_debug/outbox-pending'),
  pendingField: z.string().default('pending'),
  timeoutMs: z.number().int().positive().default(2000),
  intervalMs: z.number().int().positive().default(100),
});

export const SettleConditionHttpZero = z.object({
  kind: z.literal('http_count_zero'),
  probePath: z.string(),
  pendingField: z.string(),
  timeoutMs: z.number().int().positive().default(2000),
  intervalMs: z.number().int().positive().default(100),
});

export const SettleCondition = z.discriminatedUnion('kind', [
  SettleConditionOutboxDrained,
  SettleConditionHttpZero,
]);

export const ScenarioConfig = z.object({
  id: z.string().min(1),
  baseUrl: z.string().url(),
  capture: CaptureSpec,
  backends: BackendUrls.default({}),
  preconditions: z.array(HttpRequestSpec).default([]),
  trigger: HttpRequestSpec,
  settle: SettleCondition.optional(),
  intent: z.string().optional(),
});

export const SettleOutcome = z.object({
  settled: z.boolean(),
  waitedMs: z.number(),
  polls: z.number(),
  finalValue: z.unknown(),
  timeoutReason: z.string().optional(),
});

export const RunArtifact = z.object({
  runId: z.string(),
  scenarioId: z.string(),
  runAt: z.string(),
  triggerRequest: z.unknown(),
  triggerResponse: z.object({
    status: z.number(),
    body: z.unknown(),
  }),
  beforeSnapshotId: z.string(),
  afterSnapshotId: z.string(),
  settle: SettleOutcome.optional(),
  diffId: z.string(),
});

export type HttpRequestSpec = z.infer<typeof HttpRequestSpec>;
export type SettleCondition = z.infer<typeof SettleCondition>;
export type ScenarioConfig = z.infer<typeof ScenarioConfig>;
export type SettleOutcome = z.infer<typeof SettleOutcome>;
export type RunArtifact = z.infer<typeof RunArtifact>;
