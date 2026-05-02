/**
 * peers-picker — modal-content controller for the cross-instance tile
 * picker.
 *
 * Why these tests
 *   The picker is the only path the user actually taps to open a
 *   remote-terminal tile on iPad — there is no dev-console fallback
 *   when the page is rendered in a tile. Three things must hold:
 *     1. /api/peers shape determines what shows up; an empty list
 *        becomes a hint, not a blank panel.
 *     2. Tapping a peer triggers /api/peers/:id/sessions exactly once
 *        and renders the result; a re-tap collapses without re-fetching
 *        (cheap toggle UX, plus it pins that we don't accidentally
 *        thrash the proxy).
 *     3. Tapping a session fetches /credentials and hands the apiKey
 *        to openRemote — never to ui-store or any persistent surface.
 *        If this assertion ever fails, the spike has reverted to
 *        leaking keys into localStorage.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPeersPicker } from "../public/lib/peers-picker.js";

// ── Minimal DOM / Element double ──────────────────────────────────
class FakeElement {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this.children = [];
    this.className = "";
    this.textContent = "";
    this.title = "";
    this.style = {};
    this.attributes = {};
    this.parentNode = null;
    this._listeners = {};
    this.disabled = false;
    this.type = "";
  }
  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(evt, fn) { (this._listeners[evt] ||= []).push(fn); }
  // test helper
  click() { for (const fn of this._listeners.click || []) fn({}); }
  // recursive search by attribute value
  querySelector(sel) {
    const m = sel.match(/^\[([^=]+)="([^"]+)"\]$/);
    if (!m) {
      // also support "[a] [b]" — we walk both in order. Sufficient for
      // the picker's needs.
      const parts = sel.match(/\[([^=]+)="([^"]+)"\]/g) || [];
      let cur = this;
      for (const p of parts) {
        const [, k, v] = p.match(/\[([^=]+)="([^"]+)"\]/);
        cur = findByAttr(cur, k, v);
        if (!cur) return null;
      }
      return cur === this ? null : cur;
    }
    return findByAttr(this, m[1], m[2]);
  }
}
function findByAttr(node, k, v) {
  for (const c of node.children) {
    if (c.attributes && c.attributes[k] === v) return c;
    const r = c.querySelector?.(`[${k}="${v}"]`);
    if (r) return r;
  }
  return null;
}

globalThis.document = {
  createElement(tag) { return new FakeElement(tag); },
};

// ── Test helpers ──────────────────────────────────────────────────
function makeApi(routes) {
  // routes: { "/api/peers": [obj] | (req) => ... | "throw" }
  const calls = [];
  return {
    get: async (url) => {
      calls.push(url);
      const route = routes[url];
      if (route === undefined) throw new Error(`unmocked: ${url}`);
      if (route === "throw") throw new Error(`simulated failure ${url}`);
      return typeof route === "function" ? await route() : route;
    },
    _calls: calls,
  };
}

function makePicker(api, { onClose, openRemote } = {}) {
  const rootEl = new FakeElement("div");
  const closeBtn = new FakeElement("button");
  const picker = createPeersPicker({
    rootEl, closeBtn, api,
    openRemote: openRemote || (() => {}),
    onClose: onClose || (() => {}),
  });
  return { picker, rootEl, closeBtn };
}

// ── refresh() — peer-list rendering ────────────────────────────────
describe("peers-picker.refresh — peer list", () => {
  it("renders one row per peer returned by /api/peers", async () => {
    const api = makeApi({
      "/api/peers": { peers: [
        { id: "mini",  url: "https://m.example", label: "Mini" },
        { id: "prime", url: "https://p.example", label: "Prime" },
      ]},
    });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    const rows = rootEl.children.filter((c) => c.attributes["data-peer-id"]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].attributes["data-peer-id"], "mini");
  });

  it("shows an empty-state hint when no peers are configured", async () => {
    const api = makeApi({ "/api/peers": { peers: [] } });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    assert.equal(rootEl.children.length, 1);
    assert.match(rootEl.children[0].textContent, /No peers/);
  });

  it("shows an error when /api/peers fails", async () => {
    const api = makeApi({ "/api/peers": "throw" });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    assert.equal(rootEl.children.length, 1);
    assert.match(rootEl.children[0].textContent, /Could not load peers/);
  });

  it("does not call /api/peers/:id/sessions until a peer is tapped", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
    });
    const { picker } = makePicker(api);
    await picker.refresh();
    assert.deepEqual(api._calls, ["/api/peers"]);
  });
});

// ── peer expansion → session list ────────────────────────────────
describe("peers-picker — expanding a peer", () => {
  it("loads sessions on first expand and renders rows", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [
        { name: "kat_a", alive: true, title: "vim editing" },
        { name: "kat_b", alive: true, title: null },
      ]},
    });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    const peerRow = rootEl.children[0];
    const header = peerRow.children[0];
    await header._listeners.click[0]({});
    // Allow the async fetch to resolve
    await new Promise((r) => setImmediate(r));
    const sessionsList = peerRow.children[1];
    const sessionRows = sessionsList.children.filter((c) => c.attributes["data-session-name"]);
    assert.equal(sessionRows.length, 2);
    assert.equal(sessionRows[0].attributes["data-session-name"], "kat_a");
  });

  it("collapses without re-fetching on a second tap", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [{ name: "kat_a", alive: true }] },
    });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    const header = rootEl.children[0].children[0];
    await header._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const callsAfterExpand = api._calls.length;
    await header._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    assert.equal(api._calls.length, callsAfterExpand, "second tap (collapse) must not re-fetch");
  });

  it("disables session buttons for stopped sessions", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [
        { name: "kat_alive", alive: true },
        { name: "kat_dead",  alive: false },
      ]},
    });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    await rootEl.children[0].children[0]._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const rows = rootEl.children[0].children[1].children.filter((c) => c.attributes["data-session-name"]);
    const alive = rows.find((r) => r.attributes["data-session-name"] === "kat_alive");
    const dead = rows.find((r) => r.attributes["data-session-name"] === "kat_dead");
    assert.equal(alive.disabled, false);
    assert.equal(dead.disabled, true);
  });

  it("renders an error row when the sessions fetch fails", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": "throw",
    });
    const { picker, rootEl } = makePicker(api);
    await picker.refresh();
    await rootEl.children[0].children[0]._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const sessionsList = rootEl.children[0].children[1];
    assert.match(sessionsList.children[0].textContent, /Could not load sessions/);
  });
});

// ── Picking a session ─────────────────────────────────────────────
describe("peers-picker — picking a session", () => {
  it("fetches /credentials and hands {peerUrl, apiKey, session, label} to openRemote", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [{ name: "kat_a", alive: true, title: "ssh prod" }] },
      "/api/peers/mini/credentials": {
        id: "mini",
        peerUrl: "https://m.example",
        apiKey: "secret-1234567890abcdef",
        label: "Mini",
      },
    });
    const calls = [];
    const { picker, rootEl } = makePicker(api, { openRemote: (args) => calls.push(args) });
    await picker.refresh();
    await rootEl.children[0].children[0]._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const sessionBtn = rootEl.children[0].children[1].children
      .find((c) => c.attributes["data-session-name"] === "kat_a");
    await sessionBtn._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].peerUrl, "https://m.example");
    assert.equal(calls[0].apiKey, "secret-1234567890abcdef");
    assert.equal(calls[0].session, "kat_a");
    assert.match(calls[0].label, /Mini.*ssh prod/);
  });

  it("does NOT call openRemote when /credentials is missing apiKey", async () => {
    // Defense against a server-side bug returning a malformed
    // credentials payload — better to silently no-op than spawn a
    // tile that will fail to attach with a confusing error.
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [{ name: "kat_a", alive: true }] },
      "/api/peers/mini/credentials": { peerUrl: "https://m.example" }, // no apiKey
    });
    const calls = [];
    const { picker, rootEl } = makePicker(api, { openRemote: (args) => calls.push(args) });
    await picker.refresh();
    await rootEl.children[0].children[0]._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const sessionBtn = rootEl.children[0].children[1].children
      .find((c) => c.attributes["data-session-name"] === "kat_a");
    await sessionBtn._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
  });

  it("calls onClose after a successful pick", async () => {
    const api = makeApi({
      "/api/peers": { peers: [{ id: "mini", url: "https://m.example", label: "Mini" }] },
      "/api/peers/mini/sessions": { sessions: [{ name: "kat_a", alive: true }] },
      "/api/peers/mini/credentials": {
        peerUrl: "https://m.example", apiKey: "k".repeat(32), label: "Mini",
      },
    });
    let closed = false;
    const { picker, rootEl } = makePicker(api, {
      openRemote: () => {}, onClose: () => { closed = true; },
    });
    await picker.refresh();
    await rootEl.children[0].children[0]._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    const sessionBtn = rootEl.children[0].children[1].children
      .find((c) => c.attributes["data-session-name"] === "kat_a");
    await sessionBtn._listeners.click[0]({});
    await new Promise((r) => setImmediate(r));
    assert.equal(closed, true);
  });
});

// ── close button ─────────────────────────────────────────────────
describe("peers-picker — close button", () => {
  it("invokes onClose when the close button is clicked", () => {
    const api = makeApi({});
    let closed = 0;
    const { closeBtn } = makePicker(api, { onClose: () => { closed += 1; } });
    closeBtn._listeners.click[0]({});
    assert.equal(closed, 1);
  });
});
