// Fallback image / URL defaults for backend containers. Used when the
// project's manifest doesn't pin specific values.
//
// "mongo:4.2" is the median compatible version across the projects we
// validate against — newer features (3.6+ change streams, 4.0 txns) work
// and the wire protocol still talks to legacy 3.6+ drivers.
export const DEFAULT_MONGO_IMAGE = 'mongo:4.2';
export const DEFAULT_REDIS_IMAGE = 'redis:7-alpine';
// management variant chosen so the management UI works out of the box when
// the user opens http://localhost:<managementPort>. The non-management
// alpine variant works too but most projects expect the UI to be there.
export const DEFAULT_RABBIT_IMAGE = 'rabbitmq:3.12-management';
export const DEFAULT_RABBIT_USER = 'guest';
export const DEFAULT_RABBIT_PASSWORD = 'guest';
// ClickHouse: pinned to a stable LTS-ish tag (not :latest) so smoke tests
// stay reproducible. HTTP protocol is on container port 8123.
export const DEFAULT_CLICKHOUSE_IMAGE = 'clickhouse/clickhouse-server:24.3';
export const DEFAULT_CLICKHOUSE_DB = 'default';
// Defaults for the synthetic single-node cluster. Reusable constants so
// containers.ts and tools/envInit.ts agree on the same fallbacks.
export const DEFAULT_CLICKHOUSE_CLUSTER_NAME = 'default';
export const DEFAULT_CLICKHOUSE_SHARD = '01';
export const DEFAULT_CLICKHOUSE_REPLICA = 'r1';

// Built-in "no env up yet" fallback URLs. Match the docker-compose
// shipped with this repo so the smoke test works without any setup.
export const FALLBACK_MONGO_URL = 'mongodb://localhost:27018';
export const FALLBACK_REDIS_URL = 'redis://localhost:6380';
export const FALLBACK_RABBIT_URL = 'amqp://guest:guest@localhost:5673';
// No FALLBACK_CLICKHOUSE_URL — ClickHouse is opt-in via env.init, and
// silently dialling localhost:8124 for projects that never declared it
// produced phantom URLs in persisted scenario configs (see code review
// finding #1). Callers that need clickhouseUrl must declare the backend
// explicitly, and tools detect absence as "skip ClickHouse".

export interface BackendsSpec {
  mongo?: { image?: string; port?: number; dbName?: string; replicaSet?: string };
  redis?: { image?: string; port?: number };
  rabbit?: {
    image?: string;
    port?: number;
    managementPort?: number;
    user?: string;
    password?: string;
  };
  clickhouse?: {
    image?: string;
    /** Host port to bind to the container's HTTP port (8123). */
    port?: number;
    /** Primary database name. Created on first use; defaults to "default". */
    dbName?: string;
    /** Enable embedded ClickHouse Keeper + a synthetic single-node cluster
     *  so the project's ReplicatedMergeTree / Distributed / ON CLUSTER /
     *  cluster() syntax works against the lone container. Plain MergeTree
     *  + SELECT … FINAL work without this — they're not cluster-coupled.
     *  Absent → single-node, no Keeper (the default; fastest boot). */
    cluster?: {
      /** Cluster name the project references in its DDL (e.g. \"ON CLUSTER my_cluster\").
       *  Must be a valid XML element name. Defaults to "default". */
      name?: string;
      /** {shard} macro value (default "01"). */
      shard?: string;
      /** {replica} macro value (default "r1"). */
      replica?: string;
    };
  };
}
