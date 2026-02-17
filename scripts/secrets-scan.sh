#!/usr/bin/env bash
# secrets-scan.sh — shared secrets scan for pre-commit and pre-push hooks
#
# Uses gitleaks for battle-tested secret detection.
# Install: brew install gitleaks
#
# Usage:
#   source scripts/secrets-scan.sh
#   scan_secrets "pre-commit"  # scans staged changes
#   scan_secrets "pre-push"    # scans staged changes
#
# Returns 1 if secrets found, 0 if clean.

scan_secrets() {
  local hook_name="$1"

  if ! command -v gitleaks &>/dev/null; then
    echo "$hook_name: gitleaks not found — install with: brew install gitleaks"
    return 1
  fi

  echo "$hook_name: scanning for secrets..."
  if ! gitleaks git --pre-commit --no-banner --verbose 2>&1; then
    echo ""
    echo "============================================"
    echo "  $hook_name: SECRETS DETECTED BY GITLEAKS"
    echo "  Remove secrets and try again."
    echo "============================================"
    echo ""
    return 1
  fi

  return 0
}
