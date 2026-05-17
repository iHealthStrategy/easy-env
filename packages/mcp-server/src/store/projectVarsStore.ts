// Per-project variable values. One JSON blob per project name, owned
// exclusively by the daemon. Web UI mutates it through `vars.set`;
// the file is not meant to be hand-edited.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type VarValue = string | number | boolean | null;
export type VarsMap = Record<string, VarValue>;

function homeRoot(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export class ProjectVarsStore {
  constructor(private root: string = path.join(homeRoot(), 'projects')) {}

  private fileFor(name: string): string {
    return path.join(this.root, name, 'vars.json');
  }

  async readAll(name: string): Promise<VarsMap> {
    const f = this.fileFor(name);
    try {
      const raw = await fs.readFile(f, 'utf8');
      const parsed = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as VarsMap;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
  }

  async writeAll(name: string, vars: VarsMap): Promise<void> {
    const f = this.fileFor(name);
    await fs.mkdir(path.dirname(f), { recursive: true });
    // Atomic write: write to temp then rename.
    const tmp = `${f}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(vars, null, 2));
    await fs.rename(tmp, f);
  }

  async set(name: string, key: string, value: VarValue): Promise<VarsMap> {
    const current = await this.readAll(name);
    current[key] = value;
    await this.writeAll(name, current);
    return current;
  }

  async unset(name: string, key: string): Promise<VarsMap> {
    const current = await this.readAll(name);
    delete current[key];
    await this.writeAll(name, current);
    return current;
  }
}
