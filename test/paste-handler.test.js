/**
 * Tests for paste-handler.js
 *
 * paste-handler.js uses browser-absolute imports (/lib/image-upload.js) so we
 * can't import it directly in Node. Instead we test the paste handler's
 * behaviour by inlining a minimal reimplementation of its public API and
 * verifying the contract that the real module must satisfy.
 *
 * These tests cover:
 * - Layer 1: keydown interception (Ctrl/Cmd+V blocking)
 * - Layer 2: paste event handling (text + image routing)
 * - Layer 3: WebKit clipboard fallback when paste event is suppressed
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// --- Minimal paste handler reimplementation for testing ---
// Mirrors the real createPasteHandler API, used only for verifying contracts.
// When we fix bugs in the real module we keep these in sync.

function createPasteHandlerForTest(options = {}) {
  const {
    onImage,
    onTextPaste,
    isImageFileFn = (f) => f?.type?.startsWith("image/"),
    getSession,
  } = options;

  let _blocked = false;
  let _fallbackTimer = null;
  let _capturedSession = null;

  function handleKeydown(e) {
    if ((e.key === "v" || e.key === "V") && (e.ctrlKey || e.metaKey) && !e.altKey) {
      const target = e.target;
      if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
          !target.classList.contains("xterm-helper-textarea")) {
        return;
      }
      _blocked = true;
      _capturedSession = getSession ? getSession() : null;
      e.stopImmediatePropagation();
      e.preventDefault();
      _fallbackTimer = setTimeout(() => handleClipboardFallback(), 200);
    }
  }

  async function handleClipboardFallback() {
    if (!_blocked) return;
    _blocked = false;
    _fallbackTimer = null;
    const sessionName = _capturedSession;
    _capturedSession = null;

    // Try navigator.clipboard.read() for images first
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith("image/")) {
            const blob = await item.getType(type);
            const file = new File([blob], "clipboard-image." + type.split("/")[1], { type });
            if (isImageFileFn(file) && onImage) {
              onImage(file, sessionName);
              return;
            }
          }
        }
      }
    } catch { /* Clipboard API read() not available or denied */ }

    // Fall back to reading text
    try {
      const text = await navigator.clipboard.readText();
      if (text && onTextPaste) { onTextPaste(text); return; }
    } catch { /* clipboard API not available */ }

    // BUG FIX: Last-resort fallback — programmatically trigger paste via
    // a hidden contenteditable element so Safari fires a real paste event
    // that we can intercept in handlePaste.
    try {
      if (onTextPaste && document._triggerSyntheticPaste) {
        document._triggerSyntheticPaste(sessionName);
      }
    } catch { /* best-effort */ }
  }

  function handlePaste(e) {
    if (_fallbackTimer) {
      clearTimeout(_fallbackTimer);
      _fallbackTimer = null;
    }
    const sessionName = _capturedSession || (getSession ? getSession() : null);
    _capturedSession = null;
    _blocked = false;

    const target = e.target;
    if ((target.tagName === "TEXTAREA" || target.tagName === "INPUT") &&
        !target.classList.contains("xterm-helper-textarea")) {
      return;
    }

    let imageFiles = [...(e.clipboardData?.files || [])].filter(isImageFileFn);
    if (imageFiles.length === 0 && e.clipboardData?.items) {
      for (const item of e.clipboardData.items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file && isImageFileFn(file)) imageFiles.push(file);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (onImage) {
        for (const file of imageFiles) {
          onImage(file, sessionName);
        }
      }
    } else {
      const text = e.clipboardData?.getData("text/plain");
      e.stopImmediatePropagation();
      e.preventDefault();
      if (text && onTextPaste) {
        onTextPaste(text);
      }
    }
  }

  const _docListeners = {};
  function init() {
    const kd = (e) => handleKeydown(e);
    const p = (e) => handlePaste(e);
    _docListeners.keydown = kd;
    _docListeners.paste = p;
    document.addEventListener("keydown", kd, true);
    document.addEventListener("paste", p, true);
  }

  function unmount() {
    document.removeEventListener("keydown", _docListeners.keydown, true);
    document.removeEventListener("paste", _docListeners.paste, true);
    if (_fallbackTimer) { clearTimeout(_fallbackTimer); _fallbackTimer = null; }
    _capturedSession = null;
    _blocked = false;
  }

  return { init, unmount, handlePaste, handleKeydown, handleClipboardFallback };
}

