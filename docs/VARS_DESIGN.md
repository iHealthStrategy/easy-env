# Variables management — design

**Status:** approved, ready for implementation.

Make easy-env the registry of all environment variables a project needs to
run, so the AI can fetch them by project name and inject into any process
it spawns. User-defined values are managed exclusively through the Web UI;
the project's `easy-env.json` only declares which variable *names* exist.

## Data shape

### `easy-env.json` (in project, committed)

```jsonc
{
  "version":  1,
  "name":     "blog-backend",
  "backends": { /* existing */ },
  "app":      { /* existing */ },
  "variables": [
    "API_PREFIX",
    "FEATURE_NEW_PIPELINE",
    "OPENAI_API_KEY"
  ]
}
```

Just a list of names. No types, no defaults, no description. Anything the
AI needs to know about a variable, it can grep from the code.

The `name` field is the **primary key** for variable values. Two checkouts
sharing a name intentionally share user values — that's the right
behaviour, they are the same logical project.

### `~/.easy-env/projects/{name}/vars.json` (per user, daemon-owned)

```jsonc
{
  "API_PREFIX": "/api/v1",
  "FEATURE_NEW_PIPELINE": true,
  "OPENAI_API_KEY": "sk-..."
}
```

User does NOT hand-edit this. The Web UI is the only write path. Daemon
creates the directory on first write.

## Variable sources

When `vars.list` returns values, every entry carries a `source`:

| source | meaning | editable? |
|--------|---------|-----------|
| `user` | set in `~/.easy-env/projects/{name}/vars.json` via Web UI | yes |
| `container` | dynamically injected by `env.up` (e.g. `MONGO_URL`, `REDIS_URL`) for the active env | no |
| `unset` | declared in `easy-env.json` but no user value yet | (it's the act of setting that makes it `user`) |

Container vars live in the same namespace as user vars — one call to
`vars.list` and the AI has everything it needs to spread into
`spawn({ env: ... })`. If a project's `variables` array also lists a name
that collides with a container var (e.g. user declared `MONGO_URL`),
the container value wins because container vars are not editable.

## MCP tools

| Tool | Signature | Notes |
|------|-----------|-------|
| `vars.init` | `{ dryRun?: boolean }` → `{ proposal: string[], evidence: Record<string, string[]> }` | Scans `.env`, `.env.example`, `docker-compose.yaml`, and `process.env.X` references in source. `dryRun: true` (default) returns the proposed names + per-name rationale; `dryRun: false` writes them into `easy-env.json#variables` (merged with existing). |
| `vars.list` | `{}` → `Record<name, { value: unknown, source: 'user' \| 'container' \| 'unset' }>` | Returns the resolved view for the active project + active env. The AI's bread-and-butter call before spawning a process. |
| `vars.set` | `{ name, value }` → `{ name, value, source: 'user' }` | Writes a single user value. UI is the primary writer, but the tool exists so an AI can do programmatic bootstrap if explicitly asked. Refuses to set names not declared in `variables`. |
| `vars.unset` | `{ name }` → `{ name }` | Removes a user value (next `vars.list` shows `source: 'unset'`). |

There is no per-env override — same variable values across all envIds of
the same project. Container vars are per-env naturally because each
`env.up` allocates fresh ports.

## Daemon HTTP endpoints

Same surface, exposed as REST for the Web UI:

| Method | Path | Body / Response |
|--------|------|-----------------|
| GET    | `/api/vars` | `vars.list` output |
| PUT    | `/api/vars/:name` | `{ value }` → `vars.set` |
| DELETE | `/api/vars/:name` | `vars.unset` |
| POST   | `/api/vars/init?dryRun=1` | `vars.init` |

All routes operate on the active project (read from the daemon's loaded
`easy-env.json`).

## `vars.init` scanner

Inputs scanned, in priority order:

1. `.env` and `.env.example` at project root — every `KEY=` line.
2. `docker-compose.yaml` / `docker-compose.yml` — `services.*.environment`
   (object or array form) and the contents of any `services.*.env_file`
   files. (Compose env vars are gold: they're already what the user runs
   the app with.)
3. Codebase grep — `process\.env\.([A-Z_][A-Z0-9_]*)`, scoped to
   `src/`, `lib/`, `app/`, etc.; respect `.gitignore`.

Each candidate name comes with a list of source citations ("found in
`.env.example`", "referenced in `src/billing.ts:42`"). Names already
declared in `variables` are deduplicated. Names that look like
container vars easy-env already injects (`MONGO_URL`, `MONGO_DB_NAME`,
`REDIS_URL`) are filtered out — they shouldn't be in the user list.

The dry-run output is the proposal; the agent should show it to the
user, take edits, and only then call with `dryRun: false`.

## Web UI

### Sidebar gains a "Variables" entry → `/vars`

Page sections:

1. **Header** — project name (from `easy-env.json#name`), with a hint
   "values stored at `~/.easy-env/projects/<name>/vars.json`".
2. **Variables table** — rows for every name in `variables` plus every
   container var:
   - `name` (code)
   - `value` — inline editable for `user`/`unset` rows; rendered as code
     for `container` rows
   - `source` — badge (`user` / `container` / `unset`)
   - actions — `[Save]` after edit; `[Clear]` for `user` rows to revert
     to `unset`
3. **Init button** — calls `vars.init?dryRun=1`, shows the proposal in a
   modal, "Apply" calls again with `dryRun=0`. (Useful when the user
   adds a new variable to the codebase and wants the UI to pick it up.)

The Web UI is **the** management surface — no client-side editor for
`easy-env.json#variables` beyond the init flow.

## AI consumption example

```ts
// agent picks up where to run the app
const vars = await mcp.call('vars.list', {});
const env  = Object.fromEntries(
  Object.entries(vars).map(([k, v]) => [k, String(v.value ?? '')]),
);
spawn('npm', ['start'], { env: { ...process.env, ...env } });
```

Done. No per-variable lookup, no container/user splits to merge.

## Out of scope

- Encryption — file system permissions on `~/.easy-env` are sufficient
  for the single-user-on-laptop case
- Variable interpolation (`${OTHER}`) — defer; not asked for
- Audit log of value changes — the daemon's existing activity log
  already records `vars.set` calls
- Multi-project sync — orthogonal; if needed later, layer a sync tool
  on top of `~/.easy-env/projects/`

## Migration

- Existing `easy-env.json` files don't have `name` or `variables`. The
  daemon should treat both as optional:
  - missing `name` → vars features disabled, log a one-time hint
  - missing `variables` → empty array, only container vars surface
- `vars.init` is the recommended way to populate `variables` for the
  first time on an existing project.
