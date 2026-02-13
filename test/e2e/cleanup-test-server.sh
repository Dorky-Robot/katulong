#!/bin/bash
# Cleanup ONLY test server processes
# Does NOT touch dev server (port 3001/3002)

echo "Cleaning up test server processes..."

# Kill only processes on test port 3099
if lsof -ti:3099 >/dev/null 2>&1; then
  echo "  Killing process on test port 3099..."
  lsof -ti:3099 | xargs kill -9 2>/dev/null
fi

# Remove test socket (not dev socket)
if [ -f /tmp/katulong-test.sock ]; then
  echo "  Removing test socket..."
  rm -f /tmp/katulong-test.sock
fi

# Clean test data directory
if [ -d /tmp/katulong-e2e-data ]; then
  echo "  Cleaning test data directory..."
  rm -rf /tmp/katulong-e2e-data
fi

echo "✓ Test cleanup complete (dev server untouched)"
