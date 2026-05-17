---
name: easy-env-bootstrap
description: Use the easy-env MCP server to provision a project's runtime
  environment from scratch — fix backend container ports, declare
  required env variables, spawn Mongo/Redis, and start the project with
  all values injected. Trigger when the user says things like "用
  easy-env 跑起这个项目", "用 easy-env 配好这个项目的环境", "set up
  this project with easy-env", "initialize easy-env for this project",
  "let easy-env manage this app's vars".
---

# easy-env bootstrap

You are wiring an existing project into easy-env so it (and you, future
sessions) can run it reproducibly. easy-env owns the backend containers
(Mongo, Redis) and the env-var registry; the project's `easy-env.json`
declares which variable *names* this project needs.

## Before you start

- The current working directory must be inside the project that has (or
  will have) `easy-env.json`.
- The daemon auto-starts on first MCP call. If a tool errors with
  "daemon …" verify that the easy-env MCP server is installed in this
  Claude Code session.
- The Web UI lives at `http://127.0.0.1:7193/` once the daemon is up.

## Workflow — do steps in order, do not skip

### 1. Ensure `easy-env.json` exists and has a `name`

Read `easy-env.json` at the project root.

- **Missing entirely**: refuse and ask the user to create a stub. Suggest:
  ```json
  { "version": 1, "name": "<project-name>" }
  ```
  Do not silently create it — naming is a user decision.
- **Has no `name` field**: ask the user for one, then write it in. The
  daemon stores variable values under `~/.easy-env/projects/<name>/`,
  so the name is the long-lived identity.

### 2. Fix backend container ports — call `env.init`

```
env.init { dryRun: true }
```

Show the user the proposal — which ports easy-env will allocate, and
whether they came from an existing `docker-compose.*` file or from
defaults. Once they approve, apply:

```
env.init { dryRun: false }
```

This writes `backends.mongo.port` and `backends.redis.port` into
`easy-env.json`. From now on, MONGO_URL and REDIS_URL stay stable
across `env.up` cycles — user-set variables can safely hardcode them.

**If env.init proposes a port that is already in use on macOS** (7000,
5000, 7001 — Apple's ControlCenter), suggest swapping to a safer default
(27818, 6480) by editing the config or re-running env.init.

### 3. Discover required env variables — call `vars.init`

```
vars.init { dryRun: true }
```

Returns `additions[]`, each with `name` and `evidence` (where the
variable was found: a .env file, docker-compose service, or
`process.env.X` reference in source). Read this list to the user and
confirm. Then apply:

```
vars.init { dryRun: false }
```

This writes the names into `easy-env.json#variables`. **Container vars
(MONGO_URL, REDIS_URL, MONGO_DB_NAME) are filtered out** — they're
auto-injected, the user never sets them.

### 4. Spawn the backend — call `env.up`

```
env.up {}
```

Expect `status: "ready"` and the resolved URLs. If it errors
"port already in use", show the message to the user verbatim — they
need to free the port or change `backends.<x>.port` in `easy-env.json`.

### 5. Fill user-managed variable values

Call `vars.list` and inspect each entry's `source`:

- `container` — auto-injected, nothing to do
- `user` — already has a value, leave alone unless the user wants to change
- `unset` — **must be filled before running the project**

For each `unset` variable, ask the user how to set it. Two options:

- **Send them to the Web UI** at `http://127.0.0.1:7193/vars` — preferred
  for many variables or for secret-ish ones
- **Set inline via `vars.set`** — when the user gives you a value in
  conversation. Example:
  ```
  vars.set { name: "JWT_SECRET", value: "dev-jwt-secret" }
  ```

Common derived values you should propose (and confirm) without making
the user type them:

- `REDIS_HOST` = `localhost`
- `REDIS_PORT` = same number as in `REDIS_URL`
- For projects with multiple Mongo connections (`MONGO_BG`, `MONGO_BP`,
  etc.), point each at the local Mongo with a different dbname — the
  "multi-db cheat":
  ```
  vars.set { name: "MONGO_BG", value: "mongodb://localhost:<port>/bg" }
  ```
  where `<port>` is the fixed `backends.mongo.port` from step 2.

**Never invent values for genuine secrets** (real API keys, prod
credentials). Ask the user — for dev environments a placeholder string
is usually fine, but make it explicit.

### 6. Verify all required vars are set

Call `vars.list` again. If any variable the project depends on is still
`source: "unset"`, STOP and report. Do not try to run the project until
every required variable has a value or the user explicitly says "skip
that one".

### 7. Start the project

Spread the resolved vars into the spawn environment:

```ts
const { variables } = await mcp.call('vars.list', {});
const env = Object.fromEntries(
  Object.entries(variables)
    .filter(([, v]) => v.source !== 'unset')
    .map(([k, v]) => [k, String(v.value ?? '')])
);
spawn(<startCommand>, { env: { ...process.env, ...env } });
```

For projects that need a build step (Babel, TypeScript, Webpack), run
the build first. Look at `package.json#scripts` to find the right command
(usually `npm run build` or `npm run babel:build`).

Confirm the project is up by hitting its health endpoint, GraphQL
endpoint, or whatever sanity check the project has. Report the URL and
PID to the user.

## After bootstrap

The user can now re-run the project any time with the same flow steps
4 (`env.up`) and 7 (start with `vars.list` env). Steps 1-3 only need to
run once, or when the project's variable surface changes (someone adds
a new `process.env.X` reference).

If anything errors weirdly, suggest the user check the daemon's MCP
Service tab in the Web UI (`http://127.0.0.1:7193/mcp`) — the activity
log shows every tool call with status and error message.

## What you DO NOT do

- Do not run `docker run` directly. easy-env owns container lifecycle
  through `env.up` / `env.down`.
- Do not edit `~/.easy-env/projects/<name>/vars.json` by hand. Use
  `vars.set` / the Web UI.
- Do not modify the project's source to "make easy-env work". easy-env
  serves the project, not the other way around. If a project expects
  `MONGO_URL` to include `/dbname`, that's already handled — vars.list
  returns it that way.
- Do not silently skip an `unset` required variable.
