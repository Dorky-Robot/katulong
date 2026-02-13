#!/bin/bash
# Start Test Server
# Runs pre-server setup, then starts the Katulong server for E2E tests

# Run pre-server setup to create fixture auth state
node test/e2e/pre-server-setup.js

# Start the server with test configuration
PORT=3099 \
KATULONG_NO_AUTH=1 \
KATULONG_SOCK=/tmp/katulong-test.sock \
KATULONG_DATA_DIR=/tmp/katulong-e2e-data \
node entrypoint.js
