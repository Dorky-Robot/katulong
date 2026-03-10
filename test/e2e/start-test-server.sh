#!/bin/bash
# Start Test Server
# Runs pre-server setup, then starts the Katulong server for E2E tests
# Supports TEST_SHARD_INDEX env var for parallel sharded runs (default 0)

SHARD=${TEST_SHARD_INDEX:-0}

# Derive ports and paths from shard index
# Shard 0 produces the original values for backward compatibility
HTTP_PORT=$(( 3099 + SHARD * 10 ))

if [ "$SHARD" -eq 0 ]; then
  DATA_DIR="/tmp/katulong-e2e-data"
else
  DATA_DIR="/tmp/katulong-e2e-data-${SHARD}"
fi

# Run pre-server setup to create fixture auth state
TEST_SHARD_INDEX=$SHARD node test/e2e/pre-server-setup.js

# Start the server with test configuration
# Auth is bypassed automatically for localhost requests (isLocalRequest check)
PORT=$HTTP_PORT \
KATULONG_DATA_DIR="$DATA_DIR" \
node server.js
