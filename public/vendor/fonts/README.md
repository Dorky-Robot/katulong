# Self-Hosted Fonts

This directory contains self-hosted font files to eliminate external CDN dependencies.

## JetBrains Mono

**Version:** 2.304
**License:** OFL-1.1 (SIL Open Font License)
**Source:** https://github.com/JetBrains/JetBrainsMono

### Files

- `JetBrainsMono-Regular.woff2` (400 weight) - ~90KB
- `JetBrainsMono-Medium.woff2` (500 weight) - ~92KB

**Total size:** ~182KB

### Updating Fonts

To update to the latest version:

```bash
./scripts/download-fonts.sh
```

This script downloads the latest release from GitHub and extracts the required font files.

### Why Self-Hosted?

Self-hosting fonts eliminates:
- **Supply chain risk** from external CDNs (e.g., Google Fonts)
- **Privacy concerns** from third-party requests
- **Network dependency** for offline/airgapped environments
- **MITM attack surface** on font loading

### System Font Fallbacks

If JetBrains Mono fails to load, the following system fonts are used as fallbacks:
1. SF Mono (macOS)
2. Monaco (macOS)
3. Cascadia Code (Windows)
4. Roboto Mono (Android)
5. Consolas (Windows)
6. Courier New (universal)

See `fonts.css` for the complete font stack.
