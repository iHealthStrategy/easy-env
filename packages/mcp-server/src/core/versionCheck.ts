import { MongoClient } from 'mongodb';
import Redis from 'ioredis';

export interface BackendVersionInfo {
  backend: 'mongo' | 'redis';
  expected?: string;       // major.minor parsed from config image tag
  actual?: string;         // major.minor reported by the live server
  rawActual?: string;      // server's full version string
  reachable: boolean;
  reachError?: string;
  mismatch?: boolean;      // true when expected and actual differ on major.minor
  imageTag?: string;       // the original image string from config
}

function parseMajorMinor(versionString: string): string | undefined {
  // accepts "mongo:3.2", "mongo:4.4.18", "mongo:6.0.5-jammy", "redis:7-alpine",
  // "3.2.22", "4.4", etc.
  const tagPart = versionString.includes(':')
    ? versionString.split(':').slice(1).join(':')
    : versionString;
  const m = tagPart.match(/^(\d+)(?:\.(\d+))?/);
  if (!m) return undefined;
  const major = m[1];
  const minor = m[2] ?? '0';
  return `${major}.${minor}`;
}

async function probeMongoVersion(url: string): Promise<{ raw: string; mm: string } | { error: string }> {
  let client: MongoClient | null = null;
  try {
    client = await MongoClient.connect(url, { serverSelectionTimeoutMS: 2000 });
    const admin = client.db().admin();
    const info = await admin.command({ buildInfo: 1 });
    const raw = String(info.version ?? '');
    const mm = parseMajorMinor(raw) ?? raw;
    return { raw, mm };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function probeRedisVersion(url: string): Promise<{ raw: string; mm: string } | { error: string }> {
  const redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const info = await redis.info('server');
    const line = info.split(/\r?\n/).find((l) => l.startsWith('redis_version:'));
    if (!line) return { error: 'redis INFO server returned no redis_version line' };
    const raw = line.split(':')[1]?.trim() ?? '';
    const mm = parseMajorMinor(raw) ?? raw;
    return { raw, mm };
  } catch (e) {
    return { error: (e as Error).message };
  } finally {
    redis.disconnect();
  }
}

export async function checkMongo(
  url: string,
  expectedImage?: string,
): Promise<BackendVersionInfo> {
  const probe = await probeMongoVersion(url);
  const expected = expectedImage ? parseMajorMinor(expectedImage) : undefined;
  if ('error' in probe) {
    return {
      backend: 'mongo',
      expected,
      reachable: false,
      reachError: probe.error,
      imageTag: expectedImage,
    };
  }
  return {
    backend: 'mongo',
    expected,
    actual: probe.mm,
    rawActual: probe.raw,
    reachable: true,
    mismatch: expected !== undefined && expected !== probe.mm,
    imageTag: expectedImage,
  };
}

export async function checkRedis(
  url: string,
  expectedImage?: string,
): Promise<BackendVersionInfo> {
  const probe = await probeRedisVersion(url);
  const expected = expectedImage ? parseMajorMinor(expectedImage) : undefined;
  if ('error' in probe) {
    return {
      backend: 'redis',
      expected,
      reachable: false,
      reachError: probe.error,
      imageTag: expectedImage,
    };
  }
  return {
    backend: 'redis',
    expected,
    actual: probe.mm,
    rawActual: probe.raw,
    reachable: true,
    mismatch: expected !== undefined && expected !== probe.mm,
    imageTag: expectedImage,
  };
}