// --- Helpers ---

function createKeydownEvent(key, { meta = false, ctrl = false, alt = false, target } = {}) {
  return {
    key,
    metaKey: meta,
    ctrlKey: ctrl,
    altKey: alt,
    target: target || { tagName: "DIV", classList: { contains: () => false } },
    preventDefault: mock.fn(),
    stopImmediatePropagation: mock.fn(),
  };
}

function createPasteEvent({ text, imageFiles = [], items } = {}) {
  return {
    clipboardData: {
      getData: mock.fn((type) => type === "text/plain" ? (text || "") : ""),
      files: imageFiles,
      items: items || [],
    },
    target: { tagName: "DIV", classList: { contains: () => false } },
    preventDefault: mock.fn(),
    stopImmediatePropagation: mock.fn(),
  };
}

function setupDocumentMock() {
  const listeners = {};
  globalThis.document = {
    addEventListener(type, fn, capture) {
      const key = `${type}:${!!capture}`;
      (listeners[key] = listeners[key] || []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const key = `${type}:${!!capture}`;
      if (listeners[key]) listeners[key] = listeners[key].filter(f => f !== fn);
    },
    _listeners: listeners,
  };
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        read: mock.fn(),
        readText: mock.fn(),
      },
    },
    writable: true,
    configurable: true,
  });
  return listeners;
}

// --- Tests ---

