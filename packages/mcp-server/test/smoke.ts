// End-to-end smoke test for v1.1: easy-env spawns its OWN backend
// containers via env.up (Testcontainers), starts the fixture app pointing
// at those, exercises all 15 MCP tools, and cleans up.
//
// Requires Docker to be running on the host. Does NOT depend on the
// docker-compose at the repo root — env.up provisions everything.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { runStateCapture } from '../src/tools/stateCapture.js';
import { runScenarioReplay } from '../src/tools/scenarioReplay.js';
import { runEnvInit } from '../src/tools/envInit.js';
import {
  runEnvUp,
  runEnvList,
  runEnvStatus,
  runEnvReset,
  runEnvDown,
} from '../src/tools/envLifecycle.js';
import {
  runDbSeed,
  runDbFind,
  runDbInsert,
  runDbUpdate,
  runDbDelete,
} from '../src/tools/db.js';

const FIXTURES_ROOT = path.resolve(process.cwd(), '..', '..', 'fixtures');
const MINI_ORDERS_DIR = path.join(FIXTURES_ROOT, 'mini-orders');
const APP_PORT = 4200;
const BASE_URL = `http://localhost:${APP_PORT}`;

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mini-orders did not become healthy');
}

function startMiniOrders(env: { MONGO_URL: string; REDIS_URL: string; DB_NAME: string }): ChildProcess {
  const proc = spawn('node', ['server.js'], {
    cwd: MINI_ORDERS_DIR,
    env: { ...process.env, PORT: String(APP_PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  return proc;
}

async function killMiniOrders(proc: ChildProcess) {
  proc.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  if (!proc.killed) proc.kill('SIGKILL');
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

async function main() {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-smoke-'));
  process.env.EASY_ENV_HOME = storeRoot;
  const store = FsStore.default();
  const ctx = buildContext(store);

  const PROJECT_NAME = 'mini-orders';
  const PROJECT_ROOT = MINI_ORDERS_DIR;

  let app: ChildProcess | null = null;
  let envId: string | null = null;

  try {
    // ----- 1. env.init: register the project's manifest with daemon --------
    const init = await runEnvInit(
      { projectName: PROJECT_NAME, projectRoot: PROJECT_ROOT, mongo: { image: 'mongo:6' }, redis: { image: 'redis:7-alpine' } },
      ctx,
    );
    assert(init.projectName === PROJECT_NAME, 'env.init should echo back projectName');
    console.log('  ✓ env.init');

    // ----- 2. env.up: spawn fresh isolated containers ----------------------
    console.log('  env.up: spawning fresh mongo + redis (Testcontainers)...');
    const up = await runEnvUp(
      { projectName: PROJECT_NAME, projectRoot: PROJECT_ROOT, setActive: true, withoutMongo: false, withoutRedis: false },
      ctx,
    );
    envId = up.envId;
    console.log(`  → envId=${envId}, mongo @${up.resolved.mongoUrl}, redis @${up.resolved.redisUrl}`);
    assert(up.status === 'ready', 'env.up should reach ready');
    assert(up.resolved.mongoUrl, 'mongo url present');
    assert(up.resolved.redisUrl, 'redis url present');
    console.log('  ✓ env.up');

    // ----- 3. env.list / env.status -----------------------------------------
    const list = await runEnvList({}, ctx);
    assert(list.activeEnvId === envId, 'active env should be the one we just created');
    assert(list.envs.find((e) => e.envId === envId), 'env should appear in list');
    const status = await runEnvStatus({ envId }, ctx);
    assert(status.health.mongoReachable === true, 'mongo reachable');
    assert(status.health.redisReachable === true, 'redis reachable');
    console.log('  ✓ env.list + env.status');

    // ----- 4. Start mini-orders against the new env -------------------------
    app = startMiniOrders({
      MONGO_URL: up.resolved.mongoUrl!,
      REDIS_URL: up.resolved.redisUrl!,
      DB_NAME: up.resolved.dbName ?? 'mini',
    });
    await waitForHealth();

    // ----- 5. db.seed: precondition data via easy-env ----------------------
    const seedRes = await runDbSeed(
      {
        envId,
        documents: {
          inventory: [{ _id: 'widget', sku: 'widget', stock: 100, updatedAt: new Date().toISOString() }],
        },
      },
      ctx,
    );
    assert(seedRes.inserted.inventory === 1, 'should have seeded 1 inventory doc');
    console.log('  ✓ db.seed');

    // ----- 6. scenario.replay using envId addressing ------------------------
    const replay = await runScenarioReplay(
      {
        envId,
        scenario: {
          id: 'smoke-replay',
          baseUrl: BASE_URL,
          capture: {
            mongo: { collections: ['orders', 'outbox_events', 'inventory', 'audit_log'] },
            redis: { keyPatterns: ['idemp:*'] },
          },
          preconditions: [],
          trigger: {
            method: 'POST',
            path: '/orders',
            body: {
              idempotencyKey: 'smoke-001',
              userId: 'alice',
              items: [{ sku: 'widget', qty: 3, unitPrice: 10 }],
            },
          },
          settle: { kind: 'outbox_drained', probePath: '/_debug/outbox-pending', pendingField: 'pending', timeoutMs: 3000, intervalMs: 100 },
        },
      },
      ctx,
    );
    assert(replay.settle?.settled, 'replay should reach quiescence');
    const replayDiff = await store.getDiff(replay.diffId);
    assert(replayDiff!.mongo.audit_log.added.length === 1, 'replay should produce audit_log');
    assert(replayDiff!.mongo.inventory.modified[0]?.changes.stock?.to === 97, 'stock should be 97');
    console.log('  ✓ scenario.replay (envId-addressed)');

    // ----- 7. db.find / db.update / db.delete -------------------------------
    const find1 = await runDbFind({ envId, collection: 'orders', query: {}, limit: 10 }, ctx);
    assert(find1.count === 1, 'should find one order');
    const orderId = (find1.docs[0] as Record<string, unknown>)._id as string;

    const upd = await runDbUpdate(
      { envId, collection: 'orders', filter: { _id: orderId }, update: { $set: { tag: 'smoke' } }, multi: false },
      ctx,
    );
    assert(upd.modifiedCount === 1, 'should update one order');
    const find2 = await runDbFind({ envId, collection: 'orders', query: { tag: 'smoke' }, limit: 1 }, ctx);
    assert(find2.count === 1, 'updated tag should be queryable');

    const del = await runDbDelete(
      { envId, collection: 'audit_log', filter: {}, multi: true },
      ctx,
    );
    assert(del.deletedCount === 1, 'should delete one audit_log entry');
    console.log('  ✓ db.find + db.update + db.delete');

    const ins = await runDbInsert(
      { envId, collection: 'audit_log', docs: [{ _id: 'manual-1', note: 'inserted via db.insert' }] },
      ctx,
    );
    assert(ins.insertedCount === 1, 'should insert one doc');
    console.log('  ✓ db.insert');

    // ----- 8. env.reset (fast path) ----------------------------------------
    await runEnvReset({ envId, recreate: false }, ctx);
    const afterReset = await runStateCapture(
      {
        envId,
        spec: { mongo: { collections: ['orders', 'audit_log', 'inventory'] } },
      },
      ctx,
    );
    assert(afterReset.summary.mongoCollections.orders === 0, 'orders should be empty after reset');
    assert(afterReset.summary.mongoCollections.audit_log === 0, 'audit_log should be empty after reset');
    console.log('  ✓ env.reset (fast)');

    // ----- 9. After reset: run scenario again to prove the env is reusable -
    await runDbSeed(
      {
        envId,
        documents: { inventory: [{ _id: 'widget', sku: 'widget', stock: 100, updatedAt: new Date().toISOString() }] },
      },
      ctx,
    );
    const replay2 = await runScenarioReplay(
      {
        envId,
        scenario: {
          id: 'smoke-replay-after-reset',
          baseUrl: BASE_URL,
          capture: {
            mongo: { collections: ['orders', 'audit_log', 'inventory'] },
            redis: { keyPatterns: ['idemp:*'] },
          },
          preconditions: [],
          trigger: {
            method: 'POST',
            path: '/orders',
            body: {
              idempotencyKey: 'smoke-002',
              userId: 'bob',
              items: [{ sku: 'widget', qty: 5, unitPrice: 10 }],
            },
          },
          settle: { kind: 'outbox_drained', probePath: '/_debug/outbox-pending', pendingField: 'pending', timeoutMs: 3000, intervalMs: 100 },
        },
      },
      ctx,
    );
    assert(replay2.settle?.settled, 'replay 2 should settle');
    const replay2Diff = await store.getDiff(replay2.diffId);
    assert(replay2Diff!.mongo.inventory.modified[0]?.changes.stock?.to === 95, 'stock should be 100→95 (qty 5)');
    console.log('  ✓ env reusable after reset');

    console.log(`\nSMOKE OK — artifacts at ${storeRoot}`);
  } finally {
    if (app) await killMiniOrders(app);
    if (envId) {
      console.log(`  cleaning up env ${envId}...`);
      await runEnvDown({ envId }, ctx).catch((e) => console.error('  env.down error:', e.message));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
