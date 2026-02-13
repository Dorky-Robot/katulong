# Katulong CLI & Homebrew Installation Plan

## Overview

Goal: Make Katulong easy to install and manage via Homebrew with a `katulong` CLI command.

**Strategy:** Keep Node.js (no Rust rewrite), create a CLI tool, package for Homebrew.

---

## Phase 1: CLI Tool (COMPLETED ✓)

### What I've Built

#### Core Infrastructure
- **`bin/katulong`** - Main CLI entry point (executable Node.js script)
  - Parses commands and flags
  - Dispatches to command modules
  - Handles `--help` and `--version`

- **`lib/cli/process-manager.js`** - Shared utilities for process detection
  - `isDaemonRunning()` - Checks daemon status via PID file, socket, or process name
  - `isServerRunning()` - Checks if server is listening on port
  - `readPidFile()` - Reads and validates PID files
  - `getUrls()` - Returns HTTP/HTTPS/SSH URLs
  - Exports common paths (DATA_DIR, SOCKET_PATH, etc.)

#### Commands Implemented

1. **`katulong status`** (`lib/cli/commands/status.js`)
   - Shows daemon and server status
   - Displays PIDs and detection method
   - Shows access URLs if running
   - Exit code 0 if both running, 1 otherwise

2. **`katulong start`** (`lib/cli/commands/start.js`)
   - Starts daemon if not running
   - Starts server if not running
   - Detached mode by default (runs in background)
   - `--foreground` flag for debugging
   - Shows PIDs and access URLs when done

3. **`katulong stop`** (`lib/cli/commands/stop.js`)
   - Stops server first (graceful SIGTERM, then SIGKILL)
   - Stops daemon using `scripts/kill-daemon.sh`
   - Verifies both processes stopped

4. **`katulong restart`** (`lib/cli/commands/restart.js`)
   - Calls stop then start
   - Passes through any flags to start

5. **`katulong logs`** (`lib/cli/commands/logs.js`)
   - Stream logs from `daemon.log` and/or `server.log`
   - Usage: `katulong logs [daemon|server|both]`
   - `--no-follow` flag for one-time output
   - Uses `tail -f` for streaming

6. **`katulong open`** (`lib/cli/commands/open.js`)
   - Opens http://localhost:3001 in browser
   - Detects OS (macOS/Linux/Windows)
   - Uses `open`, `xdg-open`, or `start` accordingly

7. **`katulong info`** (`lib/cli/commands/info.js`)
   - Shows version, Node.js version, platform
   - Shows daemon/server status
   - Shows configuration (data dir, socket, PID file, shell)
   - Shows ports (HTTP, HTTPS, SSH)
   - Shows access URLs if running

#### Integration Points

- Uses existing `scripts/kill-daemon.sh` for safe daemon shutdown
- Uses existing `daemon.pid` file created by daemon.js
- Respects environment variables (PORT, HTTPS_PORT, SSH_PORT, KATULONG_DATA_DIR, etc.)
- No changes needed to daemon.js or server.js

#### Testing Status

✅ CLI help works
✅ Status detection works (tested with running daemon/server)
✅ Info command shows correct system information
✅ Installed locally with `npm link` successfully

---

## Phase 2: Log Management (OPTIONAL)

### Current Limitation

Right now, start command spawns processes with `stdio: "ignore"`, which means logs are lost.

### Solution Options

**Option A: Write to log files** (Recommended)
- Modify start command to redirect stdio to `daemon.log` and `server.log`
- Makes `katulong logs` actually useful
- Required for production use

**Option B: Keep current behavior**
- Good for development (users run `npm run dev` instead)
- Production users use launchd which handles logging

**Recommendation:** Implement Option A. Add log file redirection in start.js:

```javascript
const daemonLog = fs.openSync(join(DATA_DIR, "daemon.log"), "a");
const daemonProcess = spawn("node", [join(ROOT, "daemon.js")], {
  detached: true,
  stdio: ["ignore", daemonLog, daemonLog],
});
```

**Time estimate:** 30 minutes

---

## Phase 3: Homebrew Formula (TODO)

### File Structure

Create a Homebrew tap repository: `dorky-robot/homebrew-katulong`

```
dorky-robot/homebrew-katulong/
├── Formula/
│   └── katulong.rb
└── README.md
```

### Formula Implementation

**File:** `Formula/katulong.rb`

