// Real-world test: drive easy-env-mcp against blog-backend (the legacy
// Koa+Apollo+Mongo 3.2-era project at /Users/jiangjack/Repos/company/blog-backend).
//
// Flow:
//   1. env.up — spawn mongo:4.2 + redis:7-alpine via Testcontainers
//   2. Start blog-backend as a child process, pointing ALL of its 5 mongo
//      env vars at the same easy-env mongo, just with different db names.
//   3. state.capture BEFORE (blogs, submitBehavior collections)
//   4. POST a GraphQL `insertBlog` mutation
//   5. state.capture AFTER, diff.compare
//   6. Assert that `blogs +1` and `submitBehavior +1` (the PoC-R1 prediction)
//   7. env.down + kill child process
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { FsStore } from '../../dist/src/store/fsStore.js';
import { buildContext } from '../../dist/src/core/context.js';
import { runEnvUp, runEnvDown, runEnvStatus } from '../../dist/src/tools/envLifecycle.js';
import { runEnvConfig } from '../../dist/src/tools/envConfig.js';
import { runStateCapture } from '../../dist/src/tools/stateCapture.js';
import { runDiffCompare } from '../../dist/src/tools/diffCompare.js';

const BLOG_BACKEND = process.env.BLOG_BACKEND_PATH ?? '/Users/jiangjack/Repos/company/blog-backend';
const APP_PORT = 3181;
const BASE_URL = `http://localhost:${APP_PORT}`;

process.env.EASY_ENV_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-blog-'));
process.env.EASY_ENV_CONFIG = path.join(BLOG_BACKEND, 'easy-env.json');

const store = FsStore.default();
const ctx = buildContext(store);

let envId = null;
let child = null;

function log(label, ...rest) {
  console.log(`\n${label}`, ...rest);
}

async function waitForGraphql(timeoutMs = 30_000) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (res.ok) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`blog-backend /graphql never became reachable: ${lastErr}`);
}

