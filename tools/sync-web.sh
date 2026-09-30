#!/usr/bin/env bash
# Copies the GameWall remote (single source: GameWallControlServer/wwwroot) into GameDay's
# /wall/ folder, and the networks map into GameDay's API. Run before deploying web/.
set -euo pipefail
cd "$(dirname "$0")/.."
src=GameWallControlServer/wwwroot
dst=web/wall
mkdir -p "$dst"
for f in index.html app.js style.css gameday-theme.css panel.html panel.js wall-cloud.js; do
  cp "$src/$f" "$dst/$f"
done
cp GameWallControlServer/networks.json web/api/_lib/networks.json
echo "Synced remote -> $dst"
