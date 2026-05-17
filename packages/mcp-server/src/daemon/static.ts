// Lightweight static-file middleware for serving the built SPA. Falls back
// to index.html for unknown paths so client-side routing works (SPA mode).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MiddlewareHandler } from 'hono';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Resolve the SPA dist directory:
 * 1. `EASY_ENV_WEB_DIST` env var if set
 * 2. `<repo>/packages/web/dist` relative to this compiled module
 * Returns null if neither exists (dev mode without a build).
 */
export function resolveWebDist(): string | null {
  const override = process.env.EASY_ENV_WEB_DIST;
  if (override) {
    return fsSync.existsSync(override) ? path.resolve(override) : null;
  }
  // This file at runtime: packages/mcp-server/dist/src/daemon/static.js
  // Web dist:             packages/web/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  const guess = path.resolve(here, '..', '..', '..', '..', 'web', 'dist');
  return fsSync.existsSync(guess) ? guess : null;
}

export function staticSpa(distRoot: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    if (c.req.path.startsWith('/api/')) return next();

    const requested = c.req.path === '/' ? '/index.html' : c.req.path;
    const safePath = path.posix.normalize(requested);
    if (safePath.includes('..')) return next();

    const candidate = path.join(distRoot, safePath);
    const file = (await tryRead(candidate)) ?? (await tryRead(path.join(distRoot, 'index.html')));
    if (!file) return next();

    c.header('content-type', mimeFor(file.path));
    if (file.path.endsWith('index.html')) {
      c.header('cache-control', 'no-cache');
    } else {
      c.header('cache-control', 'public, max-age=3600');
    }
    return c.body(new Uint8Array(file.body));
  };
}

async function tryRead(p: string): Promise<{ path: string; body: Buffer } | null> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) return null;
    const body = await fs.readFile(p);
    return { path: p, body };
  } catch {
    return null;
  }
}
