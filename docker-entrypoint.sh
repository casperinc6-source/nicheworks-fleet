#!/bin/sh
# Route every app's SQLite/Vault data into the mounted volume.
#
# Each app writes to `path.join(__dirname, 'data')` — i.e. /app/<app>/data —
# while the persistent volume is mounted once at /app/data. Without this,
# a Fly/Render/Compose restart wipes every ledger while the volume sits empty.
#
# The fix is one symlink per app, created before the hub starts:
#   /app/revenue/data -> /app/data/revenue
#
# Idempotent: safe on every boot, and it works whether or not the app has
# already created its directory.
set -eu

DATA_ROOT="${FLEET_DATA_DIR:-/app/data}"
mkdir -p "$DATA_ROOT"

# Every server.js is one app, including nested ones (hire-me/tracker).
find /app -mindepth 2 -maxdepth 3 -name server.js -not -path '/app/node_modules/*' \
  -not -path '/app/data/*' | while IFS= read -r entry; do
  appdir=$(dirname "$entry")
  rel=${appdir#/app/}
  target="$DATA_ROOT/$rel"

  mkdir -p "$target"

  # A real directory already in the image becomes volume content, once.
  if [ -d "$appdir/data" ] && [ ! -L "$appdir/data" ]; then
    cp -a "$appdir/data/." "$target/" 2>/dev/null || true
    rm -rf "$appdir/data"
  fi

  if [ ! -e "$appdir/data" ]; then
    ln -s "$target" "$appdir/data"
    echo "[entrypoint] $rel/data -> $target"
  fi
done

exec "$@"
