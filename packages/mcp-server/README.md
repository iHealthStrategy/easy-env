# easy-env-mcp — v0.1.0-alpha

The MCP server package of the `easy-env` project. Exposes scenario replay
+ multi-backend state diff primitives for AI coding agents. The agent
triggers business operations, gets structured evidence of what changed
across Mongo + Redis, and decides whether the change is correct.

**Status**: v0.1.0-alpha. Four primitives shipping. Baseline governance,
security hardening, and intent authoring deferred to later versions. See
[`../../docs/V1_SPEC_OUTLINE.md`](../../docs/V1_SPEC_OUTLINE.md)
for the full v1 design and what is deferred.

The four PoC rounds that validated each primitive are documented in
[`../../docs/REPORT.md`](../../docs/REPORT.md).

## What ships

**15 MCP tools** organised in three families. easy-env owns container
lifecycle end-to-end (via Testcontainers); the AI client operates
everything through MCP and never has to touch `docker` directly.

### Environment lifecycle (6 tools)
- **`env.config`** — load the project's `easy-env.json`, probe live
  Mongo/Redis versions, surface mismatches as warnings
- **`env.up`** — provision a fresh isolated env (Testcontainers spawns
  containers from images declared in easy-env.json). Returns envId and
  dynamic-port URLs.
- **`env.list`** — list managed envs + active envId
- **`env.status`** — health probe for one env
- **`env.reset`** — drop data (fast) or recreate (slow)
- **`env.down`** — stop containers, drop env

### Data ops, env-scoped (5 tools)
- **`db.seed`** — bulk insert initial documents
- **`db.find` / `db.insert` / `db.update` / `db.delete`** — Mongo CRUD.
  **All refuse to target envIds easy-env does not own** — that's the v1
  containment boundary. AI cannot use these against arbitrary URLs.

### State + scenario (4 tools)

- **`env.config`** — load the project's `easy-env.json`, probe live
  Mongo/Redis versions, return resolved URLs/dbName/baseUrl plus
  warnings when declared and live versions differ. Call this first in a
  session to know what environment you're operating against.
- **`state.capture`** — snapshot Mongo collections + Redis keys. Returns
  a `snapshotId` you can later diff.
- **`scenario.settle`** — block until the system under test reaches an
  explicit quiescence condition (e.g. outbox drained), or timeout.
  Outcome is *evidence*, not a verdict.
- **`diff.compare`** — diff two snapshots, filtering incidental noise
  (timestamp fields, Redis TTL drift).
- **`scenario.replay`** — orchestrates the full loop: preconditions →
  snapshot → trigger → settle → snapshot → diff → persist run.

All state-touching tools accept `envId` to target a specific managed
environment. When omitted, they use the active env, then fall back to
the active `easy-env.json` defaults, then to built-in fallbacks. See
`../../docs/CONFIG.md`.

All artifacts persist to `~/.easy-env/` (override via
`EASY_ENV_HOME`, or the legacy `STATE_DIFF_HOME`, env var).

## Build

```bash
npm install
npm run build
```

## Verify locally

Requires Docker (for Mongo + Redis). The smoke test uses the fixture app
at `easy-env/fixtures/mini-orders` (sibling of this package).

```bash
# 1. Start backends (from easy-env root)
(cd ../.. && docker compose up -d)

# 2. Build
npm run build

# 3. End-to-end smoke (low-level tools + scenario.replay)
npm run smoke
# or: node dist/test/smoke.js

# 4. MCP handshake (lists 4 tools over stdio)
node dist/test/mcp-handshake.js
```

Expected output of the smoke test:

```
state.capture before: snap_xxx ...
scenario.settle: { settled: true, waitedMs: ~100, polls: 2, finalValue: 0 }
state.capture after : snap_xxx ...
diff.compare diffId: diff_xxx
✓ low-level tools verified end-to-end
scenario.replay runId: run_xxx → diffId: diff_xxx
✓ scenario.replay verified end-to-end
SMOKE OK
```

## Configure your MCP client

The server speaks stdio. Add it to your MCP client config.

### Claude Code (`~/.claude/config.json` or `.mcp.json`)

```json
{
  "mcpServers": {
    "easy-env": {
      "command": "node",
      "args": ["/absolute/path/to/easy-env/packages/mcp-server/dist/src/server.js"]
    }
  }
}
```

### Cursor / generic stdio MCP

Same shape, point `command` + `args` at `dist/src/server.js`. The
`bin/easy-env-mcp.mjs` shim is also installable globally if you prefer:

```json
{
  "mcpServers": {
    "easy-env": { "command": "easy-env-mcp" }
  }
}
```

## Tool reference

### `env.config`

```ts
{
  startDir?: string,        // defaults to process.cwd()
  probeVersions?: boolean,  // default true; connect to mongo/redis to compare versions
}
→ {
  configPath: string | null,           // discovered easy-env.json path
  source: "env" | "walk" | "defaults",
  resolved: { mongoUrl, redisUrl, dbName, baseUrl? },
  defaults: { /* full defaults block from config */ },
  version: 1,
  backendChecks?: [
    { backend: "mongo"|"redis", expected?, actual?, rawActual?, reachable, reachError?, mismatch?, imageTag? }
  ],
  warnings: string[]                   // human-readable mismatch / unreachable messages
}
```

