#!/usr/bin/env bash
# Stage a self-contained copy of packages/mcp-server under
# app/src-tauri/mcp-server so Tauri can bundle it as a resource.
#
# Strategy: bundle everything with esbuild into two single-file JS
# artifacts (one for the daemon, one for the MCP stdio server) and
# drop node_modules entirely. We can do this because the production
# dep tree has no native .node files once optional packages are
# omitted (cpu-features under ssh2 is the only native module, and
# ssh2 falls back to pure JS without it). Result: a v0.1.2-sized
# updater archive even with mcp-server bundled.
#
# Why a separate staging dir at all? Because the repo is an npm
# workspace — packages/mcp-server's transitive deps are hoisted into
# the ROOT node_modules, so the package on disk isn't actually
# self-contained. We do a non-workspace install in a fresh location,
# bundle from there, then keep only the outputs.
#
# Inputs (must exist before running):
#   packages/mcp-server/dist/                 (npm run build --workspace easy-env-mcp)
#   packages/mcp-server/{bin,skills,package.json}
#
# Output (staged):
#   app/src-tauri/mcp-server/
#     dist/src/daemon/start.js     bundled daemon entry (~7 MB, all deps inlined)
#     dist/src/server.js           bundled MCP stdio entry (~7 MB, all deps inlined)
#     bin/                         thin shims — tiny, kept for parity
#     skills/                      markdown skills the app copies into ~/.claude/skills
#     package.json                 metadata (deps stripped — they're all bundled)
#
# Idempotent: re-running starts from a clean wipe so leftover dev files
# from a previous build can't contaminate the next bundle.

set -euo pipefail

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

# Copy the same set we used pre-bundle. dist/ is what gets fed to
# esbuild; bin/skills/package.json travel along to the final bundle.
cp -R "$SRC/dist"     "$DEST/dist"
cp -R "$SRC/bin"      "$DEST/bin"
cp -R "$SRC/skills"   "$DEST/skills"
cp    "$SRC/package.json" "$DEST/package.json"

# Install production-only deps inside the staged copy. We need them
# *only* for esbuild's resolution pass — they're deleted after
# bundling. --workspaces=false prevents npm from re-resolving against
# the repo's workspace root (which would hoist and leave node_modules
# empty here). --omit=optional drops native-accel deps that have
# pure-JS fallbacks (cpu-features under ssh2 → testcontainers).
echo "── prepare-mcp-server: installing production deps for bundling ──"
(
  cd "$DEST"
  npm install \
    --omit=dev \
    --omit=optional \
    --workspaces=false \
    --no-package-lock \
    --no-audit \
    --no-fund \
    --loglevel=error
)

# Sanity check: no native modules should have survived the optional
# omit. If any do, esbuild will fail on `require('*.node')`.
if find "$DEST/node_modules" -name "*.node" -print -quit | grep -q .; then
  echo "error: native .node modules present in staged tree — esbuild can't bundle them:" >&2
  find "$DEST/node_modules" -name "*.node" >&2
  exit 1
fi

# Bundle the two real entry points. Each .js becomes a self-contained
# file with every transitive dep inlined; node_modules is then deleted
# below. --platform=node + --format=esm matches mcp-server's "type":
# "module". --keep-names preserves function/class names for slightly
# nicer stack traces in the daemon log. --legal-comments=none strips
# license headers from the output (we ship LICENSEs separately, and
# they'd otherwise add ~500 KB of duplication).
echo "── prepare-mcp-server: bundling with esbuild ──"
ESB_VERSION=0.24.0
bundle_one() {
  local input=$1
  local output=$2
  # The banner is load-bearing — esbuild's ESM output uses a `__require`
  # shim that can't load Node built-ins (`require('timers')`, `require('fs')`,
  # etc.) when bundled CJS dependencies (notably mongodb) call require()
  # at runtime. Installing a real createRequire-backed `require` at the
  # top of every output gives those built-in calls a working escape
  # hatch back to Node's own module system. Without it the daemon
  # explodes the moment mongodb is initialised.
  npx --yes esbuild@$ESB_VERSION \
    "$input" \
    --bundle \
    --platform=node \
    --format=esm \
    --target=node18 \
    --keep-names \
    --legal-comments=none \
    --banner:js="import { createRequire as __createRequire } from 'module'; import { fileURLToPath as __fileURLToPath } from 'url'; import { dirname as __dirnameFn } from 'path'; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirnameFn(__filename);" \
    --outfile="$output" \
    --log-level=warning
}
(
  cd "$DEST"
  # Bundle to temp paths then atomic-move, so a failure mid-bundle
  # doesn't leave a half-written file at the entry the daemon will
  # try to spawn.
  bundle_one "dist/src/daemon/start.js" "dist/src/daemon/start.bundle.js"
  bundle_one "dist/src/server.js"       "dist/src/server.bundle.js"
  mv "dist/src/daemon/start.bundle.js" "dist/src/daemon/start.js"
  mv "dist/src/server.bundle.js"       "dist/src/server.js"
)

# node_modules is no longer needed — every dep got inlined above.
echo "── prepare-mcp-server: dropping node_modules (everything is now bundled) ──"
rm -rf "$DEST/node_modules"

# Strip the dist/ subtrees we no longer reference. The bundled entry
# files are the only JS we actually run from dist/.
echo "── prepare-mcp-server: pruning unreferenced dist files ──"
find "$DEST/dist" -type f -name "*.js" \
  ! -path "$DEST/dist/src/daemon/start.js" \
  ! -path "$DEST/dist/src/server.js" \
  -delete
find "$DEST/dist" -type f \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) -delete
# Remove any empty directories left behind by the pruning above.
find "$DEST/dist" -type d -empty -delete

# Rewrite package.json to drop the now-bundled dependencies. Keeps the
# file useful for "what version of mcp-server is this?" without misleading
# anyone into thinking they could npm install against it.
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(p));
  delete pkg.dependencies;
  delete pkg.devDependencies;
  delete pkg.optionalDependencies;
  pkg.bundled = true;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$DEST/package.json"

# Sanity check — daemon entry must exist or the bundled app will fail to
# spawn the daemon with a confusing "entry not found" error at runtime.
ENTRY=$DEST/dist/src/daemon/start.js
if [[ ! -f "$ENTRY" ]]; then
  echo "error: $ENTRY missing after bundle — daemon won't start" >&2
  exit 1
fi

echo "── prepare-mcp-server: done ──"
du -sh "$DEST" "$DEST/dist" 2>/dev/null || true
ls -la "$DEST/dist/src/daemon/start.js" "$DEST/dist/src/server.js"
