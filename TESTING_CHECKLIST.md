# Homebrew Formula Testing Checklist

Test these before merging PR #53 and creating the v0.1.0 release.

## Pre-Install Testing

- [ ] Formula audits cleanly
  ```bash
  brew audit --strict ./Formula/katulong.rb
  ```

- [ ] Formula has correct structure
  ```bash
  brew cat ./Formula/katulong.rb
  ```

## Installation Testing

- [ ] Clean install works
  ```bash
  brew install --build-from-source ./Formula/katulong.rb
  ```

- [ ] Binary is in PATH
  ```bash
  which katulong
  # Should show: /usr/local/bin/katulong (or /opt/homebrew/bin/katulong)
  ```

- [ ] Version command works
  ```bash
  katulong --version
  # Should show: katulong v0.1.0
  ```

- [ ] Help command works
  ```bash
  katulong --help
  # Should show full help text
  ```

## CLI Testing

- [ ] Start command works
  ```bash
  katulong start
  # Should start both daemon and server
  # Should show log file paths
  ```

- [ ] Status command works
  ```bash
  katulong status
  # Should show daemon and server running
  # Should show access URLs
  ```

- [ ] Info command works
  ```bash
  katulong info
  # Should show version, Node.js version, platform
  # Should show DATA_DIR as ~/.config/katulong
  ```

- [ ] Logs are created in correct location
  ```bash
  ls -la ~/.config/katulong/
  # Should show daemon.log and server.log
  ```

- [ ] Logs command works
  ```bash
  katulong logs --no-follow
  # Should show logs from both files
  ```

- [ ] Individual service control works
  ```bash
  katulong stop server
  katulong status  # Server should be stopped
  katulong start server
  katulong status  # Server should be running
  ```

- [ ] Browser opens correctly
  ```bash
  katulong open
  # Should open http://localhost:3001 in browser
  ```

- [ ] Stop command works
  ```bash
  katulong stop
  katulong status  # Both should be stopped
  ```

## Service Integration Testing

- [ ] Service starts via brew services
  ```bash
  brew services start katulong
  sleep 3
  katulong status  # Should show running
  ```

- [ ] Service appears in brew services list
  ```bash
  brew services list | grep katulong
  # Should show: started
  ```

- [ ] Service logs to correct location
  ```bash
  tail -f /usr/local/var/log/katulong.log
  # (or /opt/homebrew/var/log/katulong.log on Apple Silicon)
  # Should show katulong output
  ```

- [ ] Service can be restarted
  ```bash
  brew services restart katulong
  sleep 3
  katulong status  # Should still be running
  ```

- [ ] Service can be stopped
  ```bash
  brew services stop katulong
  sleep 2
  katulong status  # Should show not running
  ```

## Application Testing

- [ ] Web interface loads at http://localhost:3001
- [ ] HTTPS interface loads at https://localhost:3002 (self-signed cert warning expected)
- [ ] WebAuthn registration works
- [ ] Terminal I/O works (type commands, see output)
- [ ] Session management works (create/rename/delete sessions)
- [ ] Device pairing works (QR code + PIN)
- [ ] SSH access works
  ```bash
  ssh -p 2222 default@localhost
  # Use password from logs or katulong info
  ```

## Data Directory Testing

- [ ] Config directory created automatically
  ```bash
  ls -la ~/.config/katulong
  # Should exist with correct permissions (700)
  ```

- [ ] Data persists across restarts
  ```bash
  katulong start
  # Create a session, add some data
  katulong restart
  # Session should still exist
  ```

- [ ] Logs persist and append correctly
  ```bash
  wc -l ~/.config/katulong/daemon.log
  katulong restart
  wc -l ~/.config/katulong/daemon.log
  # Line count should increase
  ```

## Uninstall Testing

- [ ] Uninstall removes binary
  ```bash
  brew uninstall katulong
  which katulong
  # Should return: not found
  ```

- [ ] Config directory persists (expected behavior)
  ```bash
  ls -la ~/.config/katulong
  # Should still exist (user data preserved)
  ```

- [ ] Services are stopped
  ```bash
  brew services list | grep katulong
  # Should not appear, or show "stopped"
  ```

## Edge Cases

- [ ] Works with KATULONG_DATA_DIR override
  ```bash
  export KATULONG_DATA_DIR=/tmp/katulong-test
  katulong start
  ls /tmp/katulong-test
  # Should create logs there
  unset KATULONG_DATA_DIR
  ```

- [ ] Handles port conflicts gracefully
  ```bash
  # Start something on port 3001
  nc -l 3001 &
  katulong start
  # Should show error about port being in use
  killall nc
  ```

- [ ] Multiple installs don't conflict
  ```bash
  # Test with both Homebrew and npm link
  npm link
  which -a katulong
  # Should show Homebrew version takes precedence
  ```

## Performance Testing

- [ ] Startup time is reasonable (< 3 seconds)
  ```bash
  time katulong start
  ```

- [ ] Terminal is responsive
  - Type commands quickly
  - Test autocomplete
  - Test arrow key navigation

- [ ] Log files don't grow unbounded
  ```bash
  # Let it run for a while
  du -h ~/.config/katulong/
  # Should be reasonable (< 10MB for normal usage)
  ```

## Documentation Verification

- [ ] Formula/README.md matches actual behavior
- [ ] Main README installation instructions work
- [ ] GitHub Pages shows correct installation steps

## Final Checks

- [ ] No errors in console logs
- [ ] No warning messages during normal operation
- [ ] All environment variables respected
- [ ] Works on both Intel and Apple Silicon Macs (if available)

---

## Testing Notes

**When testing fails:**
1. Check logs: `katulong logs` or `tail -f /usr/local/var/log/katulong.log`
2. Check processes: `katulong status` and `ps aux | grep katulong`
3. Check data dir: `ls -la ~/.config/katulong/`
4. Uninstall and retry: `brew uninstall katulong && rm -rf ~/.config/katulong`

**Common issues:**
- Port already in use → Check `lsof -ti:3001,3002` and kill processes
- Daemon won't start → Check socket: `lsof /tmp/katulong-daemon.sock`
- Logs empty → Check if running in foreground mode by accident
- Permission denied → Check `~/.config/katulong` permissions (should be 700)