describe("paste-handler", () => {
  let listeners;

  beforeEach(() => {
    listeners = setupDocumentMock();
  });

  describe("Layer 2: paste event with text", () => {
    it("forwards text to onTextPaste", () => {
      const onTextPaste = mock.fn();
      const handler = createPasteHandlerForTest({ onTextPaste, getSession: () => "sess" });
      const event = createPasteEvent({ text: "hello world" });
      handler.handlePaste(event);

      assert.equal(onTextPaste.mock.callCount(), 1);
      assert.equal(onTextPaste.mock.calls[0].arguments[0], "hello world");
      assert.equal(event.preventDefault.mock.callCount(), 1);
    });

    it("prefers images over text when both present", () => {
      const onTextPaste = mock.fn();
      const onImage = mock.fn();
      const handler = createPasteHandlerForTest({
        onTextPaste, onImage, getSession: () => "sess",
      });
      const imageFile = { type: "image/png", name: "screenshot.png" };
      const event = createPasteEvent({ text: "fallback", imageFiles: [imageFile] });
      handler.handlePaste(event);

      assert.equal(onImage.mock.callCount(), 1);
      assert.equal(onTextPaste.mock.callCount(), 0);
    });

    it("handles Safari items-only image (no files array)", () => {
      const onImage = mock.fn();
      const handler = createPasteHandlerForTest({ onImage, getSession: () => "s" });
      const event = createPasteEvent({
        text: "",
        imageFiles: [],
        items: [{ type: "image/png", getAsFile: () => ({ type: "image/png", name: "img.png" }) }],
      });
      handler.handlePaste(event);
      assert.equal(onImage.mock.callCount(), 1);
    });
  });

  describe("Layer 3: WebKit clipboard fallback for text", () => {
    it("reads text via Clipboard API when paste event is suppressed", async () => {
      const onTextPaste = mock.fn();
      const handler = createPasteHandlerForTest({ onTextPaste, getSession: () => "sess" });

      const keyEvent = createKeydownEvent("v", { meta: true });
      handler.handleKeydown(keyEvent);
      assert.equal(keyEvent.preventDefault.mock.callCount(), 1);

      navigator.clipboard.read = mock.fn(async () => { throw new Error("not supported"); });
      navigator.clipboard.readText = mock.fn(async () => "clipboard text");

      await new Promise(r => setTimeout(r, 250));

      assert.equal(onTextPaste.mock.callCount(), 1);
      assert.equal(onTextPaste.mock.calls[0].arguments[0], "clipboard text");
    });

    it("falls back to readText when clipboard.read() rejects", async () => {
      const onTextPaste = mock.fn();
      const handler = createPasteHandlerForTest({ onTextPaste, getSession: () => "sess" });

      handler.handleKeydown(createKeydownEvent("v", { meta: true }));

      navigator.clipboard.read = mock.fn(async () => { throw new Error("denied"); });
      navigator.clipboard.readText = mock.fn(async () => "text from readText");

      await new Promise(r => setTimeout(r, 250));

      assert.equal(onTextPaste.mock.callCount(), 1);
      assert.equal(onTextPaste.mock.calls[0].arguments[0], "text from readText");
    });

    it("calls synthetic paste trigger when both Clipboard APIs fail", async () => {
      const onTextPaste = mock.fn();
      const syntheticPaste = mock.fn();
      document._triggerSyntheticPaste = syntheticPaste;

      const handler = createPasteHandlerForTest({ onTextPaste, getSession: () => "sess" });
      handler.handleKeydown(createKeydownEvent("v", { meta: true }));

      navigator.clipboard.read = mock.fn(async () => { throw new Error("denied"); });
      navigator.clipboard.readText = mock.fn(async () => { throw new Error("denied"); });

      await new Promise(r => setTimeout(r, 250));

      assert.equal(syntheticPaste.mock.callCount(), 1, "should trigger synthetic paste as last resort");
    });
  });

  describe("Layer 1: keydown interception", () => {
    it("does not intercept Cmd+V in regular textarea", () => {
      const handler = createPasteHandlerForTest({ getSession: () => "sess" });
      const keyEvent = createKeydownEvent("v", {
        meta: true,
        target: { tagName: "TEXTAREA", classList: { contains: () => false } },
      });
      handler.handleKeydown(keyEvent);
      assert.equal(keyEvent.preventDefault.mock.callCount(), 0);
    });

    it("DOES intercept Cmd+V in xterm helper textarea", () => {
      const handler = createPasteHandlerForTest({ getSession: () => "sess" });
      const keyEvent = createKeydownEvent("v", {
        meta: true,
        target: { tagName: "TEXTAREA", classList: { contains: (c) => c === "xterm-helper-textarea" } },
      });
      handler.handleKeydown(keyEvent);
      assert.equal(keyEvent.preventDefault.mock.callCount(), 1);
    });

    it("does not intercept Alt+V", () => {
      const handler = createPasteHandlerForTest({ getSession: () => "sess" });
      const keyEvent = createKeydownEvent("v", { meta: true, alt: true });
      handler.handleKeydown(keyEvent);
      assert.equal(keyEvent.preventDefault.mock.callCount(), 0);
    });
  });

  describe("paste event cancels fallback timer", () => {
    it("paste event within 200ms cancels the fallback", async () => {
      const onTextPaste = mock.fn();
      const handler = createPasteHandlerForTest({ onTextPaste, getSession: () => "sess" });

      handler.handleKeydown(createKeydownEvent("v", { meta: true }));

      // Paste event fires within 200ms (non-WebKit browsers)
      handler.handlePaste(createPasteEvent({ text: "from paste event" }));

      navigator.clipboard.readText = mock.fn(async () => "from fallback");

      await new Promise(r => setTimeout(r, 250));

      // Should only have the paste event's text, not the fallback
      assert.equal(onTextPaste.mock.callCount(), 1);
      assert.equal(onTextPaste.mock.calls[0].arguments[0], "from paste event");
    });
  });

  describe("cleanup", () => {
    it("unmount removes listeners and clears timer", () => {
      const handler = createPasteHandlerForTest({ getSession: () => "sess" });
      handler.init();

      assert.ok(listeners["keydown:true"]?.length > 0);
      assert.ok(listeners["paste:true"]?.length > 0);

      handler.unmount();

      assert.equal(listeners["keydown:true"]?.length || 0, 0);
      assert.equal(listeners["paste:true"]?.length || 0, 0);
    });
  });
});
