#!/usr/bin/env bash
# Repackage Tauri's macOS .dmg so first-time users can run the unsigned
# .app without manual Gatekeeper hoops.
#
# What this adds to the dmg:
#   - README.txt   one-line terminal command + bilingual context
#
# Why: Tauri's default build ad-hoc-signs the .app (required on Apple
# Silicon) but doesn't have a Developer ID cert, so macOS slaps a
# com.apple.quarantine xattr on it when downloaded. Gatekeeper then
# refuses to open it directly. The README tells users to clear that
# xattr; a .command launcher was considered but rejected because it
# would itself be quarantined (needing the same right-click ceremony,
# saving the user zero clicks while adding a confusing extra file).
#
# Usage:
#   cd app
#   npm run tauri:build
#   ./scripts/repackage-dmg.sh
# Or wire it into npm scripts as "postbundle" / "release".
set -euo pipefail

cd "$(dirname "$0")/.."  # cwd = app/

BUNDLE_DIR="src-tauri/target/release/bundle"
DMG_DIR="$BUNDLE_DIR/dmg"
APP_DIR="$BUNDLE_DIR/macos"

# Find the .dmg Tauri just emitted. There should be exactly one per
# build; if there are stale ones from older runs, take the newest.
SRC_DMG=$(ls -t "$DMG_DIR"/*.dmg 2>/dev/null | head -n1 || true)
if [[ -z "$SRC_DMG" ]]; then
  echo "error: no .dmg found under $DMG_DIR — did 'tauri build' run?" >&2
  exit 1
fi
echo "→ source dmg: $SRC_DMG"

# Locate the .app (Tauri emits it both in macos/ and inside the dmg;
# pulling from macos/ skips a mount step).
APP_SRC=$(ls -d "$APP_DIR"/*.app 2>/dev/null | head -n1 || true)
if [[ -z "$APP_SRC" ]]; then
  echo "error: no .app found under $APP_DIR" >&2
  exit 1
fi
APP_NAME=$(basename "$APP_SRC")
echo "→ source app: $APP_SRC"

# Stage directory the new dmg will be built from.
STAGE=$(mktemp -d -t easy-env-dmg-stage)
trap 'rm -rf "$STAGE"' EXIT
echo "→ staging at: $STAGE"

# 1. Copy the .app verbatim (preserve symlinks, metadata).
ditto "$APP_SRC" "$STAGE/$APP_NAME"

# 2. /Applications drag-target.
ln -s /Applications "$STAGE/Applications"

# 3. README — plain text so Quick Look + every editor renders cleanly.
#    Bilingual; the actual user-actionable content is one terminal
#    command, everything else is context.
cat > "$STAGE/README.txt" <<'README_EOF'
easy-env — 首次安装步骤 / First-time install
=============================================

【中文】

1. 把左边的 easy-env.app 拖到右边的 Applications 文件夹里

2. 打开「终端」,粘贴这一行,回车:

       xattr -dr com.apple.quarantine /Applications/easy-env.app

3. 正常双击 easy-env.app 启动。以后再启动不需要重复第 2 步。

为什么需要这一步:这个应用没有用 Apple Developer ID 签名,macOS
对从网上下载的未签名应用会标上"隔离区(quarantine)"标志,启动时
会被 Gatekeeper 拦截。上面那条命令只是清掉一个标记 xattr,不会
修改任何代码、权限或文件内容。

------------------------------------------

[English]

1. Drag easy-env.app to the Applications folder on the right.

2. Open Terminal, paste this single line, press Enter:

       xattr -dr com.apple.quarantine /Applications/easy-env.app

3. Double-click easy-env.app to launch. Subsequent launches do not
   need step 2.

Why this is needed: the app is not signed with an Apple Developer ID,
so macOS marks internet-downloaded copies with a "quarantine" xattr
and Gatekeeper refuses to launch them. The command above only clears
that one xattr; it does not modify any code, permissions, or files.
README_EOF

# 4. Build the new dmg from the staging dir.
#    UDZO = compressed zlib; same format Tauri uses, smaller than UDRW.
#    Volume name shows up in Finder when the user mounts.
VOL_NAME="easy-env"
OUT_DMG="${SRC_DMG%.dmg}-with-launcher.dmg"
rm -f "$OUT_DMG"
echo "→ building: $OUT_DMG"
hdiutil create \
  -volname "$VOL_NAME" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$OUT_DMG" >/dev/null

# 5. Final report.
SIZE=$(du -h "$OUT_DMG" | cut -f1)
echo ""
echo "✓ Repackaged dmg ready:"
echo "    $OUT_DMG ($SIZE)"
echo ""
echo "Original Tauri dmg is left untouched at:"
echo "    $SRC_DMG"
echo ""
echo "Distribute the *-with-launcher.dmg to users."
