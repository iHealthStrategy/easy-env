---
name: easy-env-bootstrap
description: Use the easy-env MCP server to provision a project's runtime
  environment. YOU (the AI) read the project, decide which env vars it
  needs, and submit them via vars.declare; easy-env owns the data-service
  containers (mongo/redis/rabbit/clickhouse) the project DECLARES — each is
  opt-in, so a project only runs the ones it actually uses. Trigger when
  the user says "用 easy-env 跑起这个项目", "用 easy-env 配好这个项目的环境",
  "set up this project with easy-env", "initialize easy-env for this
  project", "let easy-env manage this app's vars".
---

# easy-env bootstrap

You are wiring an existing project into easy-env so it (and future
sessions) can run it reproducibly.

## The two-sided contract

**AI side (you, here in the user's shell)**:
- Read the project — `easy-env.json`, source code, docker-compose, .env,
  Dockerfile, k8s manifests, README — whatever applies.
- Decide **which** data services the project actually uses (mongo? redis?
  rabbit? clickhouse? maybe none), their images and host ports, and what
  environment variables it consumes.
- Push the resolved data to the easy-env daemon via MCP tools.

**Each backend is opt-in.** env.up spawns mongo / redis / rabbit / clickhouse
only when you declared it via env.init. Declare just what the project uses:
a redis-only project gets only redis; a pure compute service that talks to
no local data store gets a bare env with no containers. Don't declare a
service "just in case" — it would spin up a container the project never
connects to.

**Daemon side (easy-env)**:
- Pure persistence + container lifecycle. **The daemon NEVER reads
  anything inside the project's directory.** All state it knows about a
  project arrives as MCP tool arguments and is stored under
  `~/.easy-env/projects/<projectName>/`.

Because of this split, **YOU must do the project reading**. There is no
daemon-side scanner. If you skip reading, the daemon has nothing.

## `easy-env.json` — the project-side config

You (the AI) read it. The daemon never opens it. Typical content:

```json
{
  "version": 1,
  "name": "blog-backend",
  "backends": {
    "mongo": { "image": "mongo:4.2", "port": 27818 },
    "redis": { "image": "redis:7-alpine", "port": 6480 }
  }
}
```

The `name` is what the daemon uses as the projectKey (directory under
`~/.easy-env/projects/`). It is REQUIRED — without it the MCP server has
no project identity to inject.

## Auto-injected identity

When the MCP server (stdio) starts, it walks up from `cwd` looking for
an `easy-env.json` with a `name`. It captures `{ projectName, projectRoot }`
and **injects them into every project-scoped tool call** if the caller
didn't pass them. So you can write `vars.declare({ items: [...] })` and
the projectName/projectRoot get filled in automatically.

You can always pass them explicitly to override the auto-injected values.

## The bootstrap flow

```
1. Read / fix easy-env.json     (YOU, with Read/Write tools)
2. env.init                     (declare which services + push backends config)
3. AI READ project              (find every env var the project consumes)
4. vars.declare                 (bulk submit variable names + values)
5. env.up                       (spawn ONLY the declared containers)
6. vars.list                    (verify no required var is `unset`)
7. start the project            (spawn it with vars.list values in env)
```

## Workflow

### 1. Read `easy-env.json` (and create it if missing)

Use Read.

- **Missing entirely**: write a stub yourself:
  ```json
  { "version": 1, "name": "<project-name>" }
  ```
  Pick a name from the directory name unless the user said otherwise.
- **Has no `name` field**: add one. The daemon stores variable values
  under `~/.easy-env/projects/<name>/`, so the name is the long-lived
  identity.
- **Has `backends.mongo.port` / `backends.redis.port` already**: great,
  reuse them. If the project has a `docker-compose*.yml`, reusing the
  ports those declare is usually the right call.

### 2. Push backends config to daemon — `env.init`

```
env.init {
  // projectName/projectRoot auto-injected from easy-env.json#name + cwd
  mongo: { image: "mongo:4.2", port: 27818 },
  redis: { image: "redis:7-alpine", port: 6480 }
}
```

This writes the backends config into the daemon's manifest at
`~/.easy-env/projects/<projectName>/manifest.json`. Subsequent `env.up`
calls read from this file — `MONGO_URL` / `REDIS_URL` stay stable across
env.up cycles.

**Declare only what the project uses.** The backends you pass here are the
exact set env.up will start. Pass an empty object (`mongo: {}`) to enable a
service with default image/port. Examples:

```
// redis-only project
env.init { redis: {} }

// mongo + rabbit, no redis
env.init { mongo: { dbName: "app" }, rabbit: {} }

// clickhouse-only analytics service (single node, no cluster)
env.init { clickhouse: { dbName: "analytics" } }

// clickhouse with Replicated*/Distributed/ON CLUSTER DDL (see ClickHouse decision below)
env.init { clickhouse: { dbName: "analytics", cluster: { name: "default" } } }

// pure compute service, no local data stores
env.init { }            // declares nothing → env.up starts no containers
```

To stop running a service you previously declared, pass it in `disable`:
```
env.init { disable: ["redis"] }
```
Omitting a backend key leaves its existing declaration untouched — only
`disable` turns one off.

**Image choices**: pick `mongo:4.2` unless the project pins a different
version (look at `docker-compose*.yml`, README). `redis:7-alpine` is a
safe default.

**Port choices**: on macOS avoid 7000, 5000, 7001 (Apple ControlCenter).
Safe defaults that rarely collide: `27818` (mongo), `6480` (redis).

#### ClickHouse: cluster mode is YOUR call

If the project uses ClickHouse, decide **single-node vs cluster mode**
yourself before calling env.init — the daemon won't infer it. Cluster mode
boots an embedded Keeper + a synthetic single-node cluster (so
`Distributed` / `ON CLUSTER` / `cluster()` / `ReplicatedMergeTree` work),
at the cost of ~10–15s extra startup. Single-node mode skips Keeper and
boots faster; plain `MergeTree` + `SELECT … FINAL` work either way.

**Decision procedure** — grep the project's DDL / migrations / source for
these cluster-coupled features. ANY hit → enable cluster:

```
grep -rEn "Engine\s*=\s*(Replicated|Distributed)|ON CLUSTER|cluster\(|remote\(" \
  <project-root>/{migrations,sql,db,schema,src} 2>/dev/null
```

| What you found in the project | What to pass to env.init |
|---|---|
| `ReplicatedMergeTree(...)`, `ReplicatedReplacingMergeTree`, any `Replicated*` engine | `clickhouse: { cluster: {} }` |
| `Engine = Distributed(cluster_name, ...)` | `clickhouse: { cluster: { name: "<cluster_name from DDL>" } }` |
| `CREATE TABLE … ON CLUSTER my_cluster` | `clickhouse: { cluster: { name: "my_cluster" } }` |
| `SELECT … FROM cluster('my_cluster', ...)` | `clickhouse: { cluster: { name: "my_cluster" } }` |
| Only plain `MergeTree` / `ReplacingMergeTree` / `SummingMergeTree`, with or without `FINAL` | `clickhouse: {}` — no cluster needed |
| ClickHouse not used at all | omit `clickhouse` entirely |

**Cluster name matching matters.** If the project's DDL hardcodes a name
like `ON CLUSTER analytics_main`, you MUST pass the same name in
`cluster.name` — otherwise the DDL will fail at runtime with "cluster
analytics_main not found". When the project uses multiple cluster names,
that's the rare case where easy-env's single-cluster setup isn't enough;
report it to the user instead of guessing.

The macros `{shard}` / `{replica}` are exposed for `ReplicatedMergeTree`'s
zookeeper-path template. Defaults (`01` / `r1`) are fine unless the
project's path template references something else.

After enabling cluster mode you can template the cluster name into the
project's variables: `vars.set { name: "CH_CLUSTER", value: "${clickhouse.cluster}" }`.

### 3. Discover this project's env-var surface — YOU read the project

There is no scanner. Read everything relevant:

- `docker-compose*.yml` / `compose*.yaml` — most projects have their
  dev defaults here. ALL variants: `.local.yml`, `.dev.yml`, `.prod.yml`.
  Look at every `services.*.environment` and every `env_file:`.
- `Dockerfile` `ENV` directives
- `.env`, `.env.example`, `.env.local`, `.env.development`, `.envrc`
- `ecosystem.config.js` (PM2), `nodemon.json`, `pm2.json`
- `k8s/*.yaml`, `helm/values*.yaml`, `kustomization.yaml`
- `package.json` scripts (sometimes inline `KEY=val node app.js`)
- Source code — `process.env.X`, `process.env[X]`, `getEnv('X')`,
  `config.get('x.y')`, `import.meta.env.X`, custom config wrappers
- README / docs sections titled "Environment", "Configuration", "Setup"

Make a complete list. Compose files alone often miss several vars
referenced only in source.

### 4. Submit the result — `vars.declare`

One bulk submission. Include every variable the project needs to run.
Attach `value` when you found a sensible default (in .env, in compose,
or one the user obviously expects); omit `value` for genuine secrets or
values the user must provide.

```
vars.declare {
  items: [
    { name: "PORT",            value: "3181",        evidence: "docker-compose.local.yml" },
    { name: "JWT_SECRET",      value: "dev-secret",  evidence: "docker-compose.local.yml" },
    { name: "MONGO_BG",        value: "mongodb://localhost:27818/bg", evidence: "external mongo, point to local instead" },
    { name: "PIGEON_USERNAME",                       evidence: "src/notifications.js: process.env.PIGEON_USERNAME — no default" },
    ...
  ],
  removeUndeclared: false   // set true only when doing a full re-survey
}
```

Response shape (per item):
```ts
{
  projectName, projectRoot, declaredVariables, removed,
  results: [{
    name,
    declared: 'added' | 'unchanged',
    valueWritten?: boolean,
    valueSkippedReason?: 'already-set' | 'no-value',
    evidence?
  }]
}
```

Rules easy-env enforces:
- Existing user-set values are NEVER overwritten (report shows
  `already-set`).
- Names must match `^[A-Z_][A-Z0-9_]*$`.

The daemon reserves NO variable names — call them whatever the project
calls them. Container connection details (mongoUrl / redisUrl / dbName /
host ports) come back in a SEPARATE `containers` field from
`vars.list` (see step 6) — the AI maps them onto the project's actual
variable names with `vars.set`.

### 5. Spawn the backends — `env.up`

```
env.up {}     // projectName/projectRoot auto-injected
```

Expect `status: "ready"` and resolved URLs. The response's `services` field
reports, per backend, whether it was `spawned` or skipped (e.g. `skipped:
not declared in manifest`) — use it to confirm exactly the services you
declared came up, and nothing extra. If a service you expected is "not
declared", go back to step 2 and declare it. If it errors "port already in
use", show the message to the user verbatim — they need to free the port or
change `backends.<x>.port` in `easy-env.json` and re-run `env.init`.

### 6. Verify required values — `vars.list`

```
vars.list {}
```

Response shape:
```ts
{
  projectName,
  variables: { [name]: { value, source: 'user' | 'unset' } },
  containers: null | {
    envId,
    mongoUrl?, redisUrl?, dbName,
    mongoHostPort?, redisHostPort?
  }
}
```

Two distinct parts:

1. **`variables`** — every name declared for this project (+ stray values
   the user set without declaring). Each entry's `source` is either
   `user` (has a value) or `unset` (declared but no value yet → MUST be
   filled before starting the project).

2. **`containers`** — the active env's container connection details. The
   daemon does NOT auto-map these onto any variable names. The AI reads
   them and uses `vars.set` to populate whatever names the project
   actually consumes. Examples:
   ```
   // single Mongo URL — common Node template
   vars.set { name: "MONGO_URL", value: `${containers.mongoUrl}/${containers.dbName}` }

   // multi-db project (blog-backend style)
   vars.set { name: "MONGO_BG",     value: `${containers.mongoUrl}/bg` }
   vars.set { name: "MONGO_PARROT", value: `${containers.mongoUrl}/parrot` }

   // split host/port Redis
   vars.set { name: "REDIS_HOST", value: "localhost" }
   vars.set { name: "REDIS_PORT", value: containers.redisHostPort }
   ```

For each `source: "unset"` variable, fill via:
- **Send the user to** the desktop app's Variables page (project selector)
- **Set inline via `vars.set`** when the user provides a value (auto-
  declares an unknown name — escape hatch for mid-flow discoveries)

**Never invent values for genuine secrets.** Ask the user.

If anything is still `source: "unset"` after this loop, STOP and report.
Do not start the project until every required variable has a value or
the user explicitly says "skip that one".

### 7. Start the project

```ts
const { variables } = await mcp.call('vars.list', {});
const env = Object.fromEntries(
  Object.entries(variables)
    .filter(([, v]) => v.source !== 'unset')
    .map(([k, v]) => [k, String(v.value ?? '')])
);
spawn(<startCommand>, { env: { ...process.env, ...env } });
```

For projects with a build step, run it first. Confirm the project is
healthy by hitting a health endpoint. Report URL + PID to the user.

## After bootstrap

Re-run anytime with just steps 5 and 7 (`env.up` then start). Steps 2-4
only need to repeat when the project's env-var surface changes. To do a
full re-survey: `vars.declare { items: [...], removeUndeclared: true }`.

## What you DO NOT do

- **Do NOT expect a daemon-side scanner.** There is none. If you don't
  read the project, easy-env has zero information about it.
- Do NOT call `env.up` before `env.init` + `vars.declare`. Containers
  spawn fine, but starting the project surfaces missing-value errors.
- Do NOT run `docker run` directly. easy-env owns container lifecycle
  through `env.up` / `env.down`.
- Do NOT edit `~/.easy-env/projects/<name>/` files by hand. Use the MCP
  tools or the Web UI.
- Do NOT modify the project's source to "make easy-env work". easy-env
  serves the project, not the other way around.
- Do NOT silently skip an `unset` required variable.
