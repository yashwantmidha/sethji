#!/bin/zsh
set -euo pipefail

APP="$HOME/Applications/sethji.app"
BUNDLE_ID="com.yashwantmidha.sethji"

pkill -x sethji >/dev/null 2>&1 || true
rm -rf "$APP"
defaults delete "$BUNDLE_ID" >/dev/null 2>&1 || true

echo "sethji.app removed."
