# Remote Clipboard Bridge

Katulong provides remote terminal access via a tunnel (ngrok, Cloudflare Tunnel). The browser runs on Machine A (e.g., iPad), the terminal runs on Machine B (e.g., Mac mini). These machines have **separate clipboards** — the browser's clipboard API reads Machine A's clipboard, while CLI tools in the terminal read Machine B's clipboard.

This document explains how image paste works across this boundary and why each piece exists.

## The Problem

When a user copies an image on their iPad and presses Cmd+V in the katulong terminal:

1. The image is on the **iPad's clipboard** (Machine A)
2. Claude Code (running on Machine B) reads the **mini's clipboard** (Machine B)
3. These are different clipboards — Cmd+V alone doesn't bridge them

Without intervention, Cmd+V sends `\x16` (ASCII paste) to the terminal. Claude Code sees this and reads Machine B's clipboard, which has stale or unrelated content.

## The Solution: Upload + Clipboard Bridge

```
iPad (Machine A)                    Mac mini (Machine B)
================                    ====================

1. User presses Cmd+V
        |
2. Browser reads clipboard -----> 3. POST /upload (image bytes)
   via Clipboard API                      |
                                   4. Server saves to disk
                                          |
                                   5. osascript sets Machine B's
                                      clipboard to the saved image
                                          |
6. Browser sends \x16 ----------> 7. Terminal receives Ctrl+V
   (after upload completes)               |
                                   8. Claude Code reads Machine B's
                                      clipboard -> gets the NEW image
```

## Implementation Details

### Three-layer interception (paste-handler.js)

The paste handler must solve three problems simultaneously:

#### Layer 1: Block xterm's keydown handler

xterm.js listens for Cmd+V keydown on its textarea and immediately sends `\x16` to the PTY. This happens **before** the paste event fires, so Claude Code would read the clipboard before we've had a chance to upload the new image.

**Solution**: Capture-phase keydown listener on `document` with `stopImmediatePropagation()` + `preventDefault()`. This fires before xterm's listener and blocks it.

```
document (capture) -> our handler blocks -> xterm textarea (never sees it)
```

#### Layer 2: Handle the paste event (when it fires)

On Chrome and Firefox, `preventDefault()` on keydown does NOT suppress the paste event. The paste event carries `clipboardData` with the image.

**Solution**: Capture-phase paste listener on `document`. Checks `clipboardData.files` first, then `clipboardData.items` (Safari only exposes images via items). Calls `onImage()` to upload, or `onTextPaste()` for text.

#### Layer 3: Clipboard API fallback (WebKit)

On WebKit (Safari, iPad), `preventDefault()` on keydown **suppresses the paste event entirely**. No paste event fires, so Layer 2 never runs.

**Solution**: 200ms fallback timer started in the keydown handler. If no paste event fires within 200ms, reads the clipboard directly via `navigator.clipboard.read()` (for images) and `navigator.clipboard.readText()` (for text).

### Why all three layers are needed

| Browser | Keydown blocked? | Paste event fires? | Fallback needed? |
|---------|-------------------|---------------------|-------------------|
| Chrome  | Yes (Layer 1)     | Yes (Layer 2)       | No                |
| Firefox | Yes (Layer 1)     | Yes (Layer 2)       | No                |
| Safari  | Yes (Layer 1)     | **No**              | **Yes (Layer 3)** |

### Upload flow (image-upload.js)

After the image is detected (via Layer 2 or 3):

1. `uploadImageToTerminal()` sends `POST /upload` with the raw image bytes
2. Server saves to `DATA_DIR/uploads/<uuid>.<ext>` (magic-byte detection for extension)
3. Server copies image to Machine B's clipboard via `osascript`
4. Server responds with `{ clipboard: true/false, fsPath: "..." }`
5. Client sends `\x16` if `clipboard === true` (strict boolean check), or the filesystem path as fallback

### Safari clipboardData quirk

Safari does not populate `clipboardData.files` for images pasted from the system clipboard. Images are only accessible via `clipboardData.items`:

```js
// clipboardData.files = [] on Safari (empty!)
// clipboardData.items = [{ type: "image/png", getAsFile() }] (has the image)
```

