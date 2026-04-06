#!/bin/bash
# Cleanup test server processes for all shards (0-3)
# Does NOT touch dev server (port 3001) or the developer's default tmux socket.

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

  # Kill the entire per-shard test tmux server (isolated socket).
  # We never touch the developer's default socket — that was the cause of
  # the pollution this refactor fixes.
  #
  # Socket name must match TEST_TMUX_SOCKET in test/e2e/test-config.js and
  # TMUX_SOCKET in test/e2e/start-test-server.sh — keep all three in sync.
  TMUX_SOCKET="katulong-e2e-${SHARD}"
  if tmux -L "$TMUX_SOCKET" list-sessions >/dev/null 2>&1; then
    echo "  Killing test tmux server on socket $TMUX_SOCKET..."
    tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null
  fi
done

echo "✓ Test cleanup complete (dev server and default tmux socket untouched)"
