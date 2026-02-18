#!/bin/bash
# Run E2E tests across multiple shards, each with its own server instance.
#
# Each shard gets a unique TEST_SHARD_INDEX which drives port/path derivation
# in test-config.js and start-test-server.sh, so shards are fully isolated.
#
# Environment variables:
#   E2E_SHARDS  — override shard count (default: auto-detect from CPU count)
#   E2E_CPUS    — CPU budget for E2E (default: all CPUs)
#   PW_WORKERS  — override Playwright workers per shard

set -euo pipefail

# Strip --shard from extra args — this script manages sharding itself
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --shard=*) shift ;;          # --shard=1/2 — value is part of the arg
    --shard) shift; shift 2>/dev/null || true ;; # --shard 1/2 — skip the next arg too
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

NCPUS=${E2E_CPUS:-$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)}

# Shard count: max(1, min(NCPUS / 4, 4))
if [ -n "${E2E_SHARDS:-}" ]; then
  NUM_SHARDS=$E2E_SHARDS
else
  NUM_SHARDS=$(( NCPUS / 4 ))
  [ "$NUM_SHARDS" -lt 1 ] && NUM_SHARDS=1
  [ "$NUM_SHARDS" -gt 4 ] && NUM_SHARDS=4
fi

# Workers per shard: distribute CPUs evenly
WORKERS_PER_SHARD=$(( NCPUS / NUM_SHARDS ))
[ "$WORKERS_PER_SHARD" -lt 1 ] && WORKERS_PER_SHARD=1

echo "e2e-sharded: ${NUM_SHARDS} shard(s), ${WORKERS_PER_SHARD} workers each (${NCPUS} CPUs)"

# --- Single shard: no overhead, just exec ---
if [ "$NUM_SHARDS" -eq 1 ]; then
  exec env TEST_SHARD_INDEX=0 PW_WORKERS="${PW_WORKERS:-$WORKERS_PER_SHARD}" \
    npx playwright test "$@"
fi

# --- Multiple shards: launch in parallel ---
PIDS=()
LOGS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  for log in "${LOGS[@]}"; do
    rm -f "$log"
  done
}
trap cleanup EXIT INT TERM

for i in $(seq 0 $(( NUM_SHARDS - 1 ))); do
  LOG=$(mktemp)
  LOGS+=("$LOG")

  # Playwright --shard uses 1-based indexing: --shard=(i+1)/N
  env TEST_SHARD_INDEX=$i PW_WORKERS="${PW_WORKERS:-$WORKERS_PER_SHARD}" \
    npx playwright test --shard=$(( i + 1 ))/${NUM_SHARDS} "$@" \
    > "$LOG" 2>&1 &
  PIDS+=($!)
done

# Wait for all shards, collect exit codes
FAILED=0
for idx in $(seq 0 $(( NUM_SHARDS - 1 ))); do
  RC=0
  wait "${PIDS[$idx]}" || RC=$?
  if [ "$RC" -ne 0 ]; then
    echo "e2e-sharded: shard $idx FAILED (exit $RC):"
    cat "${LOGS[$idx]}"
    FAILED=1
  else
    # Show summary line (passed/flaky/failed counts) from passing shards
    SUMMARY=$(grep -E '^\s+\d+ (passed|failed|flaky|skipped)' "${LOGS[$idx]}" | tr '\n' ',' | sed 's/,$//' | sed 's/,/, /g' | xargs)
    echo "e2e-sharded: shard $idx passed ($SUMMARY)"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "e2e-sharded: some shards failed"
  exit 1
fi

echo "e2e-sharded: all shards passed"
exit 0