Both paths must be checked, and the `items` path must also apply the `isImageFileFn` filter.

### Clipboard API permissions

`navigator.clipboard.read()` (used in Layer 3) requires explicit user permission. The browser will show a permission prompt the first time. This is expected behavior — users must grant clipboard read access for the bridge to work on Safari/WebKit.

`navigator.clipboard.readText()` has a lower permission bar and may work without a prompt.

## Container use case: katulong inside kubo (Docker)

When katulong runs inside a kubo Docker container, the clipboard bridge uses **xclip + Xvfb** instead of `osascript`. This is the most fragile deployment and has regressed multiple times.

### Two scenarios

**Scenario 1: katulong runs in-container** — katulong and Claude Code share the same Xvfb. The xclip write in the upload handler directly sets the clipboard that Claude Code reads.

**Scenario 2: katulong on host, Claude Code in kubo container** — katulong runs on the host machine and the user enters a kubo container via a tmux tab. The host clipboard (osascript/xclip) is **isolated from the container's Xvfb clipboard**. The upload handler must bridge across the container boundary using `docker exec`.

### Architecture (Scenario 1: in-container)

```
iPad (Machine A)                    kubo container (Machine B)
================                    ==========================

1. User presses Cmd+V
        |
2. Browser reads clipboard -----> 3. POST /upload (image bytes)
   via Clipboard API                      |
                                   4. Server saves to
                                      ~/.katulong/uploads/<uuid>.png
                                          |
                                   5. xclip sets X clipboard
                                      (requires DISPLAY=:99 + Xvfb)
                                          |
6. Browser sends \x16 ----------> 7. tmux session receives Ctrl+V
   (after upload completes)               |
                                   8. Claude Code reads X clipboard
                                      via xclip (needs DISPLAY=:99)
                                      -> gets the NEW image
```

### Architecture (Scenario 2: host → container bridge)

```
iPad (Machine A)           Host (Machine B)              kubo container (Machine C)
================           ================              ==========================

1. User presses Cmd+V
        |
2. Browser reads       --> 3. POST /upload
   clipboard                      |
                            4. Save to ~/.katulong/uploads/<uuid>.png
                                  |                              |
                            5a. Set host clipboard         5b. docker exec xclip
                                (osascript/xclip)               in each kubo container
                                                                (DISPLAY=:99)
                                  |                              |
6. Browser sends \x16 --> 7. tmux → docker → Claude Code reads
   (after BOTH 5a+5b           container clipboard → gets image
    complete)
```

Key points for Scenario 2:
- `bridgeClipboardToContainers()` in `routes.js` finds running kubo containers via `docker ps --filter label=managed-by=kubo`
- Uses `docker exec -e DISPLAY=:99 <container> xclip -i` to set each container's clipboard
- The image file is accessible inside the container because `~/.katulong/uploads` is volume-mounted
- **Must be awaited** before returning the upload response — the client sends Ctrl+V immediately on response, so the clipboard must be ready
- The uploads directory is created at katulong startup (not on first upload) so kubo always has a directory to mount

### Why it's fragile (failure modes)

1. **DISPLAY not set**: Xvfb runs on `:99` (started by entrypoint.sh) but `DISPLAY` may not propagate to katulong or tmux child processes. Without DISPLAY, xclip silently fails on both write (upload route) and read (Claude Code).

2. **DISPLAY not in tmux**: Even if katulong has DISPLAY, tmux sessions may not. The fix uses `tmux setenv -g DISPLAY :99` to propagate, but this only affects new shell commands in existing sessions — processes already running won't pick it up.

3. **Xvfb not running**: If the container wasn't started via entrypoint.sh (e.g., manual `docker exec`), Xvfb won't be running. xclip needs a valid X display.

4. **P2P silently dropping data**: The WebSocket manager prefers P2P (WebRTC) for output delivery. If P2P `send()` succeeds but the DataChannel isn't actually open, data is silently lost and the WebSocket fallback is skipped. This can cause the final Ctrl+V or the last bits of Claude Code output to never reach the browser.

### Auto-detection (how we prevent regressions)

katulong auto-detects Xvfb at two points:

