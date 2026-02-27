#!/usr/bin/env bash
#
# Build the Flutter Web frontend and copy output to public/ for serving.
#
# Usage:
#   bash scripts/build-flutter.sh          # Overlay mode (default) — adds Flutter files alongside existing frontend
#   bash scripts/build-flutter.sh --clean  # Clean mode — removes old frontend, Flutter-only
#
# CanvasKit renderer is the default for `flutter build web`.
# Self-hosts CanvasKit WASM from the same origin (no CDN calls at runtime).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
UI_DIR="$PROJECT_ROOT/ui"
PUBLIC_DIR="$PROJECT_ROOT/public"
BUILD_DIR="$UI_DIR/build/web"

CLEAN_MODE=false
if [[ "${1:-}" == "--clean" ]]; then
  CLEAN_MODE=true
fi

echo "==> Building Flutter Web (CanvasKit)..."
cd "$UI_DIR"
flutter pub get
flutter build web --release --dart-define=FLUTTER_WEB_CANVASKIT_URL=/canvaskit/

echo "==> Copying build output to public/..."

if $CLEAN_MODE; then
  echo "    (clean mode — removing old frontend files)"

  # Preserve vendor assets and static assets
  PRESERVE_DIRS=(vendor)
  PRESERVE_FILES=(favicon.ico icon-192.png icon-512.png icon-512-maskable.png apple-touch-icon.png manifest.json logo.webp logo.pxd katulong.png)

  TEMP_PRESERVE=$(mktemp -d)
  trap 'rm -rf "$TEMP_PRESERVE"' EXIT

  for dir in "${PRESERVE_DIRS[@]}"; do
    if [ -d "$PUBLIC_DIR/$dir" ]; then
      cp -a "$PUBLIC_DIR/$dir" "$TEMP_PRESERVE/$dir"
    fi
  done

  for file in "${PRESERVE_FILES[@]}"; do
    if [ -f "$PUBLIC_DIR/$file" ]; then
      cp -a "$PUBLIC_DIR/$file" "$TEMP_PRESERVE/$file"
    fi
  done

  # Clear public/
  find "$PUBLIC_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

  # Copy Flutter build output
  cp -a "$BUILD_DIR"/. "$PUBLIC_DIR"/

  # Restore preserved assets
  for dir in "${PRESERVE_DIRS[@]}"; do
    if [ -d "$TEMP_PRESERVE/$dir" ]; then
      cp -a "$TEMP_PRESERVE/$dir" "$PUBLIC_DIR/$dir"
    fi
  done

  for file in "${PRESERVE_FILES[@]}"; do
    if [ -f "$TEMP_PRESERVE/$file" ]; then
      cp -a "$TEMP_PRESERVE/$file" "$PUBLIC_DIR/$file"
    fi
  done
else
  echo "    (overlay mode — adding Flutter files alongside existing frontend)"
  # Copy Flutter build output on top of existing public/ (non-destructive)
  cp -a "$BUILD_DIR"/. "$PUBLIC_DIR"/
fi

# Copy JS bridge files into the build output (they reference vendor/ ESM modules)
mkdir -p "$PUBLIC_DIR/js"
cp -a "$UI_DIR/web/js/xterm_bridge.js" "$PUBLIC_DIR/js/"
cp -a "$UI_DIR/web/js/webauthn_bridge.js" "$PUBLIC_DIR/js/"
cp -a "$UI_DIR/web/js/p2p_bridge.js" "$PUBLIC_DIR/js/"

echo "==> Flutter build complete. Output in public/"
echo "    Start the server with: npm start"
