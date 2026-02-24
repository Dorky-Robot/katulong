import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Browser API mocks
//
// These tests exercise browser-only code (drag-drop + image upload) inside
// Node.js, so we stub out the DOM and Clipboard APIs that the production
// code relies on.
// ---------------------------------------------------------------------------

function setupBrowserGlobals() {
  // Minimal DOM stubs so drag-drop.js can call document.addEventListener
  // and document.getElementById without throwing.
  const listeners = {};
  globalThis.document = {
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    getElementById() {
      return null; // drop-overlay not needed for these tests
    },
    createElement() {
      return {
        className: "",
        textContent: "",
        classList: { add() {}, remove() {} },
        remove() {},
      };
    },
    body: { appendChild() {} },
  };

  // Keep a handle so tests can dispatch synthetic events.
  globalThis.__listeners = listeners;

  // Blob — minimal shim that remembers its content and type.
  globalThis.Blob = class Blob {
    constructor(parts, opts = {}) {
      this._parts = parts;
      this.type = opts.type || "";
    }
  };

  // ClipboardItem — just stores the data dict.
  globalThis.ClipboardItem = class ClipboardItem {
    constructor(data) {
      this._data = data;
    }
  };

  // navigator.clipboard — overridden per-test via mock.
  // In Node.js, `navigator` may be a read-only getter, so use defineProperty.
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        write: mock.fn(async () => {}),
      },
    },
    writable: true,
    configurable: true,
  });

  // requestAnimationFrame / setTimeout needed by showToast but not relevant.
  globalThis.requestAnimationFrame = (fn) => fn();

  // fetch — overridden per-test.
  globalThis.fetch = mock.fn();
}

