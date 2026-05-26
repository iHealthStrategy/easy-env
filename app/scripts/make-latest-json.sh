#!/usr/bin/env bash
# Template ./releases/latest.json from the most recent tauri build's
# update artifacts (the .app.tar.gz + .sig files). The repo is public,
# so we emit canonical /releases/download/<tag>/<file> URLs — they're
# stable across releases (no asset-ID lookup needed) and Tauri's
# updater can fetch them anonymously.
#
# ── one-time setup ─────────────────────────────────────────────────
# 1. Generate the updater signing keypair (a minisign keypair — NOT
#    related to Apple Developer ID):
#
#        npx tauri signer generate -w ~/.tauri/easy-env-updater.key
#
#    Paste the printed public key into tauri.conf.json:
#    plugins.updater.pubkey. Stash the private key + its password in
#    1Password / encrypted storage. Losing the key means existing
#    installs can never auto-update again.
#
# 2. Replace the REPLACE_WITH_OWNER / REPLACE_WITH_REPO placeholders in
#    tauri.conf.json's plugins.updater.endpoints with your real repo
#    path. The default points at:
#        https://raw.githubusercontent.com/<owner>/<repo>/master/releases/latest.json
#    — i.e. a file you commit to the master branch. For public repos
#    that URL is anonymously fetchable.
#
# ── per-release ────────────────────────────────────────────────────
# CI (.github/workflows/release.yml) automates everything below on
# `git push origin v<ver>`. Manual flow for local dry-runs:
#
# 1. Bump the version in:
#        app/src-tauri/tauri.conf.json
#        app/package.json
#
# 2. Sign the build (these env vars are what makes tauri emit *.sig):
#        export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/easy-env-updater.key)"
#        export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<your password>"
#
# 3. Build (also runs repackage-dmg.sh for the human-download dmg):
#        npm run tauri:release
#
#    Build outputs land in:
#        src-tauri/target/release/bundle/macos/
#          easy-env.app.tar.gz                        updater archive
#          easy-env.app.tar.gz.sig                    minisign signature
#        src-tauri/target/release/bundle/dmg/
#          easy-env_<ver>_<arch>.dmg                  raw Tauri dmg
#          easy-env_<ver>_<arch>-with-launcher.dmg    + README for xattr
#
# 4. Create the GitHub release and upload artifacts:
#        VER=$(node -p "require('./src-tauri/tauri.conf.json').version")
#        gh release create v$VER \
#          --title "v$VER" --generate-notes \
#          src-tauri/target/release/bundle/macos/easy-env.app.tar.gz \
#          src-tauri/target/release/bundle/macos/easy-env.app.tar.gz.sig \
#          src-tauri/target/release/bundle/dmg/easy-env_${VER}_aarch64-with-launcher.dmg
#
# 5. Generate the manifest and commit to master:
#        ./scripts/make-latest-json.sh v$VER > ../releases/latest.json
#        git add ../releases/latest.json
#        git commit -m "release: v$VER"
#        git push origin master
#
# ── verification ───────────────────────────────────────────────────
#        curl -sSL https://raw.githubusercontent.com/<owner>/<repo>/master/releases/latest.json | head
# Repo is public, so this works without any token; the running app's
# UpdateBanner uses the same anonymous fetch.
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = app/

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <release-tag>      e.g. $0 v0.1.1" >&2
  exit 1
fi
TAG="$1"

BUNDLE_DIR="src-tauri/target/release/bundle/macos"

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# 1. Locate the signed updater archive on disk so we can read its .sig.
TARBALL=$(ls "$BUNDLE_DIR"/*.app.tar.gz 2>/dev/null | head -n1 || true)
SIGFILE="${TARBALL}.sig"
if [[ -z "$TARBALL" ]] || [[ ! -f "$SIGFILE" ]]; then
  echo "error: no signed update artifact at $BUNDLE_DIR/*.app.tar.gz(.sig)." >&2
  echo "       Did you set TAURI_SIGNING_PRIVATE_KEY{,_PASSWORD} before building?" >&2
  exit 1
fi
TAR_NAME=$(basename "$TARBALL")
SIGNATURE=$(cat "$SIGFILE")

# 2. Read endpoint + extract owner/repo. tauri.conf.json is the single
#    source of truth — never hard-code the repo path twice.
ENDPOINT=$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.endpoints[0]")
if [[ "$ENDPOINT" == *REPLACE_WITH_* ]]; then
  echo "error: tauri.conf.json plugins.updater.endpoints still has REPLACE_WITH_* placeholders." >&2
  exit 1
fi
OWNER_REPO=$(echo "$ENDPOINT" | sed -E 's|^https://raw\.githubusercontent\.com/([^/]+/[^/]+)/.*$|\1|')
if [[ "$OWNER_REPO" == "$ENDPOINT" ]]; then
  echo "error: endpoint $ENDPOINT doesn't look like raw.githubusercontent.com/<owner>/<repo>/..." >&2
  exit 1
fi

# 3. Canonical public download URL — stable across releases, anonymous,
#    no API/asset-ID dance.
ASSET_URL="https://github.com/$OWNER_REPO/releases/download/$TAG/$TAR_NAME"

# 4. Emit manifest. Tauri's updater plugin keys platforms by
#    "<os>-<arch>"; on macOS that's darwin-aarch64 / darwin-x86_64.
ARCH_KEY="darwin-aarch64"
if [[ "$TAR_NAME" == *"x86_64"* ]] || [[ "$(uname -m)" == "x86_64" ]]; then
  ARCH_KEY="darwin-x86_64"
fi

# Use python for JSON escaping — newlines / quotes inside SIGNATURE
# would break naive heredoc string-stuffing.
python3 - <<PY
import json
print(json.dumps({
  "version": "$VERSION",
  "notes": "",
  "pub_date": "$PUB_DATE",
  "platforms": {
    "$ARCH_KEY": {
      "signature": """$SIGNATURE""",
      "url": "$ASSET_URL"
    }
  }
}, indent=2, ensure_ascii=False))
PY
