// Suggest fixed host ports for the project's mongo and redis containers.
// Looks at any docker-compose.* in the project root and tries to reuse
// whichever host ports the user has historically run with — that way
// existing tooling, IDE configs, and bookmarks keep working.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface PortSuggestion {
  mongo: { port: number; source: 'compose' | 'default'; evidence?: string };
  redis: { port: number; source: 'compose' | 'default'; evidence?: string };
}

// "Off-the-beaten-path" defaults that almost never collide with the system
// services or other testcontainers running on this host.
const DEFAULT_MONGO_PORT = 27818;
const DEFAULT_REDIS_PORT = 6480;

const COMPOSE_FILENAMES = [
  'docker-compose.yaml',
  'docker-compose.yml',
  'docker-compose.local.yml',
  'docker-compose.local.yaml',
  'docker-compose.dev.yml',
  'docker-compose.dev.yaml',
  'compose.yaml',
  'compose.yml',
];

export async function suggestPorts(projectRoot: string): Promise<PortSuggestion> {
  const fromCompose = await scanComposeFiles(projectRoot);
  return {
    mongo: fromCompose.mongo ?? { port: DEFAULT_MONGO_PORT, source: 'default' },
    redis: fromCompose.redis ?? { port: DEFAULT_REDIS_PORT, source: 'default' },
  };
}

interface ComposePorts {
  mongo?: { port: number; source: 'compose'; evidence: string };
  redis?: { port: number; source: 'compose'; evidence: string };
}

async function scanComposeFiles(projectRoot: string): Promise<ComposePorts> {
  const out: ComposePorts = {};
  for (const file of COMPOSE_FILENAMES) {
    const p = path.join(projectRoot, file);
    if (!fsSync.existsSync(p)) continue;
    let parsed: unknown;
    try {
      parsed = yaml.load(await fs.readFile(p, 'utf8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const services = (parsed as { services?: unknown }).services;
    if (typeof services !== 'object' || services === null) continue;

    for (const [serviceName, raw] of Object.entries(services as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const svc = raw as { image?: unknown; ports?: unknown };
      const image = typeof svc.image === 'string' ? svc.image.toLowerCase() : '';
      const kind: 'mongo' | 'redis' | null =
        image.startsWith('mongo') ? 'mongo' :
        image.startsWith('redis') ? 'redis' :
        null;
      if (!kind) continue;
      // Don't overwrite a port we already extracted from an earlier compose
      // file — keep the first one we found (caller iterates in priority order).
      if (out[kind]) continue;
      const containerPort = kind === 'mongo' ? 27017 : 6379;
      const hostPort = extractHostPort(svc.ports, containerPort);
      if (hostPort) {
        out[kind] = {
          port: hostPort,
          source: 'compose',
          evidence: `${file}#${serviceName}.ports`,
        };
      }
    }
    if (out.mongo && out.redis) break;
  }
  return out;
}

// Compose `ports:` is an array of "<host>:<container>" strings or {target,published} objects.
// We pull the host port that maps to the canonical container port.
function extractHostPort(ports: unknown, containerPort: number): number | undefined {
  if (!Array.isArray(ports)) return undefined;
  for (const entry of ports) {
    if (typeof entry === 'string') {
      // Forms: "8080", "8080:80", "127.0.0.1:8080:80", "8080:80/tcp"
      const stripped = entry.replace(/\/(tcp|udp)$/, '');
      const parts = stripped.split(':');
      // host:container | ip:host:container | container
      let host: string | undefined;
      let container: string | undefined;
      if (parts.length === 1) { container = parts[0]; }
      else if (parts.length === 2) { host = parts[0]; container = parts[1]; }
      else if (parts.length >= 3) { host = parts[1]; container = parts[2]; }
      if (container && Number(container) === containerPort && host) {
        const n = Number(host);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } else if (entry && typeof entry === 'object') {
      const o = entry as { published?: number | string; target?: number };
      if (o.target === containerPort && o.published !== undefined) {
        const n = Number(o.published);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return undefined;
}