Use this **first** to understand what environment the other tools will
operate against, and to surface version-mismatch concerns to the agent.
See `../../docs/CONFIG.md` for the config file format.

### `state.capture`

```ts
{
  spec: {
    mongo?: { collections: string[] },
    redis?: { keyPatterns: string[] },  // SCAN patterns, e.g. ["idemp:*"]
  },
  backends?: {
    mongoUrl?: string,   // default mongodb://localhost:27018
    dbName?: string,     // default "mini"
    redisUrl?: string,   // default redis://localhost:6380
  },
  scenarioId?: string,   // optional, for grouping artifacts
}
→ { snapshotId, takenAt, summary: { mongoCollections, redisKeys } }
```

### `scenario.settle`

```ts
{
  baseUrl: string,
  condition: {
    kind: "outbox_drained" | "http_count_zero",
    probePath: string,    // default "/_debug/outbox-pending"
    pendingField: string, // default "pending"
    timeoutMs: number,    // default 2000
    intervalMs: number,   // default 100
  },
}
→ { settled, waitedMs, polls, finalValue, timeoutReason? }
```

Important: `settled: true` does **not** imply correctness. It only
asserts that the named condition was reached. The agent must still
inspect the diff.

### `diff.compare`

```ts
{
  beforeSnapshotId: string,
  afterSnapshotId: string,
  noisePolicy?: {
    ignoreTimestampFields: string[],  // e.g. ["createdAt","updatedAt"]
    ignoreRedisTtlDrift: boolean,     // default true
  },
  scenarioId?: string,
}
→ DiffArtifact { diffId, mongo, redis, ... }
```

### `scenario.replay`

```ts
{
  scenario?: ScenarioConfig,   // inline definition (see below)
  scenarioId?: string,         // OR replay a previously saved scenario
  noisePolicy?: NoisePolicy,
}
→ { runId, triggerResponse, beforeSnapshotId, afterSnapshotId, diffId, settle }
```

A `ScenarioConfig` looks like:

```jsonc
{
  "id": "order-happy-path",
  "baseUrl": "http://localhost:4100",
  "capture": {
    "mongo": { "collections": ["orders", "outbox_events", "inventory", "audit_log"] },
    "redis": { "keyPatterns": ["idemp:*"] }
  },
  "backends": { /* optional overrides */ },
  "preconditions": [
    { "method": "POST", "path": "/inventory/init", "body": { "sku": "widget", "stock": 100 } }
  ],
  "trigger": {
    "method": "POST",
    "path": "/orders",
    "body": {
      "idempotencyKey": "tx-001",
      "userId": "alice",
      "items": [{ "sku": "widget", "qty": 3, "unitPrice": 10 }]
    }
  },
  "settle": {
    "kind": "outbox_drained",
    "probePath": "/_debug/outbox-pending",
    "pendingField": "pending",
    "timeoutMs": 2000,
    "intervalMs": 100
  },
  "intent": "Create an order; deduct inventory by qty; record an audit_log entry; cache the idempotency key in Redis."
}
```

## What is deliberately NOT in this version

| Thing | Why deferred |
|---|---|
| `baseline.governance` (promote/invalidate, hierarchical verdicts) | Round 4 PoC showed verdict vocabulary needs a design pass first. See V1_SPEC_OUTLINE §6. |
| Security typed tools (no generic exec, command allowlist, PII redaction) | Treated as its own sub-spec. See V1_SPEC_OUTLINE §9. |
| AI-generated intent / side-effect inventory warnings | Open product decision. See V1_SPEC_OUTLINE §5 and the "scenario intent quality" discussion in REPORT.md. |
| Mock factory for external APIs | v2. PoC Round 1's design defer. |
| Postgres / MySQL / Kafka / S3 capture | v1.x. The capture interface is extensible; this is just adapter work. |
| `diff.explain` (AI-friendly aggregate) | Not needed at PoC scale; will matter at production scale. |
| Cross-instance state, real concurrency, schema drift handling | Untested. Codex Round 3 flagged these. |

## Layout

```
src/
├── server.ts                # MCP stdio entry
├── tools/                   # one MCP tool per file (env.config, state.capture, ...)
├── core/                    # capture/diff/settle/orchestrate + config + versionCheck + context
├── schemas/                 # zod schemas — the public contract (capture, diff, scenario, config)
└── store/fsStore.ts         # ~/.easy-env/ persistence
test/
├── smoke.ts                 # end-to-end: env.config + tools + replay vs mini-orders
└── mcp-handshake.ts         # MCP protocol smoke (asserts 5 tools)
```

## Caveats

- This is alpha. The artifact schemas may break between alpha versions.
- The server currently trusts whatever `baseUrl` / `mongoUrl` / `redisUrl`
  the caller provides. That is the right behavior for local dev but is a
  known unmitigated security surface for any multi-tenant deployment.
- Default noise policy filters `createdAt`/`updatedAt`/`processedAt`/
  `publishedAt`. Add to `ignoreTimestampFields` for anything else
  ephemeral in your domain.
- `scenario.settle` only supports two condition kinds today. Real
  systems will need richer quiescence definitions (queue depth, lock
  count, log line patterns). Treat the current set as illustrative.