function teardownBrowserGlobals() {
  delete globalThis.document;
  delete globalThis.__listeners;
  delete globalThis.Blob;
  delete globalThis.ClipboardItem;
  delete globalThis.navigator;
  delete globalThis.requestAnimationFrame;
  delete globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Helper: create a fake File (browser File inherits from Blob)
// ---------------------------------------------------------------------------

function fakeFile(name, type, content = "fake-image-data") {
  const buf = Buffer.from(content);
  return {
    name,
    type,
    size: buf.length,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

// ---------------------------------------------------------------------------
// Helper: fire a synthetic "drop" event through the document listeners that
// drag-drop.js registered.
// ---------------------------------------------------------------------------

function fireDrop(files) {
  const handlers = globalThis.__listeners?.drop || [];
  const event = {
    preventDefault: mock.fn(),
    dataTransfer: { files },
  };
  for (const h of handlers) h(event);
}

// ===================================================================
// 1. Drag-drop clipboard behavior (onDrop callback from app.js)
// ===================================================================

describe("drag-drop image clipboard behavior", () => {
  let rawSendCalls;
  let uploadCalls;
  let dragDropManager;

  beforeEach(async () => {
    setupBrowserGlobals();

    rawSendCalls = [];
    uploadCalls = [];

    // Import the module fresh after globals are set up.
    const { createDragDropManager } = await import("../public/lib/drag-drop.js");
    const { isImageFile } = await import("../public/lib/image-upload.js");

    // Replicate the wiring from app.js:
    // rawSend and uploadImageToTerminal are captured via closures.
    const rawSend = (data) => rawSendCalls.push(data);
    const uploadImageToTerminal = (file) => uploadCalls.push(file);

    dragDropManager = createDragDropManager({
      isImageFile,
      onDrop: async (imageFiles, totalFiles) => {
        if (imageFiles.length === 0) {
          return;
        }
        for (const file of imageFiles) {
          try {
            const blob = new Blob([await file.arrayBuffer()], { type: file.type });
            await navigator.clipboard.write([new ClipboardItem({ [file.type]: blob })]);
            rawSend("\x16");
          } catch {
            uploadImageToTerminal(file);
          }
        }
      },
    });

    dragDropManager.init();
  });

  afterEach(() => {
    teardownBrowserGlobals();
  });

  it("writes image to clipboard and sends Ctrl+V on successful clipboard write", async () => {
    // navigator.clipboard.write resolves successfully (default mock).
    const file = fakeFile("photo.png", "image/png");

    fireDrop([file]);

    // The onDrop callback is async — give it a tick to complete.
    await new Promise((r) => setTimeout(r, 10));

    // Clipboard API should have been called with a ClipboardItem.
    assert.equal(navigator.clipboard.write.mock.callCount(), 1);
    const clipboardArg = navigator.clipboard.write.mock.calls[0].arguments[0];
    assert.equal(clipboardArg.length, 1);
    assert.ok(clipboardArg[0] instanceof ClipboardItem);
    assert.ok(clipboardArg[0]._data["image/png"] instanceof Blob);

    // rawSend should have been called with Ctrl+V (\x16).
    assert.equal(rawSendCalls.length, 1);
    assert.equal(rawSendCalls[0], "\x16");

    // uploadImageToTerminal should NOT have been called.
    assert.equal(uploadCalls.length, 0);
  });

  it("falls back to uploadImageToTerminal when clipboard API throws", async () => {
    // Make clipboard.write reject.
    navigator.clipboard.write = mock.fn(async () => {
      throw new Error("Clipboard API not available");
    });

    const file = fakeFile("screenshot.jpg", "image/jpeg");

    fireDrop([file]);

    await new Promise((r) => setTimeout(r, 10));

    // rawSend should NOT have been called (clipboard write failed before it).
    assert.equal(rawSendCalls.length, 0);

    // Upload fallback should have been called with the file.
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].name, "screenshot.jpg");
  });

  it("processes multiple image files individually", async () => {
    const file1 = fakeFile("a.png", "image/png");
    const file2 = fakeFile("b.jpg", "image/jpeg");

    fireDrop([file1, file2]);

    await new Promise((r) => setTimeout(r, 10));

    // Both images should go through the clipboard path.
    assert.equal(navigator.clipboard.write.mock.callCount(), 2);
    assert.equal(rawSendCalls.length, 2);
    assert.equal(rawSendCalls[0], "\x16");
    assert.equal(rawSendCalls[1], "\x16");
    assert.equal(uploadCalls.length, 0);
  });

  it("uses upload fallback per-file when clipboard fails for one of many files", async () => {
    let callCount = 0;
    navigator.clipboard.write = mock.fn(async () => {
      callCount++;
      if (callCount === 2) throw new Error("fail on second");
    });

    const file1 = fakeFile("a.png", "image/png");
    const file2 = fakeFile("b.png", "image/png");
    const file3 = fakeFile("c.png", "image/png");

    fireDrop([file1, file2, file3]);

    await new Promise((r) => setTimeout(r, 10));

    // First and third succeed via clipboard; second falls back to upload.
    assert.equal(rawSendCalls.length, 2);
    assert.equal(uploadCalls.length, 1);
    assert.equal(uploadCalls[0].name, "b.png");
  });

  it("does nothing when no image files are dropped", async () => {
    // Drop a non-image file; isImageFile will filter it out.
    const file = fakeFile("readme.txt", "text/plain");

    fireDrop([file]);

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(navigator.clipboard.write.mock.callCount(), 0);
    assert.equal(rawSendCalls.length, 0);
    assert.equal(uploadCalls.length, 0);
  });

  it("does nothing when drop has no files at all", async () => {
    fireDrop([]);

    await new Promise((r) => setTimeout(r, 10));

    assert.equal(navigator.clipboard.write.mock.callCount(), 0);
    assert.equal(rawSendCalls.length, 0);
    assert.equal(uploadCalls.length, 0);
  });

  it("creates Blob with correct type from file", async () => {
    const file = fakeFile("pic.webp", "image/webp", "webp-bytes");

    fireDrop([file]);

    await new Promise((r) => setTimeout(r, 10));

    const clipboardArg = navigator.clipboard.write.mock.calls[0].arguments[0];
    const item = clipboardArg[0];
    assert.ok("image/webp" in item._data);
    assert.equal(item._data["image/webp"].type, "image/webp");
  });
});

// ===================================================================
// 2. uploadImageToTerminal — absolutePath vs path preference
// ===================================================================

describe("uploadImageToTerminal", () => {
  beforeEach(() => {
    setupBrowserGlobals();
  });

  afterEach(() => {
    teardownBrowserGlobals();
  });

  it("sends absolutePath (with trailing space) when server returns both absolutePath and path", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ path: "uploads/photo.png", absolutePath: "/home/user/uploads/photo.png" }),
    }));

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const sent = [];
    const file = fakeFile("photo.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: (val) => sent.push(val),
      toast: () => {},
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0], "/home/user/uploads/photo.png ");
  });

  it("falls back to path (with trailing space) when absolutePath is missing", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ path: "uploads/photo.png" }),
    }));

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const sent = [];
    const file = fakeFile("photo.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: (val) => sent.push(val),
      toast: () => {},
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0], "uploads/photo.png ");
  });

  it("falls back to path when absolutePath is empty string", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ path: "uploads/photo.png", absolutePath: "" }),
    }));

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const sent = [];
    const file = fakeFile("photo.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: (val) => sent.push(val),
      toast: () => {},
    });

    assert.equal(sent.length, 1);
    // absolutePath is "" (falsy), so it should fall back to path
    assert.equal(sent[0], "uploads/photo.png ");
  });

  it("does not call onSend when upload fails with non-ok response", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: false,
      json: async () => ({ error: "disk full" }),
    }));

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const sent = [];
    const toasts = [];
    const file = fakeFile("photo.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: (val) => sent.push(val),
      toast: (msg, isError) => toasts.push({ msg, isError }),
    });

    assert.equal(sent.length, 0);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].isError, true);
  });

  it("shows error toast when fetch throws a network error", async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error("network failure");
    });

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const sent = [];
    const toasts = [];
    const file = fakeFile("photo.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: (val) => sent.push(val),
      toast: (msg, isError) => toasts.push({ msg, isError }),
    });

    assert.equal(sent.length, 0);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].isError, true);
  });

  it("sends correct headers and body in the upload request", async () => {
    globalThis.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ path: "uploads/test.png", absolutePath: "/tmp/uploads/test.png" }),
    }));

    const { uploadImageToTerminal } = await import("../public/lib/image-upload.js");

    const file = fakeFile("test.png", "image/png");

    await uploadImageToTerminal(file, {
      onSend: () => {},
      toast: () => {},
    });

    assert.equal(globalThis.fetch.mock.callCount(), 1);
    const [url, opts] = globalThis.fetch.mock.calls[0].arguments;
    assert.equal(url, "/upload");
    assert.equal(opts.method, "POST");
    assert.equal(opts.headers["Content-Type"], "application/octet-stream");
    assert.equal(opts.headers["X-Filename"], "test.png");
    assert.equal(opts.body, file);
  });
});
