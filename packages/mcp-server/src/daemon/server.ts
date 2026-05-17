// Hono HTTP app exposing tool calls + resource endpoints.
// See docs/DAEMON_API.md for the API contract.
import { Hono, type Context } from 'hono';
import { ZodError } from 'zod';

import type { ToolContext } from '../core/context.js';
import { findTool, TOOL_REGISTRY } from '../tools/registry.js';
import { loadConfig } from '../core/config.js';
import { resolveWebDist, staticSpa } from './static.js';
import { ActivityLog } from './activity.js';

const VERSION = '0.1.0-alpha';

export function buildApp(ctx: ToolContext, startedAt: number): Hono {
  const app = new Hono();
  const activity = new ActivityLog();

  // Wrap a tool invocation with activity recording. Used by both the
  // generic /api/tools/:name endpoint and the resource endpoints below
  // (so the Web UI's GET-style requests show up in activity too).
  const invokeTool = async (toolName: string, args: unknown): Promise<unknown> => {
    const tool = findTool(toolName);
    if (!tool) throw new Error(`unknown tool: ${toolName}`);
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    try {
      const result = await tool.run(args, ctx);
      activity.record({
        tool: toolName,
        startedAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        status: 'ok',
      });
      return result;
    } catch (e) {
      activity.record({
        tool: toolName,
        startedAt: startedAtIso,
        durationMs: Date.now() - startedAtMs,
        status: 'error',
        errorMessage: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  };

  // ── meta ──────────────────────────────────────────────────────────────────
  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
    }),
  );

  app.get('/api/activity', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
    return c.json({ entries: activity.recent(limit), stats: activity.stats() });
  });

  app.get('/api/config', (c) => {
    const loaded = loadConfig();
    return c.json({ configPath: loaded.configPath, config: loaded.config });
  });

  app.get('/api/tools', (c) =>
    c.json({
      tools: TOOL_REGISTRY.map((t) => ({ name: t.name, description: t.description })),
    }),
  );

  // ── generic tool dispatch (MCP thin client uses this) ─────────────────────
  app.post('/api/tools/:name', async (c) => {
    const name = c.req.param('name');
    if (!findTool(name)) {
      return c.json(
        { error: { code: 'unknown-tool', message: `unknown tool: ${name}` } },
        404,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    try {
      const result = await invokeTool(name, body ?? {});
      return c.json(result);
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── envs resource endpoints (Web UI) ──────────────────────────────────────
  app.get('/api/envs', async (c) => {
    try {
      return c.json(await invokeTool('env.list', {}));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/envs/:envId', async (c) => {
    try {
      return c.json(await invokeTool('env.status', { envId: c.req.param('envId') }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── snapshots / diffs resource endpoints ──────────────────────────────────
  app.get('/api/snapshots', async (c) => {
    try {
      const items = await ctx.store.listSnapshots();
      return c.json({ snapshots: items });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/snapshots/:id', async (c) => {
    try {
      const snap = await ctx.store.getSnapshot(c.req.param('id'));
      if (!snap) return c.json({ error: { code: 'not-found', message: 'snapshot not found' } }, 404);
      return c.json(snap);
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/diffs', async (c) => {
    try {
      const items = await ctx.store.listDiffs();
      return c.json({ diffs: items });
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.get('/api/diffs/:id', async (c) => {
    try {
      const diff = await ctx.store.getDiff(c.req.param('id'));
      if (!diff) return c.json({ error: { code: 'not-found', message: 'diff not found' } }, 404);
      return c.json(diff);
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── vars resource endpoints (Web UI) ──────────────────────────────────────
  app.get('/api/vars', async (c) => {
    try {
      return c.json(await invokeTool('vars.list', {}));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.put('/api/vars/:name', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
      return c.json(await invokeTool('vars.set', { name: c.req.param('name'), value: body.value ?? null }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.delete('/api/vars/:name', async (c) => {
    try {
      return c.json(await invokeTool('vars.unset', { name: c.req.param('name') }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post('/api/vars/init', async (c) => {
    try {
      const dryRun = c.req.query('dryRun') !== '0' && c.req.query('dryRun') !== 'false';
      return c.json(await invokeTool('vars.init', { dryRun }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  app.post('/api/env/init', async (c) => {
    try {
      const dryRun = c.req.query('dryRun') !== '0' && c.req.query('dryRun') !== 'false';
      return c.json(await invokeTool('env.init', { dryRun }));
    } catch (e) {
      return handleError(c, e);
    }
  });

  // ── static SPA (after API routes, so /api/* never falls through to it) ───
  const webDist = resolveWebDist();
  if (webDist) {
    app.use('*', staticSpa(webDist));
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: { code: 'not-found', message: `no route for ${c.req.method} ${c.req.path}` } }, 404);
    }
    return c.text(webDist ? 'not found' : 'Web UI not built. Run `npm run build --workspace easy-env-web`.', 404);
  });

  return app;
}

export function webDistAvailable(): boolean {
  return resolveWebDist() !== null;
}

function handleError(c: Context, e: unknown) {
  if (e instanceof ZodError) {
    return c.json(
      { error: { code: 'invalid-input', message: 'input validation failed', details: e.flatten() } },
      400,
    );
  }
  const msg = e instanceof Error ? e.message : String(e);
  // Recognize common application errors via message patterns.
  if (/not found/i.test(msg)) {
    return c.json({ error: { code: 'not-found', message: msg } }, 404);
  }
  return c.json({ error: { code: 'internal', message: msg } }, 500);
}
