// Scan a project for environment variable references. Used by vars.init
// to bootstrap the `variables` declaration in easy-env.json.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { isContainerManagedName } from './vars.js';

export interface VarCandidate {
  name: string;
  evidence: string[];
}

const SCAN_DIRS = ['src', 'lib', 'app', 'server', 'api', 'packages'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const MAX_FILES = 500;
const MAX_FILE_BYTES = 1_000_000;

const NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const PROCESS_ENV_REGEX = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
// Matches the destructure form: `{ FOO, BAR = 'default' } = process.env`
const DESTRUCTURE_REGEX = /\{([^{}]+)\}\s*=\s*process\.env\b/g;

interface ScanOptions {
  projectRoot: string;
}

export async function scanProjectVars(opts: ScanOptions): Promise<VarCandidate[]> {
  const candidates = new Map<string, Set<string>>();
  const addCitation = (name: string, citation: string) => {
    if (!NAME_REGEX.test(name)) return;
    if (isContainerManagedName(name)) return;
    if (!candidates.has(name)) candidates.set(name, new Set());
    candidates.get(name)!.add(citation);
  };

  await scanDotenvFiles(opts.projectRoot, addCitation);
  await scanDockerCompose(opts.projectRoot, addCitation);
  await scanSourceCode(opts.projectRoot, addCitation);

  return [...candidates.entries()]
    .map(([name, set]) => ({ name, evidence: [...set] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── .env / .env.example ────────────────────────────────────────────────────

async function scanDotenvFiles(root: string, add: (n: string, c: string) => void): Promise<void> {
  for (const file of ['.env', '.env.example', '.env.local', '.env.development']) {
    const p = path.join(root, file);
    if (!fsSync.existsSync(p)) continue;
    const text = await fs.readFile(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
      if (m) add(m[1], `found in ${file}`);
    }
  }
}

// ── docker-compose.yaml ────────────────────────────────────────────────────

async function scanDockerCompose(root: string, add: (n: string, c: string) => void): Promise<void> {
  for (const file of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
    const p = path.join(root, file);
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
      const svc = raw as { environment?: unknown; env_file?: unknown };

      // environment can be a map or a list of "KEY=value" / "KEY"
      const env = svc.environment;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        for (const key of Object.keys(env)) add(key, `${file}#${serviceName}.environment`);
      } else if (Array.isArray(env)) {
        for (const item of env) {
          if (typeof item !== 'string') continue;
          const name = item.split('=')[0].trim();
          add(name, `${file}#${serviceName}.environment`);
        }
      }

      // env_file: a string or array of paths to dotenv-style files
      const envFile = svc.env_file;
      const filesToRead = Array.isArray(envFile)
        ? envFile.filter((x): x is string => typeof x === 'string')
        : typeof envFile === 'string'
          ? [envFile]
          : [];
      for (const relPath of filesToRead) {
        const abs = path.resolve(root, relPath);
        if (!fsSync.existsSync(abs)) continue;
        const text = await fs.readFile(abs, 'utf8');
        for (const line of text.split('\n')) {
          const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
          if (m) add(m[1], `${file}#${serviceName}.env_file:${relPath}`);
        }
      }
    }
  }
}

// ── source code grep for process.env.X ─────────────────────────────────────

async function scanSourceCode(root: string, add: (n: string, c: string) => void): Promise<void> {
  let filesSeen = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || filesSeen >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (filesSeen >= MAX_FILES) return;
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === 'build') {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(full, depth + 1);
      } else if (ent.isFile() && SCAN_EXTENSIONS.has(path.extname(ent.name))) {
        filesSeen += 1;
        let buf: Buffer;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          buf = await fs.readFile(full);
        } catch {
          continue;
        }
        const text = buf.toString('utf8');
        const rel = path.relative(root, full);
        for (const match of text.matchAll(PROCESS_ENV_REGEX)) {
          add(match[1], `${rel}`);
        }
        for (const match of text.matchAll(DESTRUCTURE_REGEX)) {
          for (const part of match[1].split(',')) {
            // Strip default values, rename syntax (FOO: bar), and whitespace.
            const name = part.split('=')[0].split(':')[0].trim();
            if (name) add(name, `${rel}`);
          }
        }
      }
    }
  };

  // Try common source dirs first; fall back to scanning project root.
  const targets = SCAN_DIRS.map((d) => path.join(root, d)).filter((p) => fsSync.existsSync(p));
  if (targets.length === 0) targets.push(root);
  for (const target of targets) {
    if (filesSeen >= MAX_FILES) break;
    await visit(target, 0);
  }
}