1. **Server startup** (`server.js`): Scans `pgrep -a Xvfb` for display number, sets `process.env.DISPLAY`, and runs `tmux setenv -g DISPLAY` to propagate to all tmux sessions.

2. **Upload route** (`lib/routes.js`): Same detection as fallback, in case startup missed it (e.g., Xvfb started after katulong).

### Container mount

kubo mounts `~/.katulong/uploads/` from the host into the container at `/home/dev/.katulong/uploads/` (read-write). This allows:
- Host-side katulong to save uploads that container-side Claude Code can read
- Container-side katulong to save uploads locally

The custom `pbpaste` script in kubo checks both locations.

### Key files (container-specific)

| File | Location | Role |
|------|----------|------|
| `pbpaste` | kubo: `/usr/local/bin/pbpaste` | File-based clipboard bridge (finds latest image in uploads dir) |
| `pbcopy` | kubo: `/usr/local/bin/pbcopy` | Text clipboard storage |
| `entrypoint.sh` | kubo: container entrypoint | Starts Xvfb, sets DISPLAY=:99 |
| `container.rs` | kubo: `crates/kubo-core/src/` | Mounts ~/.katulong/uploads/ into container |

## Files involved

| File | Role |
|------|------|
| `public/lib/paste-handler.js` | Three-layer Cmd+V interception |
| `public/lib/image-upload.js` | Upload + clipboard/path response handling |
| `public/lib/dictation-modal.js` | Paste handler for the dictation textarea (same items fix) |
| `lib/routes.js` (upload handler) | Saves image, sets clipboard via osascript (macOS) or xclip (Linux) |
| `server.js` | Auto-detects Xvfb display at startup, propagates to tmux |
| `lib/ws-manager.js` | Routes output via P2P or WebSocket (P2P fallback is critical) |
| `lib/p2p.js` | P2P DataChannel send — must return success/failure for fallback |

## What NOT to change

1. **Do not remove `preventDefault()` from keydown** — xterm will send `\x16` before the upload completes, causing Claude Code to read stale clipboard content
2. **Do not remove the 200ms fallback timer** — WebKit won't fire the paste event after `preventDefault()` on keydown
3. **Do not remove the `clipboardData.items` check** — Safari only exposes pasted images via items, not files
4. **Do not change `clipboard === true` to truthy check** — server may return non-boolean values on error
5. **Do not send `\x16` as a fallback for "no content detected"** — it reads the stale Machine B clipboard
6. **Do not remove the osascript/xclip clipboard write** — this is the bridge that makes the whole flow work
7. **Do not make P2P send() swallow errors** — the caller must know if data was actually delivered so it can fall back to WebSocket
8. **Do not remove the Xvfb auto-detection** — DISPLAY propagation is the #1 cause of clipboard regressions in containers
9. **Do not make `bridgeClipboardToContainers` fire-and-forget** — the upload response must wait for the bridge to complete, otherwise the client sends Ctrl+V before the container clipboard is ready
10. **Do not remove the uploads directory creation at startup** — kubo only mounts `~/.katulong/uploads` if it exists at container creation time

## Testing

The paste handler can't be fully imported in Node.js (browser-only imports), so tests are split:

- `test/image-drop.test.js` — tests `uploadImageToTerminal` clipboard/path branching, and the items-fallback detection algorithm extracted as a standalone function
- `test/clipboard-bridge.test.js` — tests Xvfb display auto-detection, xclip clipboard set/read, P2P send fallback, imageMimeType mapping, and container bridge resolution
- `test/terminal-keyboard.test.js` — tests Shift+Enter keypress blocking across all event types (keydown/keypress/keyup), meta/alt shortcuts
- E2E tests (`test/e2e/keyboard.e2e.js`) — full browser-level Shift+Enter, plain Enter, Tab
- Manual testing — required for cross-machine clipboard verification (iPad -> tunnel -> container)

### Manual test checklist (container use case)

1. Start katulong inside a kubo container
2. Verify `v<version>` shows in settings
3. Open Claude Code in a tmux session
4. Paste an image from iPad clipboard
5. Verify Claude Code receives and displays the image
6. Check katulong server logs for "Auto-detected Xvfb display" message
7. Verify `tmux showenv -g DISPLAY` returns `:99`
