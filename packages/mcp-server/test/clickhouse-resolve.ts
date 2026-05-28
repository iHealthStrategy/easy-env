// Regression for code-review #1: resolveBackends must NOT inject a
// fallback ClickHouse URL when neither the override nor the active env
// declared ClickHouse. Previously it always returned
// FALLBACK_CLICKHOUSE_URL='http://localhost:8124', which scenarioReplay
// then persisted into the scenario config for mongo-only projects — a
// phantom URL that didn't correspond to any running container.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { EnvRegistry } from '../src/store/envRegistry.js';
import { resolveBackends } from '../src/core/envOps.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CLICKHOUSE RESOLVE FAIL: ${msg}`);
}

async function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-resolve-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn();
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function main() {
  await withTempHome(async () => {
    const registry = new EnvRegistry();

    // No env, no override → ClickHouse URL must be undefined (not the
    // FALLBACK_CLICKHOUSE_URL that v0.5.0 silently injected). Mongo/Redis
    // still fall back to compose ports — those are kept as-is for the
    // smoke tests, and rabbit was already returning its fallback.
    const r1 = await resolveBackends(registry);
    assert(r1.clickhouseUrl === undefined, `clickhouseUrl must be undefined when nothing declares CH; got ${r1.clickhouseUrl}`);
    assert(r1.mongoUrl === 'mongodb://localhost:27018', 'mongo fallback preserved');
    assert(r1.redisUrl === 'redis://localhost:6380', 'redis fallback preserved');
    console.log('  ✓ resolveBackends: no env + no override → clickhouseUrl is undefined');

    // Explicit override is honored — must round-trip.
    const r2 = await resolveBackends(registry, undefined, {
      clickhouseUrl: 'http://localhost:9999',
      clickhouseDbName: 'analytics',
    });
    assert(r2.clickhouseUrl === 'http://localhost:9999', 'override clickhouseUrl honored');
    assert(r2.clickhouseDbName === 'analytics', 'override clickhouseDbName honored');
    console.log('  ✓ resolveBackends: explicit override is honored');

    // Other backend override (no CH) leaves CH absent.
    const r3 = await resolveBackends(registry, undefined, {
      mongoUrl: 'mongodb://elsewhere:1234',
    });
    assert(r3.clickhouseUrl === undefined, 'mongo override does not leak CH fallback');
    console.log('  ✓ resolveBackends: mongo override leaves clickhouseUrl undefined');
  });
  console.log('clickhouse-resolve: ALL PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
