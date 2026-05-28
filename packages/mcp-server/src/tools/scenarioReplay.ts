import { z } from 'zod';
import { ScenarioConfig } from '../schemas/scenario.js';
import { NoisePolicy } from '../schemas/diff.js';
import { CaptureSpec } from '../schemas/capture.js';
import { replayScenario } from '../core/orchestrate.js';
import type { ToolContext } from '../core/context.js';
import { resolveBackends } from '../core/envOps.js';

// At the tool layer the inline scenario can omit baseUrl/backends/capture and
// have them filled from easy-env.json. The underlying ScenarioConfig stays
// strict (artifacts are self-contained once persisted).
export const ScenarioReplayInputScenario = ScenarioConfig
  .omit({ baseUrl: true, capture: true, backends: true })
  .extend({
    baseUrl: z.string().url().optional(),
    backends: ScenarioConfig.shape.backends.optional(),
    capture: CaptureSpec.optional(),
  });

export const ScenarioReplayInput = z.object({
  scenario: ScenarioReplayInputScenario.optional(),
  scenarioId: z.string().optional(),
  envId: z.string().optional(),
  noisePolicy: NoisePolicy.optional(),
}).refine(
  (i) => i.scenario !== undefined || i.scenarioId !== undefined,
  'Provide either scenario (inline) or scenarioId (previously saved)',
);

export type ScenarioReplayInput = z.infer<typeof ScenarioReplayInput>;

export async function runScenarioReplay(input: ScenarioReplayInput, ctx: ToolContext) {
  let scenario: z.infer<typeof ScenarioConfig> | null = null;

  if (input.scenario) {
    if (!input.scenario.baseUrl) {
      throw new Error('scenario.replay requires scenario.baseUrl.');
    }
    if (!input.scenario.capture) {
      throw new Error('scenario.replay requires scenario.capture.');
    }
    // Backend resolution: explicit > envId/active env > built-in fallback.
    const resolved = await resolveBackends(
      ctx.registry,
      input.envId,
      input.scenario.backends,
    );
    // Only include ClickHouse fields when the env actually declared it —
    // otherwise the persisted scenario config picks up a phantom URL for
    // backends the project doesn't use.
    const backends = {
      mongoUrl: resolved.mongoUrl,
      dbName: resolved.dbName,
      redisUrl: resolved.redisUrl,
      ...(resolved.clickhouseUrl ? { clickhouseUrl: resolved.clickhouseUrl } : {}),
      ...(resolved.clickhouseDbName ? { clickhouseDbName: resolved.clickhouseDbName } : {}),
    };
    scenario = ScenarioConfig.parse({
      ...input.scenario,
      baseUrl: input.scenario.baseUrl,
      capture: input.scenario.capture,
      backends,
    });
  } else if (input.scenarioId) {
    const fetched = await ctx.store.getScenario(input.scenarioId);
    if (!fetched) throw new Error(`scenario not found: ${input.scenarioId}`);
    scenario = fetched;
  }

  if (!scenario) throw new Error('no scenario resolved');
  await ctx.store.saveScenario(scenario);
  const result = await replayScenario(scenario, ctx.store, input.noisePolicy);
  return {
    runId: result.run.runId,
    triggerResponse: result.run.triggerResponse,
    beforeSnapshotId: result.beforeSnapshotId,
    afterSnapshotId: result.afterSnapshotId,
    diffId: result.diffId,
    settle: result.run.settle,
    resolvedScenario: {
      baseUrl: scenario.baseUrl,
      backends: scenario.backends,
    },
  };
}

export const scenarioReplayToolDescription = {
  name: 'scenario.replay',
  description:
    "Run a scenario end-to-end: execute preconditions, snapshot BEFORE, fire the trigger HTTP request, optionally settle, snapshot AFTER, compute the diff, and persist the run. Returns ids you can use to retrieve individual artifacts. The target app must already be running and reachable at the resolved baseUrl. baseUrl and capture are required on the inline scenario; backends fall back to envId/active env when omitted.",
  inputSchema: ScenarioReplayInput,
};
