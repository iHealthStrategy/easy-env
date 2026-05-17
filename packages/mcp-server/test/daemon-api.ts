// Daemon HTTP API contract test. Starts the daemon in-process (via
// buildApp on a random port), then exercises the resource endpoints and
// the generic tool dispatch. Does NOT require Docker — we only call tools
// that don't touch containers (env.config, env.list).
import { serve, type ServerType } from '@hono/node-server';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { FsStore } from '../src/store/fsStore.js';
import { buildContext } from '../src/core/context.js';
import { buildApp } from '../src/daemon/server.js';

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-env-daemon-test-'));
  process.env.EASY_ENV_HOME = home;
  try {
    return await fn(home);
  } finally {
    delete process.env.EASY_ENV_HOME;
    await fs.rm(home, { recursive: true, force: true });
  }
}

function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const ctx = buildContext(FsStore.default());
  const app = buildApp(ctx, Date.now());
  return new Promise((resolve, reject) => {
    let server: ServerType;
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, (info) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.on('error', reject);
  });
}

async function expect(cond: boolean, msg: string): Promise<void> {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main(): Promise<void> {
  await withTempHome(async () => {
    const { baseUrl, close } = await startServer();
    try {
      // health
      {
        const r = await fetch(`${baseUrl}/api/health`).then((r) => r.json()) as { ok: boolean; version: string };
        await expect(r.ok === true, 'health.ok should be true');
        await expect(typeof r.version === 'string', 'health.version should be string');
        console.log('  ✓ GET /api/health');
      }

      // tool listing
      {
        const r = await fetch(`${baseUrl}/api/tools`).then((r) => r.json()) as { tools: Array<{ name: string }> };
        await expect(r.tools.length === 15, `expected 15 tools, got ${r.tools.length}`);
        console.log('  ✓ GET /api/tools (15 tools)');
      }

      // env.config via generic dispatch
      {
        const r = await fetch(`${baseUrl}/api/tools/env.config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.ok, `env.config returned ${r.status}`);
        const body = await r.json() as Record<string, unknown>;
        await expect('configPath' in body || 'config' in body || 'resolved' in body, 'env.config payload looks empty');
        console.log('  ✓ POST /api/tools/env.config');
      }

      // env.list resource endpoint (no envs yet)
      {
        const r = await fetch(`${baseUrl}/api/envs`).then((r) => r.json()) as { envs: unknown[]; activeEnvId: string | null };
        await expect(Array.isArray(r.envs), 'envs should be array');
        await expect(r.envs.length === 0, 'expected no envs in empty home');
        await expect(r.activeEnvId === null, 'no active env expected');
        console.log('  ✓ GET /api/envs (empty)');
      }

      // snapshots / diffs lists (empty)
      {
        const s = await fetch(`${baseUrl}/api/snapshots`).then((r) => r.json()) as { snapshots: unknown[] };
        await expect(Array.isArray(s.snapshots) && s.snapshots.length === 0, 'expected empty snapshots');
        const d = await fetch(`${baseUrl}/api/diffs`).then((r) => r.json()) as { diffs: unknown[] };
        await expect(Array.isArray(d.diffs) && d.diffs.length === 0, 'expected empty diffs');
        console.log('  ✓ GET /api/snapshots, /api/diffs (empty)');
      }

      // unknown tool → 404 + structured error
      {
        const r = await fetch(`${baseUrl}/api/tools/no.such`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.status === 404, `expected 404, got ${r.status}`);
        const body = await r.json() as { error: { code: string; message: string } };
        await expect(body.error.code === 'unknown-tool', `unexpected error code: ${body.error.code}`);
        console.log('  ✓ POST /api/tools/no.such → 404 unknown-tool');
      }

      // invalid input → 400 with zod details (env.status requires envId)
      {
        const r = await fetch(`${baseUrl}/api/tools/env.status`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        await expect(r.status === 400, `expected 400, got ${r.status}`);
        const body = await r.json() as { error: { code: string } };
        await expect(body.error.code === 'invalid-input', `unexpected error code: ${body.error.code}`);
        console.log('  ✓ POST /api/tools/env.status without envId → 400 invalid-input');
      }

      // missing resource → 404
      {
        const r = await fetch(`${baseUrl}/api/snapshots/does-not-exist`);
        await expect(r.status === 404, `expected 404, got ${r.status}`);
        console.log('  ✓ GET /api/snapshots/:missing → 404');
      }
    } finally {
      await close();
    }
  });
  console.log('DAEMON API OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
