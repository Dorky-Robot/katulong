# Katulong Homebrew Formula

This directory contains the Homebrew formula for installing Katulong.

## For Users

### Installation

```bash
# Add the tap
brew tap dorky-robot/katulong

# Install katulong
brew install katulong
```

### Usage

```bash
# Start Katulong
katulong start

# Or use Homebrew services for auto-start on login
brew services start katulong

# Check status
katulong status

# View logs
katulong logs

# Stop Katulong
katulong stop
# or
brew services stop katulong
```

## For Maintainers

### Creating a Release

1. **Update version in package.json**
   ```bash
   # Update version to 0.1.0
   npm version 0.1.0 --no-git-tag-version
   ```

2. **Create and push git tag**
   ```bash
   git add package.json
   git commit -m "Release v0.1.0"
   git tag v0.1.0
   git push origin main --tags
   ```

3. **Compute SHA256 hash**
   ```bash
   # Download the tarball
   wget https://github.com/dorky-robot/katulong/archive/refs/tags/v0.1.0.tar.gz

   # Compute hash
   shasum -a 256 v0.1.0.tar.gz
   ```

4. **Update formula**
   - Update `url` in Formula/katulong.rb with correct version
   - Update `sha256` with computed hash
   - Commit and push changes

5. **Test installation**
   ```bash
   # Test from local formula
   brew install --build-from-source ./Formula/katulong.rb
   katulong --version
   katulong start
   katulong status
   brew services start katulong
   brew services list | grep katulong
   ```

### Setting Up the Tap

For the first release, create the tap repository:

```bash
# Create a new repository: dorky-robot/homebrew-katulong
# Copy Formula/katulong.rb to the tap repository

cd ../homebrew-katulong
mkdir -p Formula
cp ../katulong/Formula/katulong.rb Formula/
git add Formula/katulong.rb
git commit -m "Add katulong formula"
git push origin main
```

## Formula Details

### Installation Paths

- **Binary:** `/usr/local/bin/katulong` (or `/opt/homebrew/bin/katulong` on Apple Silicon)
- **App files:** `/usr/local/opt/katulong/` (or `/opt/homebrew/opt/katulong/`)
- **Config/data:** `~/.katulong/`
- **Logs:** `~/.katulong/daemon.log` and `server.log`

### Service Integration

The formula includes a `service` block for `brew services` integration:

```bash
brew services start katulong   # Start and enable auto-start
brew services stop katulong    # Stop and disable auto-start
brew services restart katulong # Restart service
brew services list             # Show all services
```

The service runs with:
- **Keep alive:** Service restarts if it crashes
- **Log path:** `/usr/local/var/log/katulong.log` (or `/opt/homebrew/var/log/`)
- **Environment:** Sets `KATULONG_DATA_DIR` to `~/.katulong`

### Environment Variables

The wrapper script sets:
- `KATULONG_DATA_DIR=~/.katulong` - Config and data directory

Users can override by setting environment variables before running `katulong`:

```bash
export PORT=8080
export KATULONG_DATA_DIR=/custom/path
katulong start
```

## Troubleshooting

### Formula Audit

Before submitting to Homebrew core:

```bash
brew audit --strict --online katulong
brew test katulong
```

### Common Issues

**Issue:** `katulong` command not found after install

**Solution:** Ensure `/usr/local/bin` is in PATH:
```bash
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Issue:** Permission denied on `~/.katulong`

**Solution:** Fix directory permissions:
```bash
chmod 700 ~/.katulong
```

**Issue:** Service won't start

**Solution:** Check service logs:
```bash
tail -f /usr/local/var/log/katulong.log
# or
katulong logs
```
