#!/bin/bash
# Cleanup test server processes for all shards (0-3)
# Does NOT touch dev server (port 3001/3002)

echo "Cleaning up test server processes..."

for SHARD in 0 1 2 3; do
  HTTP_PORT=$(( 3099 + SHARD * 10 ))

  if lsof -ti:$HTTP_PORT >/dev/null 2>&1; then
    echo "  Killing process on test port $HTTP_PORT (shard $SHARD)..."
    lsof -ti:$HTTP_PORT | xargs kill -9 2>/dev/null
  fi

  if [ "$SHARD" -eq 0 ]; then
    SOCK_PATH="/tmp/katulong-test.sock"
    DATA_DIR="/tmp/katulong-e2e-data"
  else
    SOCK_PATH="/tmp/katulong-test-${SHARD}.sock"
    DATA_DIR="/tmp/katulong-e2e-data-${SHARD}"
  fi

  if [ -f "$SOCK_PATH" ]; then
    echo "  Removing test socket $SOCK_PATH..."
    rm -f "$SOCK_PATH"
  fi

  if [ -d "$DATA_DIR" ]; then
    echo "  Cleaning test data directory $DATA_DIR..."
    rm -rf "$DATA_DIR"
  fi
done

echo "✓ Test cleanup complete (dev server untouched)"
