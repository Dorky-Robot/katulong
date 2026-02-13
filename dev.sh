#!/bin/bash
# Development server with hot reload
# Starts daemon and server, both with nodemon

set -e

echo "🚀 Starting Katulong in development mode with hot reload..."
echo ""

# Kill existing dev processes gracefully
echo "Cleaning up existing dev processes..."
lsof -ti:3001,3002 2>/dev/null | xargs kill 2>/dev/null || true
pkill -f "nodemon.*daemon.js" 2>/dev/null || true
pkill -f "nodemon.*server.js" 2>/dev/null || true
sleep 2

# Start daemon with hot reload
echo "Starting daemon with hot reload..."
nodemon daemon.js > /tmp/katulong-daemon.log 2>&1 &
DAEMON_PID=$!
sleep 2

# Check daemon started
if ! ps -p $DAEMON_PID > /dev/null; then
  echo "❌ Daemon failed to start. Check /tmp/katulong-daemon.log"
  exit 1
fi
echo "✓ Daemon running (PID: $DAEMON_PID) - watching for changes"

# Start server with hot reload  
echo "Starting server with hot reload..."
nodemon server.js > /tmp/katulong-server.log 2>&1 &
SERVER_PID=$!
sleep 3

# Check server started
if ! ps -p $SERVER_PID > /dev/null; then
  echo "❌ Server failed to start. Check /tmp/katulong-server.log"
  kill $DAEMON_PID 2>/dev/null || true
  exit 1
fi
echo "✓ Server running (PID: $SERVER_PID) - watching for changes"

echo ""
echo "✅ Development servers running with hot reload!"
echo ""
echo "  📝 Daemon: PID $DAEMON_PID (log: /tmp/katulong-daemon.log)"
echo "  📝 Server: PID $SERVER_PID (log: /tmp/katulong-server.log)"
echo ""
echo "  🌐 HTTP:  http://localhost:3001"
echo "  🔒 HTTPS: https://localhost:3002"  
echo "  🔧 SSH:   localhost:2222"
echo ""
echo "  💡 Edit any .js file and it will auto-reload!"
echo "  📊 View logs: tail -f /tmp/katulong-*.log"
echo "  🛑 Stop: pkill -f nodemon"
echo ""

# Keep script running and show logs
tail -f /tmp/katulong-daemon.log /tmp/katulong-server.log
