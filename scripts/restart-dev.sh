#!/usr/bin/env bash
set -euo pipefail

# Restart the dev server (scripts/dev-server.sh) in a fully detached
# background process. Safe to invoke from inside a katulong terminal you're
# actively using: if your shell/SSH dies mid-restart, the detached worker
# keeps going and brings the server back on its own.
#
# How the detach works:
#   - We re-exec ourselves with KATULONG_RESTART_DETACHED=1 via `nohup` and
#     `disown`, redirecting stdin/stdout/stderr to a log file. The child
#     process no longer has a controlling terminal, so SIGHUP from the
#     parent closing does nothing. The parent wrapper then polls /health
#     for a few seconds to give the caller quick feedback, but even if the
#     wrapper is killed (connection drop), the worker finishes the restart.
#
# Usage:
#   ./scripts/restart-dev.sh            # port 3001
#   PORT=3002 ./scripts/restart-dev.sh  # override port

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3001}"
LOG="$HOME/.katulong/dev-server.log"
mkdir -p "$(dirname "$LOG")"

if [ "${KATULONG_RESTART_DETACHED:-}" != "1" ]; then
  # Parent: detach a worker copy of this same script, then wait briefly for
  # /health to come back so the user sees confirmation.
  : > "$LOG"
  KATULONG_RESTART_DETACHED=1 PORT="$PORT" \
    nohup "$0" </dev/null >>"$LOG" 2>&1 &
  WORKER_PID=$!
  disown "$WORKER_PID" 2>/dev/null || true

  printf '\033[1;32m==>\033[0m restart-dev detached (pid %s); tailing %s\n' \
    "$WORKER_PID" "$LOG"

  for _ in $(seq 1 30); do
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
      version=$(curl -s "http://localhost:$PORT/health" \
        | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
      printf '\033[1;32m==>\033[0m dev server up on :%s (v%s)\n' \
        "$PORT" "$version"
      exit 0
    fi
    sleep 0.5
  done

  printf '\033[1;33m==>\033[0m server not responding on :%s after 15s\n' "$PORT" >&2
  printf '    worker still running in background — check %s\n' "$LOG" >&2
  exit 1
fi

# --- Detached worker ---
# dev-server.sh already handles LaunchAgent bootout and freeing the port,
# then execs node. We just hand off to it in this detached session.
cd "$REPO_ROOT"
echo "[$(date)] restart-dev: handing off to dev-server.sh on port $PORT"
exec env PORT="$PORT" "$REPO_ROOT/scripts/dev-server.sh"
