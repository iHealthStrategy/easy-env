# easy-env

An **AI-native environment provisioning and behavior verification toolkit**
for AI coding agents.

After an AI changes code, easy-env lets it (1) spin up or connect to the
project's dependency environment, (2) trigger the business operation under
test, (3) capture state across Mongo + Redis with explicit quiescence
detection, and (4) get a structured diff it can reason about — so it can
judge whether its change behaved as intended.

The tool itself does no semantic validation. It provides the evidence;
the agent does the reasoning.

## Status

**v0.1.0-alpha.** **15 MCP tools** in three families. Container lifecycle
is owned end-to-end by easy-env (via Testcontainers); the AI client
operates everything through MCP.

**Environment lifecycle (5 + 1)**

- `env.config` — load the project's `easy-env.json`, surface version
  mismatches as warnings
- `env.up` — provision a fresh isolated environment via Testcontainers
  using images from `easy-env.json`; returns envId + dynamic-port URLs
- `env.list` — list managed envs + which one is active
- `env.status` — health-probe a specific env (containers + reachability)
- `env.reset` — drop data (fast) or recreate containers (slow)
- `env.down` — stop and remove containers

**Data ops (5, env-scoped)**

- `db.seed` — bulk-insert initial documents into a managed env
- `db.find` / `db.insert` / `db.update` / `db.delete` — Mongo CRUD against
  a managed envId. **All db.* tools refuse to operate on envIds easy-env
  does not own** — that's the v1 mitigation for "AI with direct DB
  access".

**State + scenario (4)**

- `state.capture` — multi-backend snapshot (Mongo collections + Redis keys)
- `scenario.settle` — block until system quiescence (evidence, not verdict)
- `diff.compare` — structured diff with configurable noise filter
- `scenario.replay` — full orchestration: preconditions → snapshot →
  trigger → settle → snapshot → diff → persist

All state-touching tools accept `envId` to address a specific managed
environment (or use the active env when omitted).

Deferred to next iterations: baseline governance, hierarchical verdict
vocabulary, security hardening, AI-generated scenario intent, Mock factory
for external APIs, adapters for Postgres / Kafka / S3.

The design rationale and four-round PoC findings are in
[`docs/REPORT.md`](docs/REPORT.md). The v1 spec outline is in
[`docs/V1_SPEC_OUTLINE.md`](docs/V1_SPEC_OUTLINE.md).

## Architecture

```
┌──────────────────────┐     ┌──────────────────────┐
│  AI agent (MCP       │     │  Tauri desktop app   │
│  client, e.g. Claude │     │  (app/, replaces the │
│  Code)               │     │   Web UI)            │
└──────────┬───────────┘     └──────────┬───────────┘
           │ stdio                       │ HTTP (via Rust)
           ↓                             ↓
┌──────────────────────┐    ┌─────────────────────────┐
│  easy-env-mcp        │    │  easy-env-daemon        │
│  (thin client,       │HTTP│  (long-running,         │
│  forwards tool calls)│───→│   owns containers,      │
└──────────────────────┘    │   serves HTTP API)      │
                            └────────────┬────────────┘
                                         │
                                         ↓
                                     Docker
```

The Tauri app in `app/` is now the recommended management surface — it
embeds the daemon as a child process and exposes one-click toggles for
installing the Claude Code skill and registering the MCP server. The
old browser-served Web UI in `packages/web` still works for headless
setups.

The daemon is the single owner of container lifecycle and persisted state.
It exposes:
- **HTTP API** (`/api/*`) — consumed by the MCP thin client and the Web UI
  (see [`docs/DAEMON_API.md`](docs/DAEMON_API.md))
- **Web UI** at the root path — built from `packages/web` and served as
  a static SPA. Read-only management dashboard for envs, snapshots, and diffs.

## Layout

