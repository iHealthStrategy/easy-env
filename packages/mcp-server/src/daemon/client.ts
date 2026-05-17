// HTTP client used by the MCP thin server (and tests) to talk to the daemon.
// Also handles auto-starting a detached daemon when none is running.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { daemonBaseUrl } from './config.js';

const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_MS = 100;

export class DaemonClient {
  constructor(private baseUrl: string = daemonBaseUrl()) {}

  async health(): Promise<{ ok: boolean; version: string; uptimeMs: number } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return null;
      return (await res.json()) as { ok: boolean; version: string; uptimeMs: number };
    } catch {
      return null;
    }
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/tools/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const err = (body && typeof body === 'object' && 'error' in body)
        ? (body as { error: { message: string } }).error
        : { message: text || res.statusText };
      throw new Error(`daemon tool '${name}' failed (${res.status}): ${err.message}`);
    }
    return body;
  }

  async ensureRunning(): Promise<void> {
    if (await this.health()) return;
    await spawnDaemon();
    await this.waitForHealthy();
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.health()) return;
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
    throw new Error(`daemon did not become healthy within ${HEALTH_TIMEOUT_MS}ms at ${this.baseUrl}`);
  }
}

async function spawnDaemon(): Promise<void> {
  // Locate the daemon entry relative to this compiled file:
  // dist/src/daemon/client.js → dist/src/daemon/start.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, 'start.js');
  if (!fs.existsSync(entry)) {
    throw new Error(`daemon entry not found at ${entry}; did you build the package?`);
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
