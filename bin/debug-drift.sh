#!/usr/bin/env bash
# Run katulong locally with drift diagnostic logging enabled.
#
# Usage: bin/debug-drift.sh [level]
#   level 1 (default): high-level events — flush-fffd, backpressure,
#                      pull-bypass, eviction, resync. Cheap enough to
#                      leave on for days to catch a rare bug.
#   level 2:           everything above + deep byte-level parser-fffd
#                      probes with raw chunk hex dumps. Noisy — turn on
#                      when you're actively reproducing.
#
# Kills whatever is on :3001 first (likely the brew-installed katulong)
# and re-execs this checkout.
#
# Log file: ~/.katulong/drift.log
set -euo pipefail

cd "$(dirname "$0")/.."

LEVEL="${1:-1}"
if ! [[ "$LEVEL" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [level]" >&2
  echo "  level must be a non-negative integer (1 or 2 are typical)" >&2
  exit 2
fi

PIDS=$(lsof -ti:3001 || true)
if [ -n "$PIDS" ]; then
  echo "Killing existing process(es) on :3001 — $PIDS"
  kill -9 $PIDS || true
  sleep 0.5
fi

mkdir -p "$HOME/.katulong"
echo "Drift log:   $HOME/.katulong/drift.log"
echo "Drift level: $LEVEL"
echo "Starting katulong (local) on :3001 with KATULONG_DRIFT_LOG=$LEVEL"

export KATULONG_DRIFT_LOG="$LEVEL"
export PORT=3001
exec node server.js