```
easy-env/
├── app/                   # Tauri desktop app — daemon + skill + MCP toggles
├── packages/
│   ├── mcp-server/        # MCP stdio server + long-running daemon (TypeScript)
│   └── web/               # legacy browser-served admin UI (still works)
├── fixtures/              # small reference apps used to verify primitives
│   ├── mini-app/          mini-app-buggy/        — sync blog (Round 1/2)
│   └── mini-orders/       mini-orders-buggy/     — async order pipeline (Round 3/4)
├── docs/
│   ├── DAEMON_API.md      # HTTP API contract for daemon
│   ├── REPORT.md          # four-round PoC findings + Codex review history
│   └── V1_SPEC_OUTLINE.md # locked design decisions + open questions
└── docker-compose.yml     # Mongo 6 + Redis 7 (kept as convenience for ad-hoc)
```

## Configuring for your project

Drop an `easy-env.json` at the root of the project you want easy-env to
inspect. It declares which backend versions you expect, default
connection URLs, and reasonable defaults for capture/noise policy:

```json
{
  "version": 1,
  "backends": {
    "mongo": { "image": "mongo:3.2", "url": "mongodb://localhost:27017", "dbName": "blog" },
    "redis": { "image": "redis:5-alpine", "url": "redis://localhost:6379" }
  },
  "app": { "baseUrl": "http://localhost:3181" },
  "defaults": {
    "capture": {
      "mongo": { "collections": ["posts", "audit_log"] },
      "redis": { "keyPatterns": ["idemp:*"] }
    },
    "noisePolicy": {
      "ignoreTimestampFields": ["createdAt", "updatedAt", "publishedAt"],
      "ignoreRedisTtlDrift": true
    }
  }
}
```

Different projects pin different versions (mongo:3.2 vs mongo:6.0,
redis:5 vs redis:7). easy-env probes the live server and warns if the
running version's major.minor doesn't match the declared `image` —
without preventing you from running. Per-call overrides on every tool
still work; the config only fills in what you don't pass.

Full reference: [`docs/CONFIG.md`](docs/CONFIG.md). Example file:
[`fixtures/mini-orders/easy-env.json`](fixtures/mini-orders/easy-env.json).

## Quick start

### Real-world validation (blog-backend)

easy-env has been validated end-to-end against the real
`blog-backend` legacy project (Koa + Apollo 2.x + Babel 6 + 1147 npm
packages, originally targeting Mongo 3.2). The test driver is at
`packages/mcp-server/test/real-world/blog-backend.mjs`. It:

1. `env.up` spawns mongo:4.2 + redis:7-alpine via Testcontainers
2. Starts blog-backend with all 5 of its `MONGO_*` env vars pointing at
   the same easy-env mongo, separated by db name
3. POSTs a real `insertBlog` GraphQL mutation
4. `state.capture` + `diff.compare` confirm `blogs +1` and
   `submitBehavior +1` — matching the PoC Round 1 prediction
5. `env.down` cleans up

This was the first real-world test against a non-trivial legacy
codebase. It surfaced two architectural decisions that are now part of
the design:

