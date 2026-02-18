#!/usr/bin/env bash
# review-context.sh — shared context-gathering functions for code review
# Sourced by review.sh and hooks. Sets global variables.
#
# Required inputs (must be set before calling gather_all_context):
#   CHANGED_FILES — newline-separated list of changed file paths
#
# Outputs (global variables):
#   FULL_CHANGED        — full content of every changed file
#   RELATED_FILES       — files that reference changed modules
#   MODULE_EXPORTS      — entry points of changed lib/ modules
#   PACKAGE_JSON        — contents of package.json
#   PROJECT_INSTRUCTIONS — contents of CLAUDE.md

gather_full_files() {
  FULL_CHANGED=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if [ -f "$f" ]; then
      FULL_CHANGED+="
=== FILE: $f ===
$(cat "$f")
"
    fi
  done <<< "$CHANGED_FILES"
}

gather_related_files() {
  RELATED_FILES=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Only look for references to .js files
    case "$f" in
      *.js) ;;
      *) continue ;;
    esac

    base=$(basename "$f" .js)
    if [ "$base" = "index" ]; then
      continue
    fi

    # Find files that require/import this module
    refs=$(grep -rlw --include='*.js' "$base" lib/ server.js daemon.js 2>/dev/null | grep -v "$f" | grep -v node_modules | head -5 || true)
    while IFS= read -r ref; do
      if [ -n "$ref" ] && ! echo "$RELATED_FILES" | grep -Fq "$ref"; then
        RELATED_FILES+="
=== RELATED FILE: $ref (references $base) ===
$(cat "$ref")
"
      fi
    done <<< "$refs"
  done <<< "$CHANGED_FILES"
}

gather_module_exports() {
  MODULE_EXPORTS=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    # Show entry points for changed lib/ modules
    case "$f" in
      lib/*.js)
        if [ -f "$f" ] && ! echo "$MODULE_EXPORTS" | grep -Fq "$f"; then
          MODULE_EXPORTS+="
=== MODULE: $f ===
$(cat "$f")
"
        fi
        ;;
    esac
  done <<< "$CHANGED_FILES"
}

gather_package_json() {
  PACKAGE_JSON=""
  if [ -f "package.json" ]; then
    PACKAGE_JSON=$(cat package.json)
  fi
}

gather_conventions() {
  PROJECT_INSTRUCTIONS=""
  if [ -f "CLAUDE.md" ]; then
    PROJECT_INSTRUCTIONS=$(cat CLAUDE.md)
  fi
}

gather_all_context() {
  gather_full_files
  gather_related_files
  gather_module_exports
  gather_package_json
  gather_conventions

  # Cap context to stay within Claude CLI prompt limits (~100KB).
  # The diff is always included in full; trim supplementary context first.
  MAX_CONTEXT_BYTES=100000
  _total=$(printf '%s%s%s%s%s' "$FULL_CHANGED" "$RELATED_FILES" "$MODULE_EXPORTS" "$PACKAGE_JSON" "$PROJECT_INSTRUCTIONS" | wc -c)
  if [ "$_total" -gt "$MAX_CONTEXT_BYTES" ]; then
    echo "review-context: context too large (${_total} bytes), trimming supplementary files"
    RELATED_FILES="(trimmed — diff is large, review the diff directly)"
    FULL_CHANGED="(trimmed — diff is large, review the diff directly)"
  fi
}