```ruby
class Katulong < Formula
  desc "Self-hosted web terminal with remote shell access"
  homepage "https://github.com/dorky-robot/katulong"
  url "https://github.com/dorky-robot/katulong/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "TODO_COMPUTE_FROM_TARBALL"
  license "MIT"

  depends_on "node"

  def install
    # Install dependencies
    system "npm", "install", "--production"

    # Copy everything to libexec
    libexec.install Dir["*"]

    # Create symlink to CLI
    bin.install_symlink libexec/"bin/katulong"
  end

  def post_install
    # Create config directory
    (var/"katulong").mkpath
  end

  test do
    system "#{bin}/katulong", "--version"
  end

  service do
    # TODO: Define launchd service (Phase 4)
  end
end
```

### Installation Flow

1. User runs: `brew tap dorky-robot/katulong`
2. User runs: `brew install katulong`
3. Homebrew:
   - Installs Node.js (if not present)
   - Downloads katulong tarball
   - Runs `npm install --production`
   - Installs to `/usr/local/opt/katulong` (or `/opt/homebrew/opt/katulong` on Apple Silicon)
   - Symlinks `katulong` to `/usr/local/bin/katulong`
4. User runs: `katulong start`

### Directory Layout After Install

```
/usr/local/opt/katulong/          (or /opt/homebrew/opt/katulong)
├── bin/
│   └── katulong                  → symlinked to /usr/local/bin/katulong
├── lib/
│   ├── cli/
│   │   ├── commands/
│   │   └── process-manager.js
│   └── [all other lib files]
├── daemon.js
├── server.js
├── public/
├── node_modules/
└── package.json

~/.config/katulong/               (user data, created on first run)
├── daemon.log
├── server.log
├── daemon.pid
├── auth.json
└── tls/
```

### Environment Variables

Need to set `KATULONG_DATA_DIR` to user config directory by default when installed via Homebrew.

**Option A:** Set in formula
```ruby
def install
  # ... install steps ...

  # Set default data dir in a wrapper script
  (bin/"katulong").write <<~EOS
    #!/bin/bash
    export KATULONG_DATA_DIR="${HOME}/.config/katulong"
    exec "#{libexec}/bin/katulong" "$@"
  EOS
end
```

**Option B:** Detect Homebrew install in CLI
```javascript
// In bin/katulong
if (process.env.KATULONG_DATA_DIR === undefined) {
  // Detect if installed via Homebrew
  if (__dirname.includes('/opt/homebrew') || __dirname.includes('/usr/local')) {
    process.env.KATULONG_DATA_DIR = join(os.homedir(), '.config/katulong');
  }
}
```

**Recommendation:** Option B (detect in CLI). More flexible, works for all install methods.

**Time estimate:** 2-3 hours (formula writing + testing + tap setup)

---

## Phase 4: Service Management (OPTIONAL)

### Goal

Auto-start Katulong on login using macOS launchd.

### Commands to Add

- `katulong install-service` - Register with launchd
- `katulong uninstall-service` - Remove from launchd
- `katulong enable` - Enable auto-start (alias for install-service)
- `katulong disable` - Disable auto-start (alias for uninstall-service)

### LaunchAgent Structure

Two plist files needed (daemon and server run as separate agents):

**`~/Library/LaunchAgents/com.katulong.daemon.plist`**
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.katulong.daemon</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/opt/katulong/daemon.js</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>KATULONG_DATA_DIR</key>
    <string>~/.config/katulong</string>
  </dict>

  <key>KeepAlive</key>
  <true/>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>~/.config/katulong/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>~/.config/katulong/daemon.log</string>
</dict>
</plist>
```

**`~/Library/LaunchAgents/com.katulong.server.plist`**
(Similar structure, depends on daemon starting first)

### Implementation

**File:** `lib/cli/commands/install-service.js`

```javascript
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

export default async function installService() {
  const homeDir = process.env.HOME;
  const launchAgentsDir = join(homeDir, "Library/LaunchAgents");

  // Generate plist files
  const daemonPlist = generateDaemonPlist();
  const serverPlist = generateServerPlist();

  // Write plist files
  writeFileSync(join(launchAgentsDir, "com.katulong.daemon.plist"), daemonPlist);
  writeFileSync(join(launchAgentsDir, "com.katulong.server.plist"), serverPlist);

  // Load services
  execSync("launchctl load ~/Library/LaunchAgents/com.katulong.daemon.plist");
  execSync("launchctl load ~/Library/LaunchAgents/com.katulong.server.plist");

  console.log("✓ Katulong installed as a service");
  console.log("  Will start automatically on login");
}
```

**Alternative: Use Homebrew Services**

Homebrew has built-in service management:

```bash
brew services start katulong
brew services stop katulong
brew services restart katulong
```

This requires defining a `service` block in the formula:

```ruby
service do
  run [opt_bin/"katulong", "start", "--foreground"]
  keep_alive true
  log_path var/"log/katulong.log"
  error_log_path var/"log/katulong.log"
