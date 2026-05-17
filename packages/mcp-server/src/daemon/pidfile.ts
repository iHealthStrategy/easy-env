// PID file management. Daemon writes its PID on start; other processes can
// read it to discover whether a daemon is running.
import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import { pidFilePath, easyEnvHome } from './config.js';

export interface PidRecord {
  pid: number;
  startedAt: string;
  port: number;
}

export async function writePidFile(record: PidRecord): Promise<void> {
  await fsAsync.mkdir(easyEnvHome(), { recursive: true });
  await fsAsync.writeFile(pidFilePath(), JSON.stringify(record, null, 2));
}

export async function readPidFile(): Promise<PidRecord | null> {
  try {
    const raw = await fsAsync.readFile(pidFilePath(), 'utf8');
    return JSON.parse(raw) as PidRecord;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function deletePidFile(): Promise<void> {
  try {
    await fsAsync.unlink(pidFilePath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function deletePidFileSync(): void {
  try {
    fs.unlinkSync(pidFilePath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't actually send a signal — it just checks reachability.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM means the process exists but we can't signal it — still alive.
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}
