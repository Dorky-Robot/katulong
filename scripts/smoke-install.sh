#!/usr/bin/env bash
#
# Release-time install gate for katulong.
#
# Simulates the exact sequence Homebrew's Formula runs:
#   1. extract the source (via `git archive HEAD` to match what GitHub's
#      tarball will contain at tag time)
#   2. `npm install --omit=dev` inside the extracted dir (same command
#      the Formula's `install` block runs)
#   3. spawn `node server.js` on a scratch port + scratch KATULONG_DATA_DIR
#   4. run the full `runSmokeTest` battery from lib/cli/upgrade-smoke.js
#   5. tear everything down
#
# This catches the class of "inert pipeline" bugs that unit tests miss:
#   - files missing from the git archive (e.g. public/vendor/ un-tracked
#     after a rename, server.js refusing to serve them)
#   - production deps missing from package.json (dev-only imports that
#     happen to be imported at startup)
#   - server.js failing to start on a fresh data dir
#   - the SPA shell or vendor bundle not being served by the route table
#
# IMPORTANT: This gate tests the state of `git HEAD`, not the working
# tree. `scripts/release.sh` requires a clean working tree before calling
# this, so HEAD === working tree at release time. If you run this script
# directly on a dirty tree, uncommitted changes will NOT be tested.
#
# Usage:
#   scripts/smoke-install.sh
#
# Exit codes:
#   0 — install gate passed
#   non-zero — install gate failed (details printed to stderr)

set -euo pipefail

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Scratch dir + deterministic cleanup. STATUS is flipped to 0 only on the
# success path; any exit before then (set -e, trap-level signal, explicit
# `exit 1`) preserves the default failure status.
SCRATCH="$(mktemp -d -t katulong-smoke-XXXXXXXX)"
STATUS=1
SERVER_PID=""

cleanup() {
  # Kill the smoke server we spawned. Use SIGKILL — this is a short-lived
  # child we own, not a launchd-managed process, and we don't want the
  # cleanup to block waiting for graceful shutdown.
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SCRATCH"
  exit "$STATUS"
}
trap cleanup EXIT INT TERM

log "Install gate: scratch dir = $SCRATCH"

# ── Step 1: extract HEAD into the scratch dir ──────────────────────────
#
# `git archive` produces the exact same file set that GitHub's tag tarball
# will contain, so this is a higher-fidelity match to the Homebrew install
# flow than `npm pack` would be (npm pack respects package.json's "files"
# or .npmignore, which is a different filter than git's tracked set).

INSTALL_DIR="$SCRATCH/src"
mkdir -p "$INSTALL_DIR"

log "Extracting git HEAD to $INSTALL_DIR..."
git archive --format=tar HEAD | tar -x -C "$INSTALL_DIR"

if [ ! -f "$INSTALL_DIR/server.js" ]; then
  err "git archive did not produce server.js at $INSTALL_DIR/server.js"
  exit 1
fi

# ── Step 2: install production deps ────────────────────────────────────
#
# This is the same command the Homebrew Formula runs in its `install`
# block (Formula/katulong.rb:13). Matching it exactly means a failure
# here === a failure users would hit on `brew install`.

log "Running npm install --omit=dev in extracted source..."
(cd "$INSTALL_DIR" && npm install --omit=dev --silent) \
  || { err "npm install --omit=dev failed in the extracted source"; exit 1; }

# ── Step 3: pick a free port and scratch data dir ──────────────────────

PORT="$(node -e "
  const net = require('node:net');
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => console.log(port));
  });
")"
log "Smoke server port: $PORT"

DATA_DIR="$SCRATCH/data"
mkdir -p "$DATA_DIR"

# ── Step 4: spawn the smoke server ─────────────────────────────────────
#
# Using `node server.js` directly (not `bin/katulong start`) matches the
# exact invocation `_finish-upgrade` uses to spawn its smoke-test child.
# That means a failure here maps 1:1 to a failure the live upgrade flow
# would also hit.

LOG_PATH="$SCRATCH/smoke.log"
log "Spawning smoke server..."

(
  cd "$INSTALL_DIR"
  PORT="$PORT" KATULONG_DATA_DIR="$DATA_DIR" \
    exec node server.js
) >"$LOG_PATH" 2>&1 &
SERVER_PID=$!
# Detach the job from bash's job control so the SIGKILL we send in
# `cleanup` doesn't print a spurious "Killed: 9" line to stderr (which
# looks like the gate failed even when it didn't).
disown "$SERVER_PID" 2>/dev/null || true

# ── Step 5: run the smoke battery via a small Node wrapper ─────────────
#
# Import `runSmokeTest` from the *extracted* package, not from the repo
# root. This exercises the code that would actually ship — if someone
# broke the smoke helper itself, this catches it before tagging.

SMOKE_WRAPPER="$SCRATCH/run-smoke.mjs"
cat > "$SMOKE_WRAPPER" <<SMOKE_EOF
import { runSmokeTest } from "$INSTALL_DIR/lib/cli/upgrade-smoke.js";

const baseUrl = "http://127.0.0.1:$PORT";
const logPath = "$LOG_PATH";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Phase 1: wait up to 15s for the server to become live. We keep this
// phase separate from the smoke battery because the battery assumes the
// server is already up — it's not a retry loop.
const deadline = Date.now() + 15_000;
let alive = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(\`\${baseUrl}/health\`);
    if (res.ok) {
      const data = await res.json();
      if (data?.status === "ok") { alive = true; break; }
    }
  } catch {
    // not ready yet
  }
  await sleep(300);
}

if (!alive) {
  console.error("✗ Smoke server did not become healthy in 15s");
  console.error("  Log: $LOG_PATH");
  process.exit(1);
}

// Phase 2: the full runSmokeTest battery — SPA shell, vendor asset, log
// scan, version. Same assertions _finish-upgrade runs at upgrade time.
const result = await runSmokeTest({ baseUrl, logPath });
if (!result.ok) {
  console.error("✗ Smoke test failed:");
  for (const f of result.failures) console.error("    -", f);
  console.error("  Log: $LOG_PATH");
  process.exit(1);
}

console.log(\`✓ Smoke test passed (v\${result.health?.version ?? "unknown"})\`);
SMOKE_EOF

log "Running smoke battery against the freshly-installed server..."
if node "$SMOKE_WRAPPER"; then
  log "Install gate: PASS"
  STATUS=0
else
  err "Install gate: FAIL"
  err "  The release must not proceed — fix the failures above and re-run."
  err "  Smoke log: $LOG_PATH (will be cleaned up on exit)"
  # Dump the log before the trap wipes it, so CI output captures it.
  if [ -f "$LOG_PATH" ]; then
    err "  ----- smoke server log -----"
    sed 's/^/    /' "$LOG_PATH" >&2 || true
    err "  ----- end smoke server log -----"
  fi
  STATUS=1
fi