end
```

**Recommendation:** Use Homebrew services instead of custom implementation. Simpler and more standard.

**Time estimate:** 1 hour (if using Homebrew services), 4 hours (if custom implementation)

---

## Phase 5: Documentation (TODO)

### Files to Create

1. **`docs/INSTALLATION.md`**
   - Homebrew installation instructions
   - Manual installation instructions
   - Troubleshooting guide

2. **`docs/CLI.md`**
   - Complete command reference
   - Examples for each command
   - Environment variables

3. **Update `README.md`**
   - Add installation section
   - Show `brew install` as primary method
   - Show CLI usage examples

### README Installation Section

```markdown
## Installation

### Homebrew (macOS)

```bash
brew tap dorky-robot/katulong
brew install katulong
```

### Manual Installation

```bash
git clone https://github.com/dorky-robot/katulong.git
cd katulong
npm install
npm link  # Makes 'katulong' command available
```

## Quick Start

```bash
# Start Katulong
katulong start

# Check status
katulong status

# Open in browser
katulong open

# View logs
katulong logs

# Stop Katulong
katulong stop
```

## Service Management

Start Katulong automatically on login:

```bash
brew services start katulong
```
```

**Time estimate:** 1-2 hours

---

## Phase 6: Release Process (TODO)

### Steps for First Release

1. **Create GitHub Release**
   - Tag: `v0.1.0`
   - Title: "Initial Release"
   - Attach tarball: `katulong-0.1.0.tar.gz`

2. **Compute SHA256**
   ```bash
   wget https://github.com/dorky-robot/katulong/archive/refs/tags/v0.1.0.tar.gz
   shasum -a 256 v0.1.0.tar.gz
   ```

3. **Update Formula**
   - Update `url` with release URL
   - Update `sha256` with computed hash
   - Commit and push to tap

4. **Test Installation**
   ```bash
   brew uninstall katulong || true
   brew untap dorky-robot/katulong || true
   brew tap dorky-robot/katulong
   brew install katulong
   katulong --version
   katulong start
   katulong status
   ```

**Time estimate:** 1 hour

---

## Summary

### What's Done (Phase 1)
✅ CLI tool with all core commands
✅ Process management utilities
✅ Help and version flags
✅ Tested locally with `npm link`

### What's Next

**Immediate (Must-have):**
- [ ] Phase 2: Log file redirection in start command (30 min)
- [ ] Phase 3: Homebrew formula (2-3 hours)
- [ ] Phase 5: Update README (1 hour)
- [ ] Phase 6: Create v0.1.0 release (1 hour)

**Optional (Nice-to-have):**
- [ ] Phase 4: Service management via Homebrew services (1 hour)

**Total time to ship:** ~5-6 hours

### Testing Checklist

Before release:
- [ ] Test `katulong start/stop/restart` on clean system
- [ ] Test `katulong status` with stopped/running processes
- [ ] Test `katulong logs` with actual log files
- [ ] Test `katulong open` in Safari/Chrome
- [ ] Test Homebrew install on clean macOS system
- [ ] Test Homebrew uninstall leaves no artifacts
- [ ] Test service auto-start after reboot

---

## Open Questions

1. **Should we make log redirection mandatory?**
   - Current: Processes run detached with stdio ignored
   - Proposed: Redirect to daemon.log and server.log
   - Impact: Makes `katulong logs` actually useful

2. **Should we support Homebrew services?**
   - Pros: Standard, well-tested, familiar to users
   - Cons: Adds complexity to formula
   - Alternative: Document `launchctl` commands

3. **Should DATA_DIR default to ~/.config/katulong for Homebrew installs?**
   - Pros: Follows XDG standards, cleaner than project directory
   - Cons: Different behavior between manual and Homebrew installs
   - Proposed: Yes, detect Homebrew install in CLI and set default

4. **Should we publish to NPM?**
   - Pros: Easier distribution, no tarball management
   - Cons: Private package (won't work), need to make public
   - Proposed: No for now, use GitHub releases

---

## Implementation Priority

**Ship v0.1.0 with:**
1. CLI tool (done)
2. Log redirection (30 min)
3. Homebrew formula (2-3 hours)
4. README update (1 hour)

**Total: 1 working day**

**Save for v0.2.0:**
- Homebrew services integration
- Service management commands
- Advanced configuration commands
