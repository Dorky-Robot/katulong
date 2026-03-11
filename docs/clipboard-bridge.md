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

## Files involved

| File | Role |
|------|------|
| `public/lib/paste-handler.js` | Three-layer Cmd+V interception |
| `public/lib/image-upload.js` | Upload + clipboard/path response handling |
| `public/lib/dictation-modal.js` | Paste handler for the dictation textarea (same items fix) |
| `lib/routes.js` (upload handler) | Saves image, sets Machine B's clipboard via osascript |

## What NOT to change

1. **Do not remove `preventDefault()` from keydown** — xterm will send `\x16` before the upload completes, causing Claude Code to read stale clipboard content
2. **Do not remove the 200ms fallback timer** — WebKit won't fire the paste event after `preventDefault()` on keydown
3. **Do not remove the `clipboardData.items` check** — Safari only exposes pasted images via items, not files
4. **Do not change `clipboard === true` to truthy check** — server may return non-boolean values on error
5. **Do not send `\x16` as a fallback for "no content detected"** — it reads the stale Machine B clipboard
6. **Do not remove the osascript clipboard write** — this is the bridge that makes the whole flow work

## Testing

The paste handler can't be fully imported in Node.js (browser-only imports), so tests are split:

- `test/image-drop.test.js` — tests `uploadImageToTerminal` clipboard/path branching, and the items-fallback detection algorithm extracted as a standalone function
- E2E tests — full browser-level paste behavior (Playwright)
- Manual testing — required for cross-machine clipboard verification (iPad -> tunnel -> mini)
