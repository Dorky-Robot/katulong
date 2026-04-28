Cut a new release for katulong — bump version, tag, push, update Homebrew formulas, and verify the install.

## Step 1: Pre-flight checks

Verify the release environment is ready:

```bash
git branch --show-current
git status --porcelain
```

**Abort if:**
- Not on `main` — switch first or confirm with the user
- Working tree is dirty — commit or stash first

Pull latest to avoid conflicts:

```bash
git pull origin main
```

Show the current version:

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json')).version)"
```

## Step 2: Determine bump type

Check `$ARGUMENTS` for the bump type.

- If `$ARGUMENTS` contains `patch`, `minor`, `major`, or an explicit semver like `1.2.3`, use that.
- If `$ARGUMENTS` is empty or unclear, ask the user:
  - **patch** — bug fixes, docs, small tweaks
  - **minor** — new features, backward-compatible changes
  - **major** — breaking changes

Default to `patch` if empty.

## Step 3: Bump version

```bash
npm version <bump-type> --no-git-tag-version
```

Read the new version from package.json and store it as `NEW_VERSION`.

Check if the tag already exists:

```bash
git tag -l "v$NEW_VERSION"
```

If the tag exists, revert the bump (`git checkout package.json package-lock.json`) and stop. Tell the user to delete the existing tag or choose a different version.

## Step 4: Commit, tag, and push

```bash
git add package.json package-lock.json
git commit -m "release: v$NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin main --tags
```

## Step 5: Compute SHA256

Download the tarball with retries (GitHub needs time to create it):

```bash
curl -sL --retry 5 --retry-delay 5 --retry-all-errors -f \
  "https://github.com/dorky-robot/katulong/archive/refs/tags/v${NEW_VERSION}.tar.gz" \
  -o "/tmp/katulong-v${NEW_VERSION}.tar.gz"
```

Verify it's valid gzip:

```bash
file "/tmp/katulong-v${NEW_VERSION}.tar.gz"
```

Compute the SHA:

```bash
shasum -a 256 "/tmp/katulong-v${NEW_VERSION}.tar.gz"
```

## Step 6: Update the local formula

Read `Formula/katulong.rb`, then update the `url` and `sha256` lines using the Edit tool.

Commit and push:

```bash
git pull origin main
git add Formula/katulong.rb
git commit -m "formula: update to v${NEW_VERSION}"
git push origin main
```

The GitHub Release workflow syncs the updated formula into the canonical tap
at https://github.com/Dorky-Robot/homebrew-tap automatically — no manual
cross-repo push is needed. (The deprecated `Dorky-Robot/homebrew-katulong`
tap is no longer updated.)

## Step 7: Upgrade the running install

Use `katulong update` — never plain `brew upgrade dorky-robot/tap/katulong`. The
update command writes a `~/.katulong/.update-in-progress` sentinel that the
formula's `post_install` checks for; with the sentinel present, brew skips its
own `katulong service restart` and `katulong update` orchestrates the
smoke-test-and-swap with proper port handoff. Without the sentinel, brew's
`post_install` `bootout`s the still-listening old server and tries to bootstrap
the new one — but the bootstrap can fail when the old PID is still gripping
port 3001 in the race window. The plist has `KeepAlive: SuccessfulExit=false`,
so a clean SIGTERM exit (code 0) won't auto-respawn, leaving the service down.

First confirm the tap's formula has caught up to NEW_VERSION (the release
workflow takes a minute or two to push the SHA bump):

```bash
brew update
brew info dorky-robot/tap/katulong --json | jq -r '.[0] | "formula: \(.versions.stable)\ninstalled: \([.installed[].version] | join(","))"'
```

Once `formula:` matches NEW_VERSION, run:

```bash
katulong update
```

If `katulong update` reports "Already up to date", the running service is
already on NEW_VERSION (this happens on a re-run, or if the host was upgraded
out-of-band). Confirm with `katulong --version` and `katulong status`, then
proceed to Step 8 — there is nothing to bounce. Do **not** fall back to
`katulong service restart` here: that re-introduces the exact bootout/bootstrap
race this step was rewritten to avoid. The only time a bounce is appropriate
is when `katulong status` reports the service is **not running** despite the
binary being current — in that case `katulong start` (or `katulong service
restart` if the LaunchAgent is loaded) is the recovery path.

## Step 8: Verify

`katulong update` leaves the service running on its production port — do not
stop it to verify. Just hit it.

1. Check CLI version:
   ```bash
   katulong --version
   ```

2. Verify HTTP without disrupting the service:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
   ```

3. Clean up:
   ```bash
   rm -f "/tmp/katulong-v${NEW_VERSION}.tar.gz"
   ```

4. Report:
   ```
   Released katulong v${NEW_VERSION}
   - Git tag: v${NEW_VERSION}
   - Formula: updated (local + tap)
   - Homebrew: installed and verified
   - HTTP check: passed
   ```