- **Multi-db cheat**: an app that wants N Mongo connections can be
  pointed at the same easy-env mongo with different db names per
  connection. The schema does NOT need a multi-mongo backend type
  (validated against blog-backend's 5 mongo connections).
- **Default mongo image**: `mongo:4.2` (the median version across the
  user's projects). Override per-project via `easy-env.json`.

To run it:

```bash
cd packages/mcp-server
npm run build
node test/real-world/blog-backend.mjs
# Or with a custom path:
BLOG_BACKEND_PATH=/path/to/your/blog-backend node test/real-world/blog-backend.mjs
```

### Build and verify

```bash
# 1. Make sure Docker is running (Testcontainers needs it).

# 2. Install + build all workspaces from the repo root.
npm install
npm run build              # builds packages/mcp-server and packages/web

# 3. Daemon + MCP contract tests (no Docker required)
npm test --workspace easy-env-mcp

# 4. End-to-end smoke against real containers (requires Docker)
npm run smoke
```

### Run the desktop app (recommended)

```bash
npm install
npm run build --workspace easy-env-mcp   # build daemon artifacts first
npm run app:install                      # install Tauri/Vite deps in app/
npm run app:dev                          # opens the easy-env window
```

In the **Settings** panel, toggle:
- **Daemon** — spawns the embedded daemon (replaces `npm run daemon`)
- **Skill** — installs `easy-env-bootstrap.md` into `~/.claude/skills/`
- **MCP server** — registers `easy-env` in `~/.claude.json`

See [`app/README.md`](app/README.md) for details on the Tauri build.

### Run the legacy Web UI

The daemon serves the built SPA on its own port. Start it manually:

```bash
npm run daemon             # http://127.0.0.1:7193/
```

Or, in development with hot reload:

```bash
npm run daemon &           # backend on :7193
npm run web                # Vite dev server on :5173, proxies /api → :7193
```

The MCP server also auto-starts the daemon on first call, so an agent
session and a browser tab can share the same daemon process.

### Hook into your AI agent (Claude Code)

**Minimum setup** — just register the MCP server. Add to your Claude
Code config (`~/.claude.json` or project's `.mcp.json`):

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

The agent gets 20 tools (env lifecycle / data ops / variables /
state-and-scenario). On first call the MCP server auto-spawns the
long-running daemon, which owns containers and state.

**Recommended:** install the bundled skill so the agent reliably walks
the new-project bootstrap flow (env.init → vars.init → fill values →
env.up → start project) in the right order:

```bash
node /absolute/path/to/easy-env/packages/mcp-server/bin/easy-env-install-skill.mjs
```

This copies `easy-env-bootstrap.md` to `~/.claude/skills/`. Restart
Claude Code, then trigger it with any of:

- "用 easy-env 跑起这个项目"
- "用 easy-env 配好这个项目的环境"
- "set up this project with easy-env"
- "initialize easy-env for this project"

Without the skill, the tools all work but the agent has to discover the
workflow on its own — it's likely to skip `env.init` and `vars.init`
and try to start the project before variables are fully wired up.

See [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for
tool argument schemas and [`docs/DAEMON_API.md`](docs/DAEMON_API.md)
for the daemon API contract.

## Replaying the PoC

The PoC code is preserved verbatim in `poc-history/` and uses the
fixtures in `fixtures/`. To re-run Round 1/2 (sync blog):

```bash
cd poc-history
npm install   # legacy CommonJS deps
./run-all.sh  # 7 scenarios, outputs to poc-history/runs/
node lib/judge.js                 # single-diff judgment
node lib/judge-differential.js    # differential judgment
```

Round 3 (async multi-backend):

```bash
cd poc-history
for s in async-01-happy async-02-retry-same-key async-03-worker-down \
         async-04-double-inventory async-05-no-idemp-key \
         async-06-no-consume async-baseline-clean; do
  node lib/runner-multi.js "$s"
done
node lib/judge-async.js single
node lib/judge-async.js differential
```

Round 4 (baseline governance 4-case matrix):

```bash
cd poc-history
node lib/runner-multi.js gov-baseline-broken
node lib/runner-multi.js gov-current-clean
node lib/judge-governance.js
```

## What this is NOT (yet)

- **Not a verifier.** It provides evidence; the AI agent decides.
- **Not safe for shared infrastructure.** No URL allowlists, no PII
  redaction, no command sandboxing — see `docs/V1_SPEC_OUTLINE.md` §9.
- **Not a Mock factory.** External API mocking is on the v2 roadmap.
- **Not multi-DB yet.** Mongo + Redis only in v1. Adapter pattern is in
  place for Postgres / Kafka / S3 etc.
- **Not battle-tested at scale.** Production-scale diff sizes,
  concurrency, schema drift are all known unaddressed gaps.

## License

TBD — internal use for now.
