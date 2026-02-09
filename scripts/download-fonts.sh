#!/usr/bin/env bash
set -euo pipefail

# Download JetBrains Mono fonts for self-hosting
# Eliminates Google Fonts CDN dependency

FONTS_DIR="$(cd "$(dirname "$0")/../public/vendor/fonts" && pwd)"
TEMP_DIR=$(mktemp -d)
VERSION="2.304"

echo "📦 Downloading JetBrains Mono v${VERSION}..."

cd "$TEMP_DIR"
curl -sL "https://github.com/JetBrains/JetBrainsMono/releases/download/v${VERSION}/JetBrainsMono-${VERSION}.zip" -o fonts.zip

echo "📂 Extracting fonts..."
unzip -q fonts.zip

echo "📋 Copying required fonts to ${FONTS_DIR}..."
cp "fonts/webfonts/JetBrainsMono-Regular.woff2" "$FONTS_DIR/"
cp "fonts/webfonts/JetBrainsMono-Medium.woff2" "$FONTS_DIR/"

echo "🧹 Cleaning up..."
cd - > /dev/null
rm -rf "$TEMP_DIR"

echo "✅ Fonts installed successfully!"
echo ""
echo "Font files:"
ls -lh "$FONTS_DIR"/*.woff2
echo ""
echo "Total size: $(du -sh "$FONTS_DIR" | cut -f1)"