try {
  // ----- 1. env.config sanity ---------------------------------------------
  log('STEP 1 — env.config');
  const cfg = await runEnvConfig({ probeVersions: false });
  console.log('  loaded:', cfg.configPath);

  // ----- 2. env.up --------------------------------------------------------
  log('STEP 2 — env.up (Testcontainers spawns mongo:4.2 + redis:7-alpine)');
  const up = await runEnvUp({ setActive: true, withoutMongo: false, withoutRedis: false }, ctx);
  envId = up.envId;
  console.log('  envId:', envId);
  console.log('  mongo:', up.resolved.mongoUrl);
  console.log('  redis:', up.resolved.redisUrl);

  // Strip mongodb:// prefix to compose db-specific URLs.
  const mongoBase = up.resolved.mongoUrl.replace(/\/$/, '');
  const redisUrl = new URL(up.resolved.redisUrl);

  // ----- 3. Start blog-backend pointing at the easy-env containers -------
  log('STEP 3 — starting blog-backend (dist/index.js) with 5 mongo URLs → same server, different dbs');
  child = spawn('node', ['dist/index.js'], {
    cwd: BLOG_BACKEND,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'development',
      // All 5 mongo connections collapse onto the easy-env mongo, separated by db name.
      MONGO_URL: `${mongoBase}/blog`,
      MONGO_BG: `${mongoBase}/paper-king-developing`,
      MONGO_BP: `${mongoBase}/dodgy-dove`,
      MONGO_PARROT: `${mongoBase}/parrot`,
      MONGO_TRAIN_URL: `${mongoBase}/train`,
      // Redis
      REDIS_HOST: redisUrl.hostname,
      REDIS_PORT: redisUrl.port,
      REDIS_PWD: '',
      // Auth / external (lenient — most paths don't enforce these in the mutations we care about)
      JWT_SECRET: 'easy-env-test',
      WS_PORT: '3082',
      NIBBANA_TOKEN: 'test',
      NIBBANA_SECRET_KEY: 'test',
      PIGEON_URI: 'http://localhost:0',  // unreachable but boot shouldn't hard-depend
      RIGHTEOUS_RAVEN_URL: 'http://localhost:0',
      RIGHTEOUS_RAVEN_ID: 'test',
      RIGHTEOUS_RAVEN_KEY: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(`  [app] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`  [app:err] ${b}`));

  log('STEP 4 — waiting for /graphql to become reachable');
  await waitForGraphql();
  console.log('  blog-backend graphql is up.');

  // ----- 5. snapshot BEFORE -----------------------------------------------
  log('STEP 5 — state.capture BEFORE');
  // Note: blog-backend's MONGO_URL points at /blog db, so easy-env's
  // captureBackends must target the same db name.
  const captureBackends = { mongoUrl: up.resolved.mongoUrl, redisUrl: up.resolved.redisUrl, dbName: 'blog' };
  const before = await runStateCapture(
    { envId, spec: { mongo: { collections: ['blogs', 'submitBehavior'] }, redis: { keyPatterns: ['*'] } }, backends: captureBackends },
    ctx,
  );
  console.log('  snapshotId:', before.snapshotId, 'summary:', before.summary);

  // ----- 6. fire the insertBlog mutation ---------------------------------
  log('STEP 6 — POST /graphql insertBlog');
  // Blog return type doesn't have "state" (only BlogInput does). Select fields
  // we know exist on Blog: _id and title.
  const mutation = `
    mutation InsertBlog($blog: BlogInput) {
      insertBlog(blog: $blog) { _id title }
    }
  `;
  const variables = {
    blog: {
      title: 'easy-env real-world smoke test',
      avatar: 'https://example.com/avatar.jpg',
      content: ['Hello from easy-env.'],
      state: 'DRAFT',
      author: 'easy-env-tester',
    },
  };
  const gqlRes = await fetch(`${BASE_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: mutation, variables }),
  });
  const gqlBody = await gqlRes.json();
  console.log('  gql response:', JSON.stringify(gqlBody, null, 2));

  // ----- 7. snapshot AFTER + diff ----------------------------------------
  log('STEP 7 — state.capture AFTER + diff.compare');
  const after = await runStateCapture(
    { envId, spec: { mongo: { collections: ['blogs', 'submitBehavior'] }, redis: { keyPatterns: ['*'] } }, backends: captureBackends },
    ctx,
  );
  console.log('  after summary:', after.summary);

  const diff = await runDiffCompare(
    {
      beforeSnapshotId: before.snapshotId,
      afterSnapshotId: after.snapshotId,
      noisePolicy: { ignoreTimestampFields: ['createdAt', 'updatedAt', 'publishedAt'], ignoreRedisTtlDrift: true },
    },
    ctx,
  );
  console.log('\n  diff.compare result:');
  for (const [name, d] of Object.entries(diff.mongo)) {
    console.log(`    mongo.${name}: +${d.added.length} ~${d.modified.length} -${d.removed.length}`);
  }

  // ----- 8. assert --------------------------------------------------------
  log('STEP 8 — assertions vs PoC R1 prediction');
  const addedBlogs = diff.mongo.blogs?.added.length ?? 0;
  const addedAudit = diff.mongo.submitBehavior?.added.length ?? 0;
  const ok = addedBlogs === 1 && addedAudit === 1;
  console.log(`  blogs +${addedBlogs} (expected 1), submitBehavior +${addedAudit} (expected 1) — ${ok ? '✅ PASS' : '❌ FAIL'}`);

  if (ok) {
    console.log('\n✅ end-to-end real-world test SUCCEEDED against blog-backend');
    console.log('   matches the PoC R1 prediction: insertBlog → blogs +1 + submitBehavior +1');
  } else {
    console.log('\n⚠ unexpected diff shape — check the gql response above for errors');
    process.exitCode = 1;
  }
} catch (e) {
  console.error('\nFATAL:', e);
  process.exitCode = 1;
} finally {
  if (child && !child.killed) {
    console.log('\n[cleanup] killing blog-backend...');
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!child.killed) child.kill('SIGKILL');
  }
  if (envId) {
    console.log('[cleanup] env.down', envId);
    await runEnvDown({ envId }, ctx).catch((e) => console.error('  env.down err:', e.message));
  }
}
