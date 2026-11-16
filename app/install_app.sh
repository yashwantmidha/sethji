#!/bin/zsh
set -euo pipefail

# Build sethji.app (menu-bar front-end for the sethji CLI) with swiftc and
# install it to ~/Applications. No Xcode project, no dependencies — same
# recipe as a single-file swiftc app.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT_DIR/app/SethjiApp.swift"
APP="$HOME/Applications/sethji.app"
BUNDLE_ID="com.yashwantmidha.sethji"
# App version tracks package.json so the two never drift.
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -1)"
MODULE_CACHE="$(mktemp -d /tmp/sethji-swift-cache.XXXXXX)"
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"

cleanup() {
  rm -rf "$MODULE_CACHE"
}
trap cleanup EXIT

if [[ ! -f "$SRC" ]]; then
  echo "Source file not found: $SRC"
  exit 1
fi

# Stop a running copy before overwriting its binary.
pkill -x sethji >/dev/null 2>&1 || true

mkdir -p "$APP/Contents/MacOS"

# Multi-file swiftc only allows top-level code in a file named main.swift,
# so the app source is compiled under that name alongside the shared icon art.
cp "$SRC" "$MODULE_CACHE/main.swift"
SWIFTC_ARGS=(-O -module-cache-path "$MODULE_CACHE" \
  "$MODULE_CACHE/main.swift" "$ROOT_DIR/app/IconArt.swift" \
  -o "$APP/Contents/MacOS/sethji")
if [[ -n "$SDK_PATH" ]]; then
  SWIFTC_ARGS=(-sdk "$SDK_PATH" "${SWIFTC_ARGS[@]}")
fi
swiftc "${SWIFTC_ARGS[@]}"

# Model/effort dropdown suggestions — the app prefers ~/.config/sethji/models.json.
mkdir -p "$APP/Contents/Resources"
cp "$ROOT_DIR/app/models.json" "$APP/Contents/Resources/models.json"

# App icon: render a 1024px PNG (same IconArt.swift the app draws its
# menu-bar icon from), then build the .icns.
# Non-fatal — the app just keeps the generic icon if any tool is missing.
ICON_TMP="$(mktemp -d /tmp/sethji-icon.XXXXXX)"
if swiftc -module-cache-path "$MODULE_CACHE" \
     "$ROOT_DIR/app/IconArt.swift" "$ROOT_DIR/app/make_icon.swift" \
     -o "$ICON_TMP/make_icon" >/dev/null 2>&1 \
   && "$ICON_TMP/make_icon" "$ICON_TMP/icon_1024.png" >/dev/null 2>&1; then
  ICONSET="$ICON_TMP/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_TMP/icon_1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z "$d" "$d" "$ICON_TMP/icon_1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  mkdir -p "$APP/Contents/Resources"
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" >/dev/null
else
  echo "note: icon render failed; keeping generic app icon" >&2
fi
rm -rf "$ICON_TMP"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>sethji</string>
  <key>CFBundleExecutable</key>
  <string>sethji</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION:-0.0.0}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

# Ad-hoc signature so notifications and TCC behave.
codesign --force -s - "$APP" >/dev/null 2>&1 || true

# Point the app at this repo's CLI so it works without a global npm install.
defaults write "$BUNDLE_ID" SethjiCLI "$ROOT_DIR/bin/cli.js"

open "$APP"
echo "sethji.app installed to ~/Applications and launched."
echo "Look for the sethji boss icon in the menu bar — click it, pick a project folder, type a task, Run crew."
