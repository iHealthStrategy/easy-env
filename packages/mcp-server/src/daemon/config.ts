// Daemon-side runtime configuration: host, port, paths.
import path from 'node:path';
import os from 'node:os';

export const DAEMON_DEFAULT_HOST = '127.0.0.1';
export const DAEMON_DEFAULT_PORT = 7193;

export function daemonHost(): string {
  return process.env.EASY_ENV_DAEMON_HOST ?? DAEMON_DEFAULT_HOST;
}

export function daemonPort(): number {
  const raw = process.env.EASY_ENV_DAEMON_PORT;
  if (!raw) return DAEMON_DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`invalid EASY_ENV_DAEMON_PORT: ${raw}`);
  }
  return n;
}

export function daemonBaseUrl(): string {
  return `http://${daemonHost()}:${daemonPort()}`;
}

export function easyEnvHome(): string {
  return (
    process.env.EASY_ENV_HOME
    ?? process.env.STATE_DIFF_HOME  // legacy
    ?? path.join(os.homedir(), '.easy-env')
  );
}

export function pidFilePath(): string {
  return path.join(easyEnvHome(), 'daemon.pid');
}

export function logFilePath(): string {
  return path.join(easyEnvHome(), 'daemon.log');
}
