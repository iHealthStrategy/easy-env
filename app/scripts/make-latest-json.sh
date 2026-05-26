#!/usr/bin/env bash
# Template ./latest.json from the most recent tauri build's update
# artifacts (the .app.tar.gz + .sig files) plus the asset IDs of a
# GitHub Release you've already created. Designed for a PRIVATE repo:
# every URL it emits is rewritten to the GitHub *API* form
# (https://api.github.com/repos/.../releases/assets/<id>) so the
# updater can authenticate with each user's own gh token instead of
# requiring a shared secret baked into the app bundle.
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
#    — i.e. a file you commit to the master branch. raw.githubusercontent
#    accepts `Authorization: Bearer <token>` for private repos, so the
#    URL stays the same across releases (you just rewrite the file).
#
# 3. Make sure your coworkers have `gh` installed + authenticated:
#        gh auth login
#    (or set GITHUB_TOKEN in their environment).
#
# ── per-release ────────────────────────────────────────────────────
# 1. Bump the version in:
#        app/src-tauri/tauri.conf.json
#        app/package.json
#        app/src-tauri/Cargo.toml  (if you keep it in sync)
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
#          --title "v$VER" \
#          --notes-file CHANGELOG-v$VER.md \
#          src-tauri/target/release/bundle/macos/easy-env.app.tar.gz \
#          src-tauri/target/release/bundle/macos/easy-env.app.tar.gz.sig \
#          src-tauri/target/release/bundle/dmg/easy-env_${VER}_aarch64-with-launcher.dmg
#
# 5. Generate latest.json from the just-uploaded release:
#        ./scripts/make-latest-json.sh v$VER > ../releases/latest.json
#
#    (Optional: keep a versioned copy as well, e.g. releases/v$VER.json,
#    so you can roll back the "latest" pointer without re-uploading
#    binaries.)
#
# 6. Commit the manifest and push to master:
#        git add releases/latest.json
#        git commit -m "release: v$VER"
#        git push
#
#    Done. Running easy-env instances pick up the new version on their
#    next periodic check (~6 hours, or on next launch).
#
# ── verification ───────────────────────────────────────────────────
# Smoke test the auth-headers flow without an actual release:
#        gh auth token | head -c 8 && echo  # confirm gh has a token
#        curl -sSL -H "Authorization: Bearer $(gh auth token)" \
#          https://raw.githubusercontent.com/<owner>/<repo>/master/releases/latest.json \
#          | head
# If that returns your latest.json, the updater will work for any
# coworker with read access.
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = app/

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <release-tag>      e.g. $0 v0.1.1" >&2
  echo "       (the tag must already exist on GitHub via gh release create)" >&2
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

# 2. Read endpoint placeholder + extract owner/repo. We trust whatever
#    tauri.conf.json says rather than re-asking; that file is the
#    single source of truth.
ENDPOINT=$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.endpoints[0]")
if [[ "$ENDPOINT" == *REPLACE_WITH_* ]]; then
  echo "error: tauri.conf.json plugins.updater.endpoints still has REPLACE_WITH_* placeholders." >&2
  exit 1
fi
# Extract owner/repo from raw.githubusercontent URL form.
OWNER_REPO=$(echo "$ENDPOINT" | sed -E 's|^https://raw\.githubusercontent\.com/([^/]+/[^/]+)/.*$|\1|')
if [[ "$OWNER_REPO" == "$ENDPOINT" ]]; then
  echo "error: endpoint $ENDPOINT doesn't look like raw.githubusercontent.com/<owner>/<repo>/..." >&2
  exit 1
fi

# 3. Look up the just-uploaded asset's numeric ID via gh. This is the
#    piece that lets us emit API URLs (which honor Authorization: Bearer)
#    instead of releases/download URLs (which redirect to S3 and strip
#    auth headers).
if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found. Install it (brew install gh) and re-run." >&2
  exit 1
fi
ASSET_ID=$(gh api -H "Accept: application/vnd.github+json" \
  "repos/$OWNER_REPO/releases/tags/$TAG" \
  --jq ".assets[] | select(.name == \"$TAR_NAME\") | .id")
if [[ -z "$ASSET_ID" ]]; then
  echo "error: asset $TAR_NAME not found on release $TAG of $OWNER_REPO." >&2
  echo "       Run 'gh release upload $TAG $TARBALL' first." >&2
  exit 1
fi

ASSET_URL="https://api.github.com/repos/$OWNER_REPO/releases/assets/$ASSET_ID"

# 4. Emit manifest. Tauri's updater plugin keys platforms by
#    "<os>-<arch>"; on macOS that's darwin-aarch64 / darwin-x86_64.
#    For now we publish a single arch; expand the platforms block when
#    you start cross-compiling.
ARCH_KEY="darwin-aarch64"
if [[ "$TAR_NAME" == *"x86_64"* ]] || [[ "$(uname -m)" == "x86_64" ]]; then
  ARCH_KEY="darwin-x86_64"
fi

# Use python for JSON escaping — newlines / quotes inside SIGNATURE
# would break naive heredoc string-stuffing.
python3 - <<PY
import json, sys
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
