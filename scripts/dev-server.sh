#!/usr/bin/env bash
set -euo pipefail

# Run the local git checkout as the katulong server on port 3001, against
# the real ~/.katulong data dir, so you can iterate against live sessions
# and pub/sub topics without touching a staging directory.
#
# SSH-friendly: `start` daemonizes the server via nohup + disown so an SSH
# disconnect (SIGHUP) doesn't take it down. The default command starts +
# follows the log in the foreground — Ctrl-C detaches from the log but
# leaves the server running, so you can reconnect later and tail it again.
#
# The Homebrew-installed katulong + its LaunchAgent are unloaded for the
# duration of the dev run. After you `stop`, run `katulong service install`
# (or `launchctl bootstrap`) to restore the brew-managed instance.
#
# Usage:
#   ./scripts/dev-server.sh              # start + follow log (default)
#   ./scripts/dev-server.sh start        # start detached, return to prompt
#   ./scripts/dev-server.sh stop         # stop the dev server
#   ./scripts/dev-server.sh tail         # follow the log of a running server
#   ./scripts/dev-server.sh status       # is it running?
#   PORT=3002 ./scripts/dev-server.sh    # override port

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }

PORT="${PORT:-3001}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  err "PORT must be numeric (got: $PORT)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

LOG_FILE="/tmp/katulong-dev.log"
PID_FILE="/tmp/katulong-dev.pid"

free_port() {
  local occupant
  occupant=$(lsof -ti:"$PORT" 2>/dev/null || true)
  if [ -n "$occupant" ]; then
    log "Freeing port $PORT (pids: $occupant)"
    kill $occupant 2>/dev/null || true
    sleep 1
    occupant=$(lsof -ti:"$PORT" 2>/dev/null || true)
    if [ -n "$occupant" ]; then
      warn "Still bound, SIGKILL to $occupant"
      kill -9 $occupant 2>/dev/null || true
      sleep 1
    fi
  fi
  if lsof -ti:"$PORT" >/dev/null 2>&1; then
    err "port $PORT is still in use"
    lsof -nP -iTCP:"$PORT" >&2 || true
    return 1
  fi
}

cmd_stop() {
  local pids=""
  [[ -f "$PID_FILE" ]] && pids="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ -z "$pids" ]] && pids="$(lsof -ti:"$PORT" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    log "not running"
    rm -f "$PID_FILE"
    return 0
  fi
  log "stopping (pids: $pids)"
  kill $pids 2>/dev/null || true
  sleep 1
  if lsof -ti:"$PORT" >/dev/null 2>&1; then
    warn "still bound, SIGKILL"
    kill -9 $(lsof -ti:"$PORT") 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
  log "stopped"
}

cmd_status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "running (pid $(cat "$PID_FILE")) on port $PORT"
    log "log: $LOG_FILE"
  elif lsof -ti:"$PORT" >/dev/null 2>&1; then
    warn "port $PORT in use, but not tracked in $PID_FILE:"
    lsof -nP -iTCP:"$PORT" >&2 || true
  else
    log "not running"
  fi
}

cmd_tail() {
  [[ -f "$LOG_FILE" ]] || { err "$LOG_FILE does not exist"; exit 1; }
  log "tailing $LOG_FILE (Ctrl-C detaches; server keeps running)"
  exec tail -f "$LOG_FILE"
}

# Start the dev server in the background so SSH disconnect doesn't kill it.
# Takes one arg: 1 = follow log in foreground after starting, 0 = detach and exit.
cmd_start() {
  local follow="${1:-0}"

  # Unload the LaunchAgent so brew's katulong stops auto-respawning.
  local plist="$HOME/Library/LaunchAgents/com.dorkyrobot.katulong.plist"
  if [ -f "$plist" ]; then
    log "Unloading LaunchAgent (restorable via 'katulong service install')"
    launchctl bootout "gui/$UID/com.dorkyrobot.katulong" 2>/dev/null || true
  fi

  free_port || exit 1

  local version
  version=$(node -p "require('./package.json').version")
  log "katulong dev @ v$version  →  http://localhost:$PORT"
  log "data dir: ${KATULONG_DATA_DIR:-$HOME/.katulong}  (real data, not staging)"

  # Daemonize. nohup blocks SIGHUP propagation from the parent shell,
  # disown removes the job from shell job control, and redirecting all
  # three stdio channels detaches from the controlling terminal. Together
  # these ensure SSH disconnect (SIGHUP) does not take the server down.
  #
  # Unsetting CLAUDECODE / CLAUDE_CODE_* matters when this script itself is
  # launched from inside a Claude Code session (via a nested shell, SSH from
  # an agent, etc.). Those vars signal "you are running inside Claude Code"
  # and are inherited by every tmux pane the server spawns — which makes
  # each new `claude` in those panes think it is nested and suppress its
  # SessionStart hook, breaking the Claude feed narration pipeline.
  : > "$LOG_FILE"
  nohup env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH \
    PORT="$PORT" node server.js >> "$LOG_FILE" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  disown 2>/dev/null || true

  # Confirm the server came up before handing control back. If it dies
  # during startup, surface the tail of the log so the caller knows why.
  local i
  for i in $(seq 1 20); do
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/login"; then
      log "started (pid $pid); log: $LOG_FILE"
      log "stop: $0 stop    status: $0 status    tail: $0 tail"
      if (( follow )); then
        log "following log (Ctrl-C detaches; server keeps running)"
        exec tail -f "$LOG_FILE"
      fi
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      err "server died during startup — tail of log:"
      tail -30 "$LOG_FILE" >&2 || true
      rm -f "$PID_FILE"
      exit 1
    fi
    sleep 0.5
  done
  err "server not responding after 10s — tail of log:"
  tail -30 "$LOG_FILE" >&2 || true
  exit 1
}

case "${1:-follow}" in
  follow) cmd_start 1 ;;
  start)  cmd_start 0 ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  tail)   cmd_tail ;;
  -h|--help|help)
    sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) err "unknown subcommand: $1"; exit 2 ;;
esac
