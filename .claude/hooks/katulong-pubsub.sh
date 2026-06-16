#!/usr/bin/env bash
# katulong-pubsub.sh — Claude Code lifecycle hook → katulong durable pub/sub
#
# Receives hook JSON on stdin from Claude Code, publishes to katulong pub/sub
# so sipag can update the task board.
#
# Topic mapping:
#   Stop          → crew/{project}/{role}/session-idle
#   SubagentStop  → crew/{project}/{role}/agent-done
#   Notification  → crew/{project}/{role}/notification
#
# Environment:
#   SIPAG_PROJECT — project name (e.g. "katulong")
#   SIPAG_ROLE    — role name (e.g. "dev")
#   KATULONG_SESSION — fallback: parse "{project}--{role}" from session name
#
# Config: ~/.katulong/remote.json → { "url": "...", "apiKey": "..." }

set -euo pipefail

# Read hook JSON from stdin (Claude Code pipes it)
input=$(cat)

# Determine hook event type
hook_event=$(echo "$input" | jq -r '.hook_event // .event // empty' 2>/dev/null)
if [[ -z "$hook_event" ]]; then
  # Cannot determine event type — exit silently
  exit 0
fi

# --- Derive project and role ---

project="${SIPAG_PROJECT:-}"
role="${SIPAG_ROLE:-}"

# Fallback: parse from KATULONG_SESSION ({project}--{role})
if [[ -z "$project" || -z "$role" ]]; then
  session="${KATULONG_SESSION:-}"
  if [[ -n "$session" && "$session" == *"--"* ]]; then
    project="${session%%--*}"
    role="${session#*--}"
  fi
fi

# If we still don't have project/role, exit silently — no topic to publish to
if [[ -z "$project" || -z "$role" ]]; then
  exit 0
fi

# --- Read katulong remote config ---

REMOTE_CONFIG="${HOME}/.katulong/remote.json"
if [[ ! -f "$REMOTE_CONFIG" ]]; then
  exit 0
fi

katulong_url=$(jq -r '.url // empty' "$REMOTE_CONFIG" 2>/dev/null)
api_key=$(jq -r '.apiKey // empty' "$REMOTE_CONFIG" 2>/dev/null)

if [[ -z "$katulong_url" ]]; then
  exit 0
fi

# --- Map hook event to pub/sub topic and payload ---

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%FT%TZ)
session_id="${KATULONG_SESSION:-${project}--${role}}"

topic=""
payload=""

case "$hook_event" in
  Stop)
    topic="crew/${project}/${role}/session-idle"
    payload=$(jq -cn \
      --arg event "stop" \
      --arg session "$session_id" \
      --arg ts "$timestamp" \
      --argjson hook_data "$input" \
      '{event: $event, session: $session, timestamp: $ts, hook_data: $hook_data}')
    ;;
  SubagentStop)
    task_id=$(echo "$input" | jq -r '.task_id // .session_id // empty' 2>/dev/null)
    topic="crew/${project}/${role}/agent-done"
    payload=$(jq -cn \
      --arg event "agent-done" \
      --arg task_id "${task_id:-unknown}" \
      --arg session "$session_id" \
      --arg ts "$timestamp" \
      --argjson hook_data "$input" \
      '{event: $event, task_id: $task_id, session: $session, timestamp: $ts, hook_data: $hook_data}')
    ;;
  Notification)
    message=$(echo "$input" | jq -r '.message // .notification // empty' 2>/dev/null)
    topic="crew/${project}/${role}/notification"
    payload=$(jq -cn \
      --arg event "notification" \
      --arg message "${message:-}" \
      --arg session "$session_id" \
      --arg ts "$timestamp" \
      --argjson hook_data "$input" \
      '{event: $event, message: $message, session: $session, timestamp: $ts, hook_data: $hook_data}')
    ;;
  *)
    # Unrecognized event — ignore
    exit 0
    ;;
esac

if [[ -z "$topic" || -z "$payload" ]]; then
  exit 0
fi

# --- Publish to katulong pub/sub (background, non-blocking) ---

auth_header=""
if [[ -n "$api_key" ]]; then
  auth_header="-H \"Authorization: Bearer ${api_key}\""
fi

# Build the pub/sub message envelope
pub_body=$(jq -cn \
  --arg topic "$topic" \
  --argjson message "$payload" \
  '{topic: $topic, message: $message}')

# Fire-and-forget: curl in background, fail silently, timeout 5s
(
  curl -sf --max-time 5 \
    -X POST "${katulong_url}/pub" \
    -H "Content-Type: application/json" \
    ${api_key:+-H "Authorization: Bearer ${api_key}"} \
    -d "$pub_body" \
    >/dev/null 2>&1 || true
) &

exit 0
