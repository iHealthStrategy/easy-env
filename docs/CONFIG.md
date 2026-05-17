# easy-env.json — project configuration reference

Place an `easy-env.json` at the root of any project you want easy-env to
work against. The MCP server walks up from `process.cwd()` looking for it,
or honors the `EASY_ENV_CONFIG` env var if set.

The config does two things in this version:

1. **Declares which backend versions the project expects.** Real projects
   pin specific versions (e.g. `mongo:3.2` for legacy services,
   `mongo:6.0` for new ones). The MCP server probes the live servers
   and warns when they don't match.
2. **Provides defaults** so tool calls don't have to repeat the same
   connection URLs and capture specs every time.

Since v1.1, easy-env **owns** container lifecycle: `env.up` reads this
file and spawns the declared images via Testcontainers with dynamic
ports. Each `env.up` call gets a fresh isolated environment with its own
envId, so multi-agent / multi-PR workflows don't collide.

**Storage policy: pure tmpfs.** All test data lives in RAM-backed tmpfs
mounted at the image's declared VOLUME paths (mongo `/data/db` +
`/data/configdb`, redis `/data`). Docker creates **zero anonymous
volumes**; nothing ever touches disk. Defaults: mongo /data/db 512MB,
configdb 64MB, redis /data 256MB per env. Reasoning: easy-env exists to
test behavior, not to preserve data — there is no scenario in which the
state of a container should outlive its container. Bump the caps in
`packages/mcp-server/src/core/containers.ts` if your fixtures exceed
the defaults.

## Minimal example

```json
{
  "version": 1,
  "backends": {
    "mongo": {
      "image": "mongo:3.2",
      "url": "mongodb://localhost:27017",
      "dbName": "blog"
    },
    "redis": {
      "image": "redis:5-alpine",
      "url": "redis://localhost:6379"
    }
  },
  "app": {
    "baseUrl": "http://localhost:3181"
  }
}
```

## Full schema

```jsonc
{
  // Schema version. Currently always 1.
  "version": 1,

  "backends": {
    "mongo": {
      // Docker image tag the project pins to. Anything matching
      // /^\d+(\.\d+)?/ on the tag side is parsed for version mismatch
      // checks. Examples: "mongo:3.2", "mongo:4.4.18", "mongo:6.0".
      "image": "mongo:3.2",
      // Connection URL the MCP server uses. Default: mongodb://localhost:27018
      "url": "mongodb://localhost:27017",
      // Default database name. Default: "mini"
      "dbName": "blog"
    },
    "redis": {
      "image": "redis:5-alpine",
      "url": "redis://localhost:6379"
    }
  },

  "app": {
    // The base URL `scenario.replay` and `scenario.settle` will hit.
    "baseUrl": "http://localhost:3181"
    // (reserved for Level 2; ignored today)
    // "startCommand": "yarn local-dev",
    // "cwd": "."
  },

  "defaults": {
    // Used by scenario.replay and state.capture when the call doesn't
    // specify these fields explicitly.
    "capture": {
      "mongo": {
        "collections": ["posts", "audit_log", "follows"]
      },
      "redis": {
        "keyPatterns": ["idemp:*", "lock:*"]
      }
    },
    // Used by diff.compare and scenario.replay when noisePolicy is omitted.
    "noisePolicy": {
      "ignoreTimestampFields": [
        "createdAt", "updatedAt", "publishedAt", "processedAt"
      ],
      "ignoreRedisTtlDrift": true
    }
  }
}
```

## Discovery order

When the MCP server starts (or `env.config` is invoked):

1. If `EASY_ENV_CONFIG` env var is set to a file path, that path is loaded
   (and the loader throws if the file is missing — fail loudly).
2. Otherwise, walk up from `process.cwd()` looking for `easy-env.json`.
3. If nothing is found, fall back to built-in defaults
   (`mongodb://localhost:27018`, `redis://localhost:6380`, dbName `mini`,
   no capture defaults). `env.config` will surface a warning.

## What each field affects

| Field | Used by |
|---|---|
| `backends.mongo.url` | `state.capture` default, `scenario.replay` default backends, version probe |
| `backends.mongo.dbName` | `state.capture` default db, `scenario.replay` default backends |
| `backends.mongo.image` | `env.config` version-mismatch check (does NOT change which server we connect to) |
| `backends.redis.url` | same as mongo, for Redis |
| `backends.redis.image` | Redis version-mismatch check |
| `app.baseUrl` | `scenario.replay` / `scenario.settle` default baseUrl |
| `defaults.capture.*` | `scenario.replay` default capture spec |
| `defaults.noisePolicy.*` | `diff.compare` / `scenario.replay` default noise filter |

## Version mismatch behavior

`env.config` returns a `warnings` array (strings). A mismatch entry looks
like:

> *"mongo version mismatch: easy-env.json declares image "mongo:3.2" (3.2)
> but the live server reports 6.0.28 (6.0). Behavior may differ from
> production."*

The MCP server **does not refuse to run** on mismatch. It surfaces the
warning so the AI agent (or human) can decide whether to proceed. This
is intentional: many real workflows want to test "new code against new
backend" before pinning the prod version.

The match key is `major.minor` parsed from the image tag and from the
live server's reported version string. Patch-level differences are
ignored (`6.0.5` matches `6.0.28`).

## Per-call overrides still work

Every field in `easy-env.json` is just a default. Tool callers can always
pass explicit `backends` / `baseUrl` / `noisePolicy` / `capture` and the
config is ignored for that call. This matters when:

- You're testing the same code against two different DB versions
- You're poking at multiple projects from one MCP session
- You want a one-off run that ignores the saved defaults

## What this config does NOT do (yet)

- Does NOT manage your application process. `app.startCommand` and
  `app.cwd` are reserved fields but ignored. The AI / harness starts
  the app itself, pointing it at the URLs from `env.up`'s response.
- Does NOT validate that the declared image matches the running image
  beyond major.minor version parsing.
- Does NOT enforce URL allowlists. The MCP server connects to whatever
  URL the config or per-call override provides (for `env.config`'s
  version probe only — `db.*` and state operations against managed envs
  go through the registry).
- Does NOT support init scripts on container creation yet. Use `db.seed`
  to add fixtures after `env.up`. Volume-mounted init scripts (Mongo's
  `/docker-entrypoint-initdb.d/`) are a planned addition.
