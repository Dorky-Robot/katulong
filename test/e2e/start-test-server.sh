#!/bin/bash
# Start Test Server
# Runs pre-server setup, then starts the Katulong server for E2E tests
# Supports TEST_SHARD_INDEX env var for parallel sharded runs (default 0)

SHARD=${TEST_SHARD_INDEX:-0}

# Derive ports and paths from shard index
# Shard 0 produces the original values for backward compatibility
HTTP_PORT=$(( 3099 + SHARD * 10 ))
HTTPS_PORT=$(( 3100 + SHARD * 10 ))
SSH_PORT=$(( 2223 + SHARD * 10 ))

if [ "$SHARD" -eq 0 ]; then
  DATA_DIR="/tmp/katulong-e2e-data"
  SOCK_PATH="/tmp/katulong-test.sock"
else
  DATA_DIR="/tmp/katulong-e2e-data-${SHARD}"
  SOCK_PATH="/tmp/katulong-test-${SHARD}.sock"
fi

# Run pre-server setup to create fixture auth state
TEST_SHARD_INDEX=$SHARD node test/e2e/pre-server-setup.js

# Start the server with test configuration
PORT=$HTTP_PORT \
HTTPS_PORT=$HTTPS_PORT \
SSH_PORT=$SSH_PORT \
KATULONG_NO_AUTH=1 \
KATULONG_SOCK="$SOCK_PATH" \
KATULONG_DATA_DIR="$DATA_DIR" \
node entrypoint.js
