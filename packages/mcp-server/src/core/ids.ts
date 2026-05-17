import crypto from 'node:crypto';

export const newId = (prefix: string): string =>
  `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

export const nowIso = (): string => new Date().toISOString();
