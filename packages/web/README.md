# easy-env-web

Read-only admin UI for the easy-env daemon. Lets you inspect:

- managed environments (status, container image, host port, resolved URLs)
- snapshot artifacts produced by `state.capture`
- diff artifacts produced by `diff.compare`

Data is read from the daemon HTTP API (see
[`../../docs/DAEMON_API.md`](../../docs/DAEMON_API.md)). The UI does no
container operations yet — those will arrive in Phase 3.

## Development

```bash
# from the repo root, start the daemon first
npm run daemon          # http://127.0.0.1:7193

# then start the Vite dev server (proxies /api → daemon)
npm run web             # http://localhost:5173
```

Set `EASY_ENV_DAEMON_URL` if your daemon is on a non-default host/port:

```bash
EASY_ENV_DAEMON_URL=http://127.0.0.1:8000 npm run web
```

## Production

The daemon serves the built SPA directly. After `npm run build`, hit
`http://127.0.0.1:7193/` — the daemon resolves `packages/web/dist`
relative to its own location, or honors `EASY_ENV_WEB_DIST` if set.

## Stack

- React 18 + TypeScript
- React Router v6
- TanStack Query v5
- Vite 5
- No UI framework — plain CSS in `src/styles.css`
