// Docker-backed integration test for MongoDB traffic monitoring.
// Spawns a real mongo via env.up, then exercises the full loop:
//   discover targets -> persist selection -> enable profiler -> run ops on
//   TWO databases -> tail -> assert only the SELECTED db's ops were captured
//   -> disable (profiling back to 0) -> env.down (monitor fully torn down).
//
// Requires Docker. Run with: npm run build && node dist/test/traffic-monitor.js
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MongoClient } from 'mongodb';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { runEnvInit } from '../src/tools/envInit.js';
import { runEnvUp, runEnvDown, EnvUpInput } from '../src/tools/envLifecycle.js';
import { runMonitorSet } from '../src/tools/monitor.js';
import {
  runTrafficTargets,
  runTrafficEnable,
  runTrafficDisable,
  runTrafficTail,
} from '../src/tools/traffic.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`TRAFFIC MONITOR FAIL: ${msg}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-traffic-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function main() {
  await withTempHome(async () => {
    const ctx = buildContext(FsStore.default());
    const projectName = 'traffic-fixture';
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-traffic-proj-'));

    // Declare + spawn a mongo-only env.
    await runEnvInit({ projectName, projectRoot, mongo: { dbName: 'db_alpha' } }, ctx);
    const up = await runEnvUp(EnvUpInput.parse({ projectName, projectRoot, seed: 'skip' }), ctx);
    const envId = up.envId;
    const mongoUrl = up.resolved.mongoUrl;
    assert(typeof mongoUrl === 'string', 'env.up returned a mongoUrl');
    console.log(`  ✓ env up: ${envId} @ ${mongoUrl}`);

    const client = await MongoClient.connect(mongoUrl!);
    try {
      // Create two databases so both are discoverable as monitor targets.
      await client.db('db_alpha').collection('orders').insertOne({ seed: true });
      await client.db('db_beta').collection('widgets').insertOne({ seed: true });

      // env.up label carries projectRoot (the blocker fix) so monitor.set can
      // resolve via env labels; verify it directly too.
      const env = await ctx.registry.get(envId);
      assert(env?.labels['easy-env.project'] === projectName, 'project label set');
      assert(env?.labels['easy-env.project-root'] === projectRoot, 'project-root label set (blocker fix)');
      console.log('  ✓ env labels carry projectName + projectRoot');

      // Discover targets — both user dbs present, nothing selected/enabled yet.
      let targets = await runTrafficTargets({ envId }, ctx);
      assert(targets.available.includes('db_alpha') && targets.available.includes('db_beta'), `both dbs discovered; got ${JSON.stringify(targets.available)}`);
      assert(targets.selected.length === 0 && targets.enabled === false, 'nothing selected/enabled initially');
      console.log(`  ✓ targets discovered: ${JSON.stringify(targets.available)}`);

      // Select ONLY db_alpha, then enable.
      await runMonitorSet({ projectName, projectRoot, databases: ['db_alpha'] }, ctx);
      targets = await runTrafficTargets({ envId }, ctx);
      assert(JSON.stringify(targets.selected) === JSON.stringify(['db_alpha']), 'selection persisted to db_alpha');

      const en = await runTrafficEnable({ envId }, ctx);
      assert(en.status.enabled === true && en.status.databases.includes('db_alpha'), `enabled for db_alpha; got ${JSON.stringify(en.status)}`);
      console.log('  ✓ selection persisted + profiler enabled for db_alpha only');

      // Generate traffic on BOTH dbs. Only db_alpha should be captured.
      await client.db('db_alpha').collection('orders').insertOne({ marker: 'ALPHA', n: 1 });
      await client.db('db_alpha').collection('orders').find({ n: 1 }).toArray();
      await client.db('db_alpha').collection('orders').updateOne({ n: 1 }, { $set: { touched: true } });
      await client.db('db_beta').collection('widgets').insertOne({ marker: 'BETA', n: 2 });
      await client.db('db_beta').collection('widgets').find({ n: 2 }).toArray();

      // Let the poller (400ms) pick up the profile entries.
      await sleep(1800);

      const tail = await runTrafficTail({ envId, limit: 200 }, ctx);
      console.log(`  · captured ${tail.entries.length} ops: ${tail.entries.map((e) => `${e.db}.${e.collection}:${e.op}`).join(', ')}`);
      assert(tail.entries.length > 0, 'captured at least one op on db_alpha');
      assert(tail.entries.every((e) => e.db === 'db_alpha'), 'ONLY db_alpha captured — db_beta must be invisible');
      assert(tail.entries.some((e) => e.collection === 'orders'), 'captured ops on the orders collection');
      assert(!tail.entries.some((e) => e.command.includes('BETA') || e.db === 'db_beta'), 'no db_beta traffic leaked into the buffer');
      assert(tail.status.enabled === true, 'tail reports enabled');
      console.log('  ✓ only the selected db (db_alpha) was captured; db_beta invisible');

      // Disable — profiling level resets to 0 on db_alpha, buffer retained.
      const dis = await runTrafficDisable({ envId }, ctx);
      assert(dis.status.enabled === false, 'disabled');
      const lvl = (await client.db('db_alpha').command({ profile: -1 })) as { was?: number };
      assert(lvl.was === 0, `profiling level reset to 0; got ${lvl.was}`);
      const tailAfter = await runTrafficTail({ envId, limit: 200 }, ctx);
      assert(tailAfter.entries.length > 0, 'buffer retained after disable');
      console.log('  ✓ disable resets profiling level to 0 and keeps the buffer');
    } finally {
      await client.close().catch(() => undefined);
    }

    // env.down tears the monitor down fully (no leaked client/buffer).
    await runEnvDown({ envId }, ctx);
    const st = ctx.traffic.status(envId);
    assert(st.enabled === false && st.buffered === 0, `monitor fully torn down on env.down; got ${JSON.stringify(st)}`);
    console.log('  ✓ env.down tore down the monitor (buffer + client cleared)');

    // Tombstone: a request that raced env.down must NOT resurrect a monitor
    // for the dead envId (would leak a client + spinning poller). enable
    // returns a disabled no-op without reconnecting.
    const resurrect = await ctx.traffic.enable(envId, mongoUrl!, ['db_alpha']);
    const st2 = ctx.traffic.status(envId);
    assert(resurrect.enabled === false && st2.enabled === false && st2.buffered === 0, `enable after env.down must be a no-op; got ${JSON.stringify(resurrect)}`);
    console.log('  ✓ enable after env.down is a no-op (tombstone, no resurrection)');

    await fs.rm(projectRoot, { recursive: true, force: true });
  });
  console.log('traffic-monitor: ALL PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
