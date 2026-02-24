#!/bin/bash
# Safe daemon shutdown script
# Uses multiple methods to safely kill only the Katulong daemon

set -e

DATA_DIR="${KATULONG_DATA_DIR:-$HOME/.katulong}"
PID_FILE="$DATA_DIR/daemon.pid"

echo "Attempting to stop Katulong daemon..."

# Method 1: Use PID file (most reliable)
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Killing daemon (PID $PID) from PID file..."
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null
    echo "Daemon stopped."
    exit 0
  else
    echo "PID file exists but process $PID is not running (stale PID file)"
    rm -f "$PID_FILE"
  fi
fi

# Method 2: Use process title
if pkill -0 katulong-daemon 2>/dev/null; then
  echo "Killing daemon by process name..."
  pkill katulong-daemon || pkill -9 katulong-daemon
  echo "Daemon stopped."
  exit 0
fi

# Method 3: Use socket file
SOCKET_PATH="${KATULONG_SOCK:-/tmp/katulong-daemon.sock}"
if [ -e "$SOCKET_PATH" ]; then
  PID=$(lsof -t "$SOCKET_PATH" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "Killing daemon (PID $PID) using socket..."
    kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null
    echo "Daemon stopped."
    exit 0
  fi
fi

echo "No running daemon found."
exit 0
