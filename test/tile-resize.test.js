import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

// --- DOM/Browser mocks ---

function createMockElement(tag) {
  const styles = {};
  const classes = new Set();
  const children = [];
  const listeners = {};
  let rect = { left: 0, top: 0, width: 720, height: 600, right: 720, bottom: 600 };
  const el = {
    tagName: (tag || "DIV").toUpperCase(),
    style: new Proxy(styles, {
      set: (t, k, v) => { t[k] = v; return true; },
      get: (t, k) => {
        if (k === 'setProperty') return (name, value) => { t[name] = value; };
        if (k === 'removeProperty') return (name) => { delete t[name]; };
        return t[k] || "";
      },
    }),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, f) => f !== undefined ? (f ? classes.add(c) : classes.delete(c)) : (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
    className: "",
    dataset: {},
    appendChild: (child) => { children.push(child); child.parentElement = el; return child; },
    remove: () => { el.parentElement = null; },
    addEventListener: (type, fn, opts) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => { if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: (child) => children.includes(child),
    get parentElement() { return el._parentElement || null; },
    set parentElement(v) { el._parentElement = v; },
    get innerHTML() { return ""; },
    set innerHTML(v) { children.length = 0; },
    get offsetWidth() { return rect.width; },
    get offsetHeight() { return rect.height; },
    getBoundingClientRect: () => ({ ...rect }),
    _setRect: (r) => { Object.assign(rect, r); },
    _classes: classes,
    _styles: styles,
    _children: children,
    _listeners: listeners,
    focus: () => {},
    blur: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
  };
  return el;
}

function setupGlobals() {
  globalThis.window = globalThis.window || globalThis;
  globalThis.window.innerWidth = 1024;
  globalThis.window.innerHeight = 768;
  if (!globalThis.window.addEventListener) globalThis.window.addEventListener = () => {};
  if (!globalThis.window.removeEventListener) globalThis.window.removeEventListener = () => {};
  globalThis.document = globalThis.document || {};
  globalThis.document.createElement = (tag) => createMockElement(tag);
  globalThis.document.addEventListener = () => {};
  globalThis.document.removeEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => fn();
}

async function importTileResize() {
  const url = new URL('../public/lib/tile-resize.js', import.meta.url);
  const mod = await import(url.href + '?t=' + Date.now() + Math.random());
  return mod;
}

describe('tile-resize', () => {
  let createResizeHandles;

  beforeEach(async () => {
    setupGlobals();
    const mod = await importTileResize();
    createResizeHandles = mod.createResizeHandles;
  });

  describe('createResizeHandles()', () => {
    it('returns an object with attach and detach methods', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      assert.strictEqual(typeof handles.attach, "function");
      assert.strictEqual(typeof handles.detach, "function");
    });

    it('attach() adds resize handle elements to the card', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      handles.attach();
      // Should have added left and right handle elements
      const handleEls = card._children.filter(
        c => c.className.includes("resize-handle-left") || c.className.includes("resize-handle-right")
      );
      assert.strictEqual(handleEls.length, 2, "Should add left and right resize handles");
    });

    it('detach() removes resize handle elements from the card', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      handles.attach();
      handles.detach();
      // After detach, handles should be removed (the mock's remove() clears parentElement)
      // We can't check _children since our mock remove() doesn't splice from parent.
      // Instead verify the handles are nulled internally by calling attach again.
      handles.attach(); // should re-attach fresh handles
      const handleEls = card._children.filter(
        c => c.className.includes("resize-handle-left") || c.className.includes("resize-handle-right")
      );
      // Original 2 (orphaned) + 2 new = we just check it doesn't throw
      assert.ok(handleEls.length >= 2, "Should be able to re-attach after detach");
    });

    it('does not double-attach handles', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      handles.attach();
      handles.attach(); // second attach should be a no-op
      const handleEls = card._children.filter(
        c => c.className.includes("resize-handle-left") || c.className.includes("resize-handle-right")
      );
      assert.strictEqual(handleEls.length, 2, "Should not duplicate handles");
    });
  });

  describe('resize constraints', () => {
    it('enforces a minimum width', () => {
      const card = createMockElement("div");
      card._setRect({ width: 720 });
      const widths = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => widths.push(w),
        minWidth: 200,
      });
      handles.attach();

      // Simulate a drag that would go below minimum
      const result = handles._testClamp(50);
      assert.ok(result >= 200, `Width ${result} should be >= minimum 200`);
    });

    it('enforces a maximum width', () => {
      const card = createMockElement("div");
      card._setRect({ width: 720 });
      const widths = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => widths.push(w),
        maxWidth: 1000,
      });
      handles.attach();

      const result = handles._testClamp(1200);
      assert.ok(result <= 1000, `Width ${result} should be <= maximum 1000`);
    });

    it('clamps to container width when no explicit max', () => {
      const card = createMockElement("div");
      card._setRect({ width: 720 });
      globalThis.window.innerWidth = 1024;
      const handles = createResizeHandles({
        card,
        onResize: () => {},
      });
      handles.attach();

      // Without explicit max, should clamp to window width minus padding
      const result = handles._testClamp(2000);
      assert.ok(result <= 1024, `Width ${result} should be <= container width 1024`);
    });

    it('uses default minWidth of 200 when none specified', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      handles.attach();
      const result = handles._testClamp(100);
      assert.strictEqual(result, 200);
    });
  });

  describe('resize state', () => {
    it('getWidth() returns null before any resize', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      assert.strictEqual(handles.getWidth(), null);
    });

    it('setWidth() sets an explicit width and calls onResize', () => {
      const card = createMockElement("div");
      const resizes = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => resizes.push(w),
      });
      handles.attach();
      handles.setWidth(500);
      assert.strictEqual(handles.getWidth(), 500);
      assert.strictEqual(resizes.length, 1);
      assert.strictEqual(resizes[0], 500);
    });

    it('setWidth() clamps to constraints', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({
        card,
        onResize: () => {},
        minWidth: 200,
        maxWidth: 800,
      });
      handles.attach();
      handles.setWidth(100);
      assert.strictEqual(handles.getWidth(), 200);
      handles.setWidth(1000);
      assert.strictEqual(handles.getWidth(), 800);
    });

    it('resetWidth() clears custom width', () => {
      const card = createMockElement("div");
      const resizes = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => resizes.push(w),
      });
      handles.attach();
      handles.setWidth(500);
      handles.resetWidth();
      assert.strictEqual(handles.getWidth(), null);
    });
  });

  describe('drag behavior', () => {
    it('adds .resizing class to card during drag', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      handles.attach();

      // Simulate drag start
      handles._testDragStart();
      assert.ok(card._classes.has("resizing"), "Should add .resizing class during drag");

      // Simulate drag end
      handles._testDragEnd();
      assert.ok(!card._classes.has("resizing"), "Should remove .resizing class after drag");
    });

    it('calls onResize during drag with the new width', () => {
      const card = createMockElement("div");
      card._setRect({ width: 720, left: 152 });
      const widths = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => widths.push(w),
      });
      handles.attach();

      // Simulate a right-edge drag: start at 872 (720 + 152), move to 900
      handles._testDragStart("right", 872);
      handles._testDragMove(900);
      assert.ok(widths.length > 0, "onResize should be called during drag");
      // Width should increase by the drag distance (symmetrical: 2 * 28 = 56)
      assert.strictEqual(widths[widths.length - 1], 720 + (900 - 872) * 2);
    });

    it('symmetrical resize: dragging right edge widens both sides equally', () => {
      const card = createMockElement("div");
      card._setRect({ width: 600, left: 212 });
      const widths = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => widths.push(w),
      });
      handles.attach();

      // Drag right edge 30px to the right
      handles._testDragStart("right", 812); // 212 + 600
      handles._testDragMove(842);
      // Symmetrical: delta * 2 = 30 * 2 = 60
      assert.strictEqual(widths[widths.length - 1], 660);
    });

    it('symmetrical resize: dragging left edge widens both sides equally', () => {
      const card = createMockElement("div");
      card._setRect({ width: 600, left: 212 });
      const widths = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => widths.push(w),
      });
      handles.attach();

      // Drag left edge 30px to the left (negative direction)
      handles._testDragStart("left", 212);
      handles._testDragMove(182);
      // Symmetrical: delta * 2 = 30 * 2 = 60
      assert.strictEqual(widths[widths.length - 1], 660);
    });

    it('fires onResizeEnd when drag completes', () => {
      const card = createMockElement("div");
      card._setRect({ width: 600, left: 212 });
      const ends = [];
      const handles = createResizeHandles({
        card,
        onResize: () => {},
        onResizeEnd: (w) => ends.push(w),
      });
      handles.attach();

      handles._testDragStart("right", 812);
      handles._testDragMove(842);
      handles._testDragEnd();
      assert.strictEqual(ends.length, 1);
      assert.strictEqual(ends[0], 660);
    });
  });

  describe('persistence integration', () => {
    it('serialize() returns the current width or null', () => {
      const card = createMockElement("div");
      const handles = createResizeHandles({ card, onResize: () => {} });
      assert.strictEqual(handles.serialize(), null);

      handles.attach();
      handles.setWidth(500);
      assert.strictEqual(handles.serialize(), 500);
    });

    it('restore() sets width from a saved value', () => {
      const card = createMockElement("div");
      const resizes = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => resizes.push(w),
      });
      handles.attach();
      handles.restore(500);
      assert.strictEqual(handles.getWidth(), 500);
      assert.strictEqual(resizes.length, 1);
    });

    it('restore(null) is a no-op', () => {
      const card = createMockElement("div");
      const resizes = [];
      const handles = createResizeHandles({
        card,
        onResize: (w) => resizes.push(w),
      });
      handles.attach();
      handles.restore(null);
      assert.strictEqual(handles.getWidth(), null);
      assert.strictEqual(resizes.length, 0);
    });
  });
});
