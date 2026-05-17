import type { HttpRequestSpec } from '../schemas/scenario.js';

export interface HttpResult {
  status: number;
  body: unknown;
}

export async function executeRequest(
  baseUrl: string,
  spec: HttpRequestSpec,
  captures: Record<string, string>,
): Promise<HttpResult> {
  const path = applyPlaceholders(spec.path, captures);
  const body = spec.body != null ? applyPlaceholders(spec.body, captures) : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method: spec.method,
    headers: body != null ? { 'Content-Type': 'application/json' } : {},
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

export function getResponseField(body: unknown, dotPath: string): unknown {
  return dotPath.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return acc;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, body);
}

function applyPlaceholders(value: unknown, captures: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (!(key in captures)) throw new Error(`missing capture: ${key}`);
      return captures[key];
    });
  }
  if (Array.isArray(value)) return value.map((v) => applyPlaceholders(v, captures));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyPlaceholders(v, captures);
    return out;
  }
  return value;
}
