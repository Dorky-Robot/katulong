#!/bin/sh
# POSIX sh for maximum portability — Alpine ships without bash by default
set -eu

# Katulong installer
# Installs katulong and its dependencies on Linux (Alpine, Debian/Ubuntu, RHEL/Fedora)
# and macOS (via Homebrew).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dorky-robot/katulong/main/install.sh | sh
#
# Options (env vars):
#   KATULONG_VERSION  — version to install (default: latest)
#   KATULONG_DIR      — install directory (default: /opt/katulong)
#   KATULONG_DATA_DIR — data directory (default: $HOME/.katulong)
#
# Requires root for the default paths. Set KATULONG_DIR and BIN_DIR to
# user-writable paths to install without root.

REPO="dorky-robot/katulong"
VERSION="${KATULONG_VERSION:-latest}"
INSTALL_DIR="${KATULONG_DIR:-/opt/katulong}"
DATA_DIR="${KATULONG_DATA_DIR:-$HOME/.katulong}"
BIN_LINK="/usr/local/bin/katulong"
MIN_NODE_MAJOR=18

# Temp directory for downloads — cleaned up on exit
TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Detect OS and package manager ---

detect_pm() {
  if command -v apk >/dev/null 2>&1; then echo apk
  elif command -v apt-get >/dev/null 2>&1; then echo apt
  elif command -v dnf >/dev/null 2>&1; then echo dnf
  elif command -v yum >/dev/null 2>&1; then echo yum
  elif command -v brew >/dev/null 2>&1; then echo brew
  else echo unknown
  fi
}

# --- Install system dependencies ---

install_deps() {
  log "Installing dependencies via $1"

  case "$1" in
    apk)
      apk add --no-cache nodejs npm tmux bash curl
      ;;
    apt)
      apt-get update -qq
      apt-get install -y --no-install-recommends nodejs npm tmux bash curl ca-certificates
      rm -rf /var/lib/apt/lists/*
      ;;
    dnf)
      dnf install -y nodejs npm tmux bash curl
      dnf clean all
      ;;
    yum)
      yum install -y nodejs npm tmux bash curl
      yum clean all
      ;;
    brew)
      # macOS — prefer the tap for a managed install
      log "Homebrew detected — installing via tap instead"
      brew install dorky-robot/tap/katulong
      katulong --version || die "Homebrew install succeeded but katulong is not in PATH"
      log "Installed! Run: katulong start"
      exit 0
      ;;
    *)
      die "No supported package manager found (need apk, apt-get, dnf, yum, or brew)"
      ;;
  esac
}

# --- Check prerequisites ---

check_prereqs() {
  command -v node >/dev/null 2>&1 &&
  command -v npm  >/dev/null 2>&1 &&
  command -v tmux >/dev/null 2>&1
}

check_node_version() {
  node_ver=$(node --version 2>/dev/null | sed 's/^v//')
  node_major=$(echo "$node_ver" | cut -d. -f1)
  if [ -z "$node_major" ] || [ "$node_major" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null; then
    die "Node.js >= ${MIN_NODE_MAJOR} required (found: ${node_ver:-none})"
  fi
}

# --- Resolve version ---

resolve_version() {
  if [ "$VERSION" = "latest" ]; then
    # Use tags API (not releases) — katulong tags every version but may not
    # create GitHub releases for each one.
    api_url="https://api.github.com/repos/${REPO}/tags?per_page=1"
    VERSION=$(curl -fsSL --max-filesize 65536 "$api_url" \
      | grep '"name"' | head -1 | sed 's/.*"v\([^"]*\)".*/\1/')
    if [ -z "$VERSION" ]; then
      die "Could not determine latest version (URL: $api_url)"
    fi
  fi
  # Strip leading v if present
  VERSION=$(echo "$VERSION" | sed 's/^v//')
  # Validate semver format to prevent injection via crafted version strings
  echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || die "Invalid version format: $VERSION (expected X.Y.Z)"
}

# --- Download and install ---

install_katulong() {
  log "Installing katulong v${VERSION} to ${INSTALL_DIR}"

  TMP_DIR="$(mktemp -d /tmp/katulong-install-XXXXXX)"
  tmp_tar="$TMP_DIR/katulong.tar.gz"
  tmp_extract="$TMP_DIR/extract"
  tarball_url="https://github.com/${REPO}/archive/refs/tags/v${VERSION}.tar.gz"

  curl -fsSL --retry 3 --retry-delay 3 "$tarball_url" -o "$tmp_tar" \
    || die "Failed to download v${VERSION} from GitHub"

  # Extract to temp dir first, then move atomically
  mkdir -p "$tmp_extract"
  tar xzf "$tmp_tar" -C "$tmp_extract" --strip-components=1

  # Install production dependencies in the temp dir
  cd "$tmp_extract"
  npm install --production --omit=dev --silent \
    || die "npm install failed — check network and Node.js version"
  cd - >/dev/null

  # Atomic swap: remove old install, move new one into place
  if [ -d "$INSTALL_DIR" ]; then
    log "Replacing previous install at ${INSTALL_DIR}"
    rm -rf "$INSTALL_DIR"
  fi
  mv "$tmp_extract" "$INSTALL_DIR"

  # Ensure bin directory exists
  mkdir -p "$(dirname "$BIN_LINK")"

  # Create wrapper script — KATULONG_DATA_DIR resolves at runtime
  cat > "$BIN_LINK" <<WRAPPER
#!/bin/sh
export KATULONG_DATA_DIR="\${KATULONG_DATA_DIR:-${DATA_DIR}}"
exec node "${INSTALL_DIR}/bin/katulong" "\$@"
WRAPPER
  chmod +x "$BIN_LINK"

  # Create data directory
  mkdir -p "$DATA_DIR" 2>/dev/null || true
}

# --- Verify ---

verify() {
  # Test the binary directly rather than relying on PATH
  node "${INSTALL_DIR}/bin/katulong" --version >/dev/null 2>&1 \
    || die "Installation failed — katulong binary does not run"
  installed_version=$(katulong --version 2>/dev/null || echo "unknown")
  log "Installed ${installed_version}"
}

# --- Main ---

main() {
  log "Katulong installer"

  pm=$(detect_pm)

  # Install system deps if missing
  if ! check_prereqs; then
    if [ "$(id -u)" -ne 0 ] && [ "$pm" != "brew" ]; then
      die "Missing dependencies (node, npm, tmux) — run as root or install them manually"
    fi
    install_deps "$pm"
  else
    log "Dependencies satisfied (node, npm, tmux)"
  fi

  check_node_version
  resolve_version
  install_katulong
  verify

  cat <<EOF

  Katulong v${VERSION} installed successfully!

  Start:   katulong start
  Stop:    katulong stop
  Logs:    katulong logs
  Help:    katulong --help

EOF
}

main
