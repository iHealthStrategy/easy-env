import { z } from 'zod';
import { SettleCondition } from '../schemas/scenario.js';
import { settle } from '../core/settle.js';
import type { ToolContext } from '../core/context.js';

export const ScenarioSettleInput = z.object({
  baseUrl: z.string().url(),
  condition: SettleCondition,
});

export type ScenarioSettleInput = z.infer<typeof ScenarioSettleInput>;

export async function runScenarioSettle(input: ScenarioSettleInput, _ctx: ToolContext) {
  const outcome = await settle(input.baseUrl, input.condition);
  return { ...outcome, resolvedBaseUrl: input.baseUrl };
}

export const scenarioSettleToolDescription = {
  name: 'scenario.settle',
  description:
    'Block until the system under test reaches an explicit quiescence condition (or timeout). The outcome (settled, waitedMs, polls, finalValue, timeoutReason?) is evidence, NOT a verdict — a settled:true result does NOT imply correctness.',
  inputSchema: ScenarioSettleInput,
};
