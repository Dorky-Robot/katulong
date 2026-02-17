#!/usr/bin/env bash
# review.sh — parallel multi-agent code review orchestrator
#
# Launches three specialized Claude Code agents in parallel:
#   security-reviewer, architecture-reviewer, correctness-reviewer
#
# Usage:
#   scripts/review.sh --hook <pre-commit|pre-push|manual> \
#     --diff-file <path> --files-file <path>
#
# Exit codes:
#   0 — all agents passed (LGTM or low-severity only)
#   1 — high or medium severity findings
#   2 — agent failure (process error, empty output, missing tools)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- Parse arguments ---

HOOK=""
DIFF_FILE=""
FILES_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hook)    HOOK="$2"; shift 2 ;;
    --diff-file)  DIFF_FILE="$2"; shift 2 ;;
    --files-file) FILES_FILE="$2"; shift 2 ;;
    *) echo "review.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$HOOK" ] || [ -z "$DIFF_FILE" ] || [ -z "$FILES_FILE" ]; then
  echo "review.sh: usage: --hook <name> --diff-file <path> --files-file <path>" >&2
  exit 2
fi

# --- Check for claude CLI ---

if ! command -v claude &>/dev/null; then
  echo "review.sh: claude CLI not found, skipping review"
  exit 0
fi

# --- Read inputs ---

DIFF=$(cat "$DIFF_FILE")
CHANGED_FILES=$(cat "$FILES_FILE")

if [ -z "$DIFF" ]; then
  echo "review.sh: empty diff, nothing to review"
  exit 0
fi

# --- Gather context ---

cd "$REPO_ROOT"
source "$SCRIPT_DIR/review-context.sh"

echo "$HOOK: gathering context for parallel review..."
gather_all_context

# --- Build shared context message ---

CONTEXT="You are reviewing code changes in the katulong project ($HOOK hook).

Katulong is a self-hosted web terminal that gives remote shell access to the host machine over HTTP/HTTPS + WebSocket. It multiplexes PTY sessions via a Unix socket daemon and serves a single-page xterm.js frontend.

PROJECT CONVENTIONS:
$PROJECT_INSTRUCTIONS

DEPENDENCIES (package.json):
$PACKAGE_JSON

MODULE ENTRY POINTS:
$MODULE_EXPORTS

CHANGED FILES:
$CHANGED_FILES

DIFF:
$DIFF

FULL CONTENT OF CHANGED FILES:
$FULL_CHANGED

RELATED FILES (callers/importers of changed modules):
$RELATED_FILES"

# --- Build a clean env for agent subprocesses ---
# Claude CLI blocks launches when it detects a parent session via CLAUDE* env vars.
# Strip all of them so `claude -p --agent` works from git hooks.

ENV_UNSET=()
while IFS='=' read -r key _; do
  [ -n "$key" ] && ENV_UNSET+=(-u "$key")
done < <(env | grep '^CLAUDE' || true)

# --- Timeout configuration ---

AGENT_TIMEOUT=300  # 5 minutes per agent

# Find a working timeout command (timeout on Linux, gtimeout on macOS via coreutils)
TIMEOUT_CMD=""
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
fi

# --- Launch three agents in parallel ---

AGENTS=("security-reviewer" "architecture-reviewer" "correctness-reviewer")
TMPDIR_AGENTS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_AGENTS"' EXIT

echo "$HOOK: launching ${#AGENTS[@]} review agents in parallel..."

# Write context to a temp file and pipe via stdin to avoid ARG_MAX limits
CONTEXT_FILE="$TMPDIR_AGENTS/context.txt"
printf '%s\n' "$CONTEXT" > "$CONTEXT_FILE"

PIDS=()
for agent in "${AGENTS[@]}"; do
  outfile="$TMPDIR_AGENTS/$agent.out"
  errfile="$TMPDIR_AGENTS/$agent.err"
  ENV_CMD=(env)
  [ ${#ENV_UNSET[@]} -gt 0 ] && ENV_CMD+=(${ENV_UNSET[@]+"${ENV_UNSET[@]}"})
  if [ -n "$TIMEOUT_CMD" ]; then
    "${ENV_CMD[@]}" $TIMEOUT_CMD "${AGENT_TIMEOUT}s" claude -p --agent "$agent" --no-session-persistence < "$CONTEXT_FILE" > "$outfile" 2>"$errfile" &
  else
    "${ENV_CMD[@]}" claude -p --agent "$agent" --no-session-persistence < "$CONTEXT_FILE" > "$outfile" 2>"$errfile" &
  fi
  PIDS+=($!)
done

# --- Wait for all agents ---

FAILED=0
for i in "${!AGENTS[@]}"; do
  agent="${AGENTS[$i]}"
  pid="${PIDS[$i]}"
  set +e
  wait "$pid"; rc=$?
  set -e
  if [ "$rc" -eq 124 ]; then
    echo "$HOOK: [$agent] timed out after ${AGENT_TIMEOUT}s — fail-closed"
    FAILED=1
  elif [ "$rc" -ne 0 ]; then
    echo "$HOOK: [$agent] agent process failed (exit $rc)"
    echo "$HOOK: [$agent] stderr:"
    cat "$TMPDIR_AGENTS/$agent.err" 2>/dev/null || echo "(no stderr file)"
    echo "$HOOK: [$agent] stdout:"
    cat "$TMPDIR_AGENTS/$agent.out" 2>/dev/null || echo "(no stdout file)"
    FAILED=1
  fi
done

# --- Fail-closed: check for failures and empty output ---

for agent in "${AGENTS[@]}"; do
  outfile="$TMPDIR_AGENTS/$agent.out"
  if [ ! -s "$outfile" ]; then
    echo "$HOOK: [$agent] produced no output — fail-closed"
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "============================================"
  echo "  $HOOK: REVIEW FAILED (agent error)"
  echo "  One or more review agents failed to run."
  echo "  Use --no-verify to bypass."
  echo "============================================"
  echo ""
  exit 2
fi

# --- Aggregate results ---

echo ""
BLOCKED=0

for agent in "${AGENTS[@]}"; do
  outfile="$TMPDIR_AGENTS/$agent.out"

  # Print agent output with prefix
  echo "--- [$agent] ---"
  cat "$outfile"
  echo ""

  # Check for blocking severities
  if grep -q '\[severity: high\]' "$outfile"; then
    echo "$HOOK: [$agent] found HIGH severity issues"
    BLOCKED=1
  fi
  if grep -q '\[severity: medium\]' "$outfile"; then
    echo "$HOOK: [$agent] found MEDIUM severity issues"
    BLOCKED=1
  fi
done

if [ "$BLOCKED" -eq 1 ]; then
  echo ""
  echo "============================================"
  echo "  $HOOK: BLOCKED — review issues found"
  echo "  Fix the issues above or use --no-verify."
  echo "============================================"
  echo ""
  exit 1
fi

echo "$HOOK: all review agents passed"
exit 0
