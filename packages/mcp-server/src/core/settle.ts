import type { SettleCondition, SettleOutcome } from '../schemas/scenario.js';

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`probe ${url} returned ${res.status}`);
  return res.json();
}

function getField(obj: unknown, field: string): unknown {
  if (obj && typeof obj === 'object' && field in (obj as Record<string, unknown>)) {
    return (obj as Record<string, unknown>)[field];
  }
  return undefined;
}

export async function settle(
  baseUrl: string,
  condition: SettleCondition,
): Promise<SettleOutcome> {
  const start = Date.now();
  let lastValue: unknown = null;
  let polls = 0;
  while (Date.now() - start < condition.timeoutMs) {
    polls++;
    try {
      const probed = await fetchJson(`${baseUrl}${condition.probePath}`);
      lastValue = getField(probed, condition.pendingField);
      if (lastValue === 0) {
        return {
          settled: true,
          waitedMs: Date.now() - start,
          polls,
          finalValue: 0,
        };
      }
    } catch (_e) {
      // probe transiently unreachable; keep polling
    }
    await new Promise((r) => setTimeout(r, condition.intervalMs));
  }
  return {
    settled: false,
    waitedMs: Date.now() - start,
    polls,
    finalValue: lastValue,
    timeoutReason: 'probed pending count did not reach zero before timeout',
  };
}
