#!/usr/bin/env bash
# Stage a self-contained copy of packages/mcp-server under
# app/src-tauri/mcp-server so Tauri can bundle it as a resource.
#
# Why a separate staging dir instead of bundling packages/mcp-server
# directly? The repo is an npm workspace — packages/mcp-server's
# transitive deps are hoisted into the ROOT node_modules, so the
# package on disk isn't actually self-contained. To get a working
# tree we need to install --omit=dev INSIDE a copy that's no longer
# inside the workspace (workspaces=false tells npm "this is just a
# regular project").
#
# Inputs (must exist before running):
#   packages/mcp-server/dist/                 (run: npm run build --workspace easy-env-mcp)
#   packages/mcp-server/{bin,skills,package.json}
#
# Output:
#   app/src-tauri/mcp-server/
#     dist/                production JS the daemon and MCP server run from
#     bin/                 thin shims; not strictly needed but tiny and useful
#     skills/              markdown skills the app copies into ~/.claude/skills
#     package.json         metadata; "main"/"bin" entries help node resolve
#     node_modules/        production-only transitive deps (~75M)
#
# Idempotent: re-running starts from a clean wipe so leftover dev files
# from a previous build can't contaminate the next bundle.

set -euo pipefail

# Resolve repo paths from this script's own location — works regardless
# of where the caller invokes it from (npm script, GitHub Actions, dev
# shell).
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$APP_DIR/.." && pwd)
SRC=$REPO_ROOT/packages/mcp-server
DEST=$APP_DIR/src-tauri/mcp-server

if [[ ! -f "$SRC/package.json" ]]; then
  echo "error: $SRC/package.json not found — wrong working directory?" >&2
  exit 1
fi
if [[ ! -d "$SRC/dist" ]]; then
  echo "error: $SRC/dist not found. Build mcp-server first:" >&2
  echo "       npm run build --workspace easy-env-mcp" >&2
  exit 1
fi

echo "── prepare-mcp-server: staging $DEST ──"
rm -rf "$DEST"
mkdir -p "$DEST"

# Copy only what the daemon + server need at runtime. src/ is excluded
# (tsc output in dist/ is what actually executes); test/ excluded too.
cp -R "$SRC/dist"     "$DEST/dist"
cp -R "$SRC/bin"      "$DEST/bin"
cp -R "$SRC/skills"   "$DEST/skills"
cp    "$SRC/package.json" "$DEST/package.json"

# Install production-only deps inside the staged copy. --workspaces=false
# prevents npm from re-resolving against the repo's workspace root (which
# would hoist and leave node_modules empty here). --no-package-lock keeps
# us from baking a fresh lockfile into the bundle.
echo "── prepare-mcp-server: installing production deps ──"
(
  cd "$DEST"
  npm install \
    --omit=dev \
    --workspaces=false \
    --no-package-lock \
    --no-audit \
    --no-fund \
    --loglevel=error
)

# Sanity check — daemon entry must exist or the bundled app will fail to
# spawn the daemon with a confusing "entry not found" error at runtime.
ENTRY=$DEST/dist/src/daemon/start.js
if [[ ! -f "$ENTRY" ]]; then
  echo "error: $ENTRY missing after stage — daemon won't start in packaged app" >&2
  exit 1
fi

# Report sizes so a CI log makes it obvious if node_modules ballooned.
echo "── prepare-mcp-server: done ──"
du -sh "$DEST" "$DEST/node_modules" "$DEST/dist" 2>/dev/null || true
