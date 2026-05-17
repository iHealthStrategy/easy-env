import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ManagedEnv } from '../schemas/env.js';

// Registry of envs managed by THIS easy-env process. Disk-persisted so
// `env.list` survives MCP server restarts. The activeEnvId pointer tells
// other tools which env to default to when no envId is passed.

const REGISTRY_FILE = 'envs/index.json';
const ENV_DIR = 'envs';
const ACTIVE_FILE = 'envs/.active';

export interface RegistrySnapshot {
  envs: ManagedEnv[];
  activeEnvId: string | null;
}

function envHome(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME  // legacy
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export class EnvRegistry {
  constructor(private root: string = envHome()) {}

  private envPath(envId: string): string {
    return path.join(this.root, ENV_DIR, `${envId}.json`);
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(path.join(this.root, ENV_DIR), { recursive: true });
  }

  async save(env: ManagedEnv): Promise<void> {
    await this.ensureRoot();
    await fs.writeFile(this.envPath(env.envId), JSON.stringify(env, null, 2));
  }

  async get(envId: string): Promise<ManagedEnv | null> {
    try {
      const raw = await fs.readFile(this.envPath(envId), 'utf8');
      return ManagedEnv.parse(JSON.parse(raw));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async list(): Promise<ManagedEnv[]> {
    await this.ensureRoot();
    const files = await fs.readdir(path.join(this.root, ENV_DIR));
    const out: ManagedEnv[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = await fs.readFile(path.join(this.root, ENV_DIR, f), 'utf8');
        out.push(ManagedEnv.parse(JSON.parse(raw)));
      } catch {
        // skip corrupt entries — they should not block listing.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(envId: string): Promise<void> {
    try {
      await fs.unlink(this.envPath(envId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const active = await this.getActive();
    if (active === envId) await this.clearActive();
  }

  async setActive(envId: string): Promise<void> {
    await this.ensureRoot();
    await fs.writeFile(path.join(this.root, ACTIVE_FILE), envId, 'utf8');
  }

  async getActive(): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(this.root, ACTIVE_FILE), 'utf8');
      return raw.trim() || null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async clearActive(): Promise<void> {
    try {
      await fs.unlink(path.join(this.root, ACTIVE_FILE));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }

  // Sync helpers used in places like ensure-root-on-construction.
  rootSync(): string {
    if (!fsSync.existsSync(this.root)) fsSync.mkdirSync(this.root, { recursive: true });
    return this.root;
  }
}
