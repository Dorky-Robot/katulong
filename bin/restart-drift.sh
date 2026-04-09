#!/usr/bin/env bash
# Restart the drift-debug katulong on :3001.
# Kills whatever is on the port (the previous debug run or brew katulong)
# and re-execs bin/debug-drift.sh.
set -euo pipefail

cd "$(dirname "$0")/.."
exec ./bin/debug-drift.sh "$@"
