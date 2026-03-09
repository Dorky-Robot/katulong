#!/bin/bash
# Cleanup test server processes for all shards (0-3)
# Does NOT touch dev server (port 3001)

echo "Cleaning up test server processes..."

for SHARD in 0 1 2 3; do
  HTTP_PORT=$(( 3099 + SHARD * 10 ))

  if lsof -ti:$HTTP_PORT >/dev/null 2>&1; then
    echo "  Killing process on test port $HTTP_PORT (shard $SHARD)..."
    lsof -ti:$HTTP_PORT | xargs kill -9 2>/dev/null
  fi

  if [ "$SHARD" -eq 0 ]; then
    DATA_DIR="/tmp/katulong-e2e-data"
  else
    DATA_DIR="/tmp/katulong-e2e-data-${SHARD}"
  fi

  if [ -d "$DATA_DIR" ]; then
    echo "  Cleaning test data directory $DATA_DIR..."
    rm -rf "$DATA_DIR"
  fi
done

# Kill leftover smoke test tmux sessions
SMOKE_SESSIONS=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^smoke-' || true)
if [ -n "$SMOKE_SESSIONS" ]; then
  echo "  Killing leftover smoke test tmux sessions..."
  echo "$SMOKE_SESSIONS" | while read -r sess; do
    tmux kill-session -t "$sess" 2>/dev/null && echo "    killed: $sess"
  done
fi

echo "✓ Test cleanup complete (dev server untouched)"
