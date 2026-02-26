Automate the full Homebrew release workflow for katulong. Bump version, tag, push, update formulas, and verify the install.

## Instructions

You are orchestrating a Homebrew release for katulong. The argument `$ARGUMENTS` is an optional version bump type (`patch`, `minor`, `major`) or an explicit semver (e.g., `0.7.0`). Defaults to `patch` if empty.

### Step 1: Pre-flight checks

1. Verify you're on `main`:
   ```
   git branch --show-current
   ```
   If not on `main`, stop and tell the user: "You must be on `main` to release. Switch branches first."

2. Verify the working tree is clean:
   ```
   git status --porcelain
   ```
   If there are uncommitted changes, stop and tell the user: "Working tree is dirty. Commit or stash changes first."

3. Pull latest to avoid conflicts:
   ```
   git pull origin main
   ```

4. Read the current version from `package.json` and tell the user: "Current version: X.Y.Z"

### Step 2: Bump version

Determine the bump type from `$ARGUMENTS`:
- If empty or one of `patch`, `minor`, `major`: run `npm version <type> --no-git-tag-version` (default to `patch`)
- If it looks like a semver (e.g., `1.2.3`): run `npm version $ARGUMENTS --no-git-tag-version`
- Otherwise, stop and tell the user: "Unrecognized argument '$ARGUMENTS'. Expected patch, minor, major, or a semver like 1.2.3."

Read the new version from `package.json` and store it as `NEW_VERSION`. Tell the user: "Bumping to vX.Y.Z"

Check if the tag already exists before proceeding — if it does, revert the version bump and stop:
```
git tag -l "v$NEW_VERSION"
```
If the tag already exists, revert the version bump (`git checkout package.json package-lock.json`) and stop. Tell the user: "Tag v$NEW_VERSION already exists. Delete it with `git tag -d v$NEW_VERSION && git push origin :refs/tags/v$NEW_VERSION` if you want to re-release, or choose a different version."

### Step 3: Commit, tag, and push

Run these commands sequentially:
```
git add package.json package-lock.json
git commit -m "release: v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main --tags
```

If any command fails, stop and report the error.

### Step 4: Compute SHA256

GitHub needs a moment to create the tarball from the new tag.

1. Download the tarball, retrying on any error (including HTTP 404 while GitHub builds it):
   ```
   curl -sL --retry 5 --retry-delay 5 --retry-all-errors -f "https://github.com/dorky-robot/katulong/archive/refs/tags/v${NEW_VERSION}.tar.gz" -o "/tmp/katulong-v${NEW_VERSION}.tar.gz"
   ```
   The `-f` flag makes curl return a non-zero exit code on HTTP errors, and `--retry-all-errors` retries on those failures.

2. Verify the download is a valid gzip archive:
   ```
   file "/tmp/katulong-v${NEW_VERSION}.tar.gz"
   ```
   If the output does not contain "gzip compressed data", stop and tell the user: "Tarball download failed — the file is not a valid gzip archive. GitHub may not have generated it yet. Try again in a minute."

3. Compute the SHA:
   ```
   shasum -a 256 "/tmp/katulong-v${NEW_VERSION}.tar.gz"
   ```

Store the SHA256 value. Tell the user: "SHA256: <hash>"

### Step 5: Update both formula files

#### 5a: Local formula (`Formula/katulong.rb`)

Read the file, then update the `url` and `sha256` lines:
- `url` → `"https://github.com/dorky-robot/katulong/archive/refs/tags/v${NEW_VERSION}.tar.gz"`
- `sha256` → the value computed in Step 4

Use the Edit tool to make these changes.

Commit and push:
```
git pull origin main
git add Formula/katulong.rb
git commit -m "formula: update to v${NEW_VERSION}"
git push origin main
```

#### 5b: Tap formula (`homebrew-katulong/Formula/katulong.rb`)

Read the tap formula file, then update the `url` and `sha256` lines with the same values.

Use the Edit tool to make these changes.

Commit and push from the tap repo. **Note**: the tap repo uses `master` as its default branch, not `main`.
```
cd homebrew-katulong && git pull origin master && git add Formula/katulong.rb && git commit -m "formula: update to v${NEW_VERSION}" && git push origin master
```

### Step 6: Brew upgrade

Run:
```
brew update
```

Then check the currently installed version:
```
brew info katulong --json | jq -r '.[0] | "formula: \(.versions.stable)\ninstalled: \([.installed[].version] | join(","))"'
```

If the installed version already matches `NEW_VERSION`, run:
```
brew reinstall katulong
```

Otherwise:
```
brew upgrade katulong
```

### Step 7: Verify

1. Check the CLI version:
   ```
   katulong --version
   ```
   Confirm it outputs the new version. If it doesn't match, warn the user.

2. Start katulong, verify HTTP is responding, then stop it:
   ```
   katulong start
   ```
   Wait 3 seconds for the server to be ready, then:
   ```
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3001
   ```
   Expect HTTP 200 or 302. If the curl fails or returns an unexpected status, warn the user.

   Stop katulong:
   ```
   katulong stop
   ```
   If `katulong stop` is not available, find and kill the server process:
   ```
   lsof -ti:3001 | xargs kill -9 2>/dev/null
   ```

3. Clean up the temp tarball:
   ```
   rm -f "/tmp/katulong-v${NEW_VERSION}.tar.gz"
   ```

4. Report success:
   ```
   ✅ Released katulong v${NEW_VERSION}
   - Git tag: v${NEW_VERSION}
   - Formula: updated (local + tap)
   - Homebrew: installed and verified
   - HTTP check: passed
   ```
