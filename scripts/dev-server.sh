#!/usr/bin/env bash
set -euo pipefail

# Run the local git checkout as the katulong server on port 3001, against
# the real ~/.katulong data dir, so you can iterate against live sessions
# and pub/sub topics without touching a staging directory.
#
# The Homebrew-installed katulong + its LaunchAgent are unloaded for the
# duration of the dev run. After the dev server exits, run
# `katulong service install` (or `launchctl bootstrap`) to restore the
# brew-managed instance.
#
# Usage:
#   ./scripts/dev-server.sh            # port 3001
#   PORT=3002 ./scripts/dev-server.sh  # override port

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }

PORT="${PORT:-3001}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  err "PORT must be numeric (got: $PORT)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Unload the LaunchAgent so brew's katulong stops auto-respawning.
PLIST="$HOME/Library/LaunchAgents/com.dorkyrobot.katulong.plist"
if [ -f "$PLIST" ]; then
  log "Unloading LaunchAgent (will be restorable via 'katulong service install')"
  launchctl bootout "gui/$UID/com.dorkyrobot.katulong" 2>/dev/null || true
fi

# 2. Free the port. Any lingering brew-katulong or prior dev instance gets
#    SIGTERM; a second pass sends SIGKILL to anything stubborn.
occupant=$(lsof -ti:"$PORT" 2>/dev/null || true)
if [ -n "$occupant" ]; then
  log "Freeing port $PORT (pids: $occupant)"
  kill $occupant 2>/dev/null || true
  sleep 1
  occupant=$(lsof -ti:"$PORT" 2>/dev/null || true)
  if [ -n "$occupant" ]; then
    warn "Still bound, sending SIGKILL to $occupant"
    kill -9 $occupant 2>/dev/null || true
    sleep 1
  fi
fi

if lsof -ti:"$PORT" >/dev/null 2>&1; then
  err "port $PORT is still in use"
  lsof -nP -iTCP:"$PORT" >&2 || true
  exit 1
fi

# 3. Surface the version so you can tell this is the local build at a glance.
VERSION=$(node -p "require('./package.json').version")
log "katulong dev @ v$VERSION  →  http://localhost:$PORT"
log "data dir: ${KATULONG_DATA_DIR:-$HOME/.katulong}  (real data, not staging)"
log "Ctrl-C stops the server. Run 'katulong service install' to bring brew back."

# 4. Exec so signals go straight to node and there's no bash wrapper in the
#    process tree hiding the real server.
exec env PORT="$PORT" node server.js
