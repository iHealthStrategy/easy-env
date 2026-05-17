import type { ScenarioConfig, RunArtifact, SettleOutcome } from '../schemas/scenario.js';
import { captureState } from './capture.js';
import { diffSnapshots } from './diff.js';
import { settle } from './settle.js';
import { executeRequest, getResponseField } from './http.js';
import { newId, nowIso } from './ids.js';
import type { Store } from '../store/fsStore.js';
import type { NoisePolicy } from '../schemas/diff.js';

const DEFAULT_NOISE: NoisePolicy = {
  ignoreTimestampFields: ['createdAt', 'updatedAt', 'processedAt', 'publishedAt'],
  ignoreRedisTtlDrift: true,
};

export interface ReplayResult {
  run: RunArtifact;
  beforeSnapshotId: string;
  afterSnapshotId: string;
  diffId: string;
}

export async function replayScenario(
  scenario: ScenarioConfig,
  store: Store,
  noisePolicy: NoisePolicy = DEFAULT_NOISE,
): Promise<ReplayResult> {
  const captures: Record<string, string> = {};

  // Preconditions.
  for (const step of scenario.preconditions) {
    const result = await executeRequest(scenario.baseUrl, step, captures);
    if (step.capture) {
      const val = getResponseField(result.body, step.capture.from_response);
      if (val == null) {
        throw new Error(`precondition capture failed: ${step.capture.from_response}`);
      }
      captures[step.capture.as] = String(val);
    }
  }

  // Snapshot BEFORE.
  const before = await captureState(scenario.capture, scenario.backends);
  await store.saveSnapshot(scenario.id, before);

  // Trigger.
  const triggerRes = await executeRequest(scenario.baseUrl, scenario.trigger, captures);

  // Settle (optional).
  let settleOutcome: SettleOutcome | undefined;
  if (scenario.settle) {
    settleOutcome = await settle(scenario.baseUrl, scenario.settle);
  }

  // Snapshot AFTER.
  const after = await captureState(scenario.capture, scenario.backends);
  await store.saveSnapshot(scenario.id, after);

  // Diff.
  const diff = diffSnapshots(before, after, noisePolicy);
  await store.saveDiff(scenario.id, diff);

  const run: RunArtifact = {
    runId: newId('run'),
    scenarioId: scenario.id,
    runAt: nowIso(),
    triggerRequest: scenario.trigger,
    triggerResponse: triggerRes,
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    settle: settleOutcome,
    diffId: diff.diffId,
  };
  await store.saveRun(scenario.id, run);

  return {
    run,
    beforeSnapshotId: before.snapshotId,
    afterSnapshotId: after.snapshotId,
    diffId: diff.diffId,
  };
}
