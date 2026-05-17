# easy-env app (Tauri desktop)

Native desktop manager for easy-env. Replaces the browser-served Web UI in
`packages/web` with a Tauri shell that **also** owns:

- starting/stopping the embedded **easy-env daemon** as a child process
- installing/uninstalling the **Claude Code skill** (writes
  `~/.claude/skills/easy-env-bootstrap.md`)
- registering/unregistering the **MCP stdio server** in `~/.claude.json`

Everything that used to require running CLI helpers
(`easy-env-install-skill.mjs`, hand-editing `.claude.json`, manually
launching the daemon) is now a toggle in **Settings**.

The data surfaces — Environments, Variables, Snapshots, Diffs, MCP Service
— still talk to the same daemon HTTP API in `packages/mcp-server`, but
requests are tunneled through a Rust `daemon_fetch` command to bypass
WebView CORS.

## Layout

```
app/
├── package.json        # frontend deps + scripts
├── vite.config.ts      # Vite 5 + React, proxies /api in dev
├── index.html
├── src/                # React + TS frontend
│   ├── App.tsx · main.tsx · styles.css
│   ├── api/            # daemon HTTP client + Tauri command wrappers
│   ├── components/     # shared bits (DaemonStatusBar, QueryState, format)
│   ├── i18n/           # tool descriptions (zh)
│   └── pages/          # EnvsList / Variables / Snapshots / Diffs / MCP / Settings
└── src-tauri/          # Rust shell
    ├── Cargo.toml · tauri.conf.json · build.rs
    ├── capabilities/   # window permissions
    └── src/
        ├── main.rs       # entry
        ├── lib.rs        # Tauri commands + plugin wiring
        ├── daemon.rs     # spawn/kill the Node daemon, poll /api/health
        ├── skill.rs      # copy .md skills into ~/.claude/skills
        ├── mcp_config.rs # patch ~/.claude.json
        └── paths.rs      # locate the monorepo + dist artifacts
```

## Prerequisites

- **Rust** (1.77+) with `cargo`
- **Node** 18+ and `npm`
- **Tauri CLI** v2 — `cargo install tauri-cli --version "^2.0"` *(already
  installed on this machine; verify with `cargo tauri --version`)*
- **Docker** running (the daemon uses Testcontainers)

Before first launch, build the mcp-server dist that the app embeds:

```bash
cd ..   # repo root
npm install
npm run build --workspace easy-env-mcp
```

## Develop

```bash
# from app/
npm install
npm run tauri:dev
```

That command:
1. starts Vite on `http://localhost:5174`
2. builds the Rust shell (debug)
3. opens the easy-env window

Flip the toggles in **Settings** to start the daemon, install the skill,
and register the MCP server. The sidebar status dot turns green once the
daemon `/api/health` responds.

## Build a release bundle

```bash
npm run tauri:build
```

Outputs to `src-tauri/target/release/bundle/`. Note: the bundled binary
still expects the `packages/mcp-server/dist/` artifacts to exist beside
it (in dev that's the monorepo, for true distribution we'd need to copy
those into Tauri resources — left as a follow-up).

## Iterate on UI only

If you just want the React UI without compiling Rust:

```bash
npm run dev          # plain Vite on :5174, fetch() falls back to /api proxy
```

The Tauri-only Settings page will show "Tauri runtime not detected" — use
`npm run tauri:dev` to exercise Settings.
