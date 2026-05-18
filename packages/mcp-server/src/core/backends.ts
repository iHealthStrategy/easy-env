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

// Built-in "no env up yet" fallback URLs. Match the docker-compose
// shipped with this repo so the smoke test works without any setup.
export const FALLBACK_MONGO_URL = 'mongodb://localhost:27018';
export const FALLBACK_REDIS_URL = 'redis://localhost:6380';
export const FALLBACK_RABBIT_URL = 'amqp://guest:guest@localhost:5673';

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
}
