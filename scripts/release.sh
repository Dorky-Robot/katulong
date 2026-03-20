#!/usr/bin/env bash
set -euo pipefail

# Release katulong: bump version, update Formula, tag, and push.
#
# The CI release workflow (.github/workflows/release.yml) takes over from
# the tag push — it creates the GitHub release and updates both tap repos
# (homebrew-tap, homebrew-katulong) with the correct SHA256.
#
# Usage:
#   ./scripts/release.sh <patch|minor|major>
#   ./scripts/release.sh 0.31.0          # explicit version

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

# Portable sed in-place: macOS needs -i '', GNU needs -i
sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"   # GNU sed
  else
    sed -i '' "$@" # BSD/macOS sed
  fi
}

# Portable SHA256: macOS has shasum, Linux has sha256sum
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Preflight checks ────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  err "Usage: $0 <patch|minor|major|X.Y.Z>"
  exit 1
fi

# Must be on main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
  err "Must be on main or master branch (currently on $BRANCH)"
  exit 1
fi

# Working tree must be clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# Pull latest
log "Pulling latest changes..."
git pull --ff-only

# ── Determine new version ───────────────────────────────────────────

CURRENT=$(node -p "require('./package.json').version")
BUMP="$1"

case "$BUMP" in
  patch|minor|major)
    # Use node to compute semver bump (no extra deps needed)
    NEW_VERSION=$(node -e "
      const [major, minor, patch] = '${CURRENT}'.split('.').map(Number);
      const bumps = {
        patch: [major, minor, patch + 1],
        minor: [major, minor + 1, 0],
        major: [major + 1, 0, 0],
      };
      console.log(bumps['${BUMP}'].join('.'));
    ")
    ;;
  [0-9]*)
    NEW_VERSION="$BUMP"
    ;;
  *)
    err "Invalid argument: $BUMP (expected patch, minor, major, or X.Y.Z)"
    exit 1
    ;;
esac

if [ "$NEW_VERSION" = "$CURRENT" ]; then
  err "New version ($NEW_VERSION) is the same as current ($CURRENT)"
  exit 1
fi

log "Releasing: v${CURRENT} → v${NEW_VERSION}"

# ── Run tests ────────────────────────────────────────────────────────

log "Running tests..."
npm test

# ── Bump version in package.json ─────────────────────────────────────

log "Bumping package.json to v${NEW_VERSION}..."
npm version "$NEW_VERSION" --no-git-tag-version

# ── Update local Formula ─────────────────────────────────────────────
# Update the url to point to the new tag. SHA256 will be wrong until the
# tag is pushed and GitHub generates the tarball, but the CI workflow
# handles updating the tap repos with the correct SHA. The local Formula
# serves as a template — keep the version in sync.

FORMULA="$REPO_ROOT/Formula/katulong.rb"
if [ -f "$FORMULA" ]; then
  log "Updating local Formula to v${NEW_VERSION}..."
  sedi "s|url \"https://github.com/Dorky-Robot/katulong/archive/refs/tags/v.*\.tar\.gz\"|url \"https://github.com/Dorky-Robot/katulong/archive/refs/tags/v${NEW_VERSION}.tar.gz\"|" "$FORMULA"
  # Mark SHA as pending — CI will compute the real one for the taps
  sedi "s|sha256 \".*\"|sha256 \"PENDING_CI_WILL_UPDATE\"|" "$FORMULA"
fi

# ── Commit and tag ───────────────────────────────────────────────────

log "Committing release..."
git add package.json package-lock.json Formula/katulong.rb
git commit -m "Release v${NEW_VERSION}"

log "Creating tag v${NEW_VERSION}..."
git tag "v${NEW_VERSION}"

# ── Push ─────────────────────────────────────────────────────────────

log "Pushing branch and tag..."
git push origin "$BRANCH" --tags

# ── Wait for CI to create the release, then backfill local SHA ───────

log "Waiting for GitHub to generate the tarball..."
TAG="v${NEW_VERSION}"
URL="https://github.com/Dorky-Robot/katulong/archive/refs/tags/${TAG}.tar.gz"

# Retry up to 30 seconds for the tarball to become available
for i in $(seq 1 6); do
  if curl -fsSL -o /tmp/katulong-release.tar.gz "$URL" 2>/dev/null; then
    SHA=$(sha256 /tmp/katulong-release.tar.gz)
    rm -f /tmp/katulong-release.tar.gz
    break
  fi
  sleep 5
done

if [ -n "${SHA:-}" ] && [ -f "$FORMULA" ]; then
  log "Backfilling local Formula SHA256: ${SHA}"
  sedi "s|sha256 \"PENDING_CI_WILL_UPDATE\"|sha256 \"${SHA}\"|" "$FORMULA"
  git add Formula/katulong.rb
  git commit -m "Formula: update to v${NEW_VERSION}"
  git push origin "$BRANCH"
else
  warn "Could not fetch tarball SHA — update Formula/katulong.rb manually"
  warn "  curl -fsSL $URL | shasum -a 256"
fi

# ── Summary ──────────────────────────────────────────────────────────

log ""
log "Released v${NEW_VERSION}!"
log ""
log "CI will now:"
log "  1. Create GitHub release"
log "  2. Update homebrew-tap and homebrew-katulong with correct SHA256"
log "  3. Trigger bottle builds in homebrew-katulong"
log ""
log "After bottles are built, users can upgrade with:"
log "  brew update && brew upgrade katulong"
