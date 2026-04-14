/**
 * Tests for document-watcher — the SSE wrapper used by document-tile to
 * auto-sync with on-disk file changes.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { createDocumentWatcher } from "../public/lib/document-watcher.js";

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  emit() { this.onmessage?.({ data: "{}" }); }
}

describe("createDocumentWatcher", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
  });

  it("no-ops when filePath is empty", () => {
    const w = createDocumentWatcher({
      filePath: "",
      onChange: () => { throw new Error("should not fire"); },
      EventSourceImpl: FakeEventSource,
    });
    w.stop(); // must be safe
    assert.equal(FakeEventSource.instances.length, 0);
  });

  it("no-ops when EventSource is unavailable", () => {
    const w = createDocumentWatcher({
      filePath: "/tmp/x.md",
      onChange: () => {},
      EventSourceImpl: null,
    });
    w.stop();
  });

  it("opens SSE to /api/files/watch with the encoded path", () => {
    createDocumentWatcher({
      filePath: "/tmp/foo bar.md",
      onChange: () => {},
      EventSourceImpl: FakeEventSource,
    });
    assert.equal(FakeEventSource.instances.length, 1);
    assert.equal(
      FakeEventSource.instances[0].url,
      "/api/files/watch?paths=%2Ftmp%2Ffoo%20bar.md",
    );
  });

  it("invokes onChange on each SSE message", () => {
    let count = 0;
    createDocumentWatcher({
      filePath: "/tmp/x.md",
      onChange: () => { count++; },
      EventSourceImpl: FakeEventSource,
    });
    const es = FakeEventSource.instances[0];
    es.emit();
    es.emit();
    es.emit();
    assert.equal(count, 3);
  });

  it("swallows errors thrown inside onChange so one bad subscriber can't kill the connection", () => {
    createDocumentWatcher({
      filePath: "/tmp/x.md",
      onChange: () => { throw new Error("boom"); },
      EventSourceImpl: FakeEventSource,
    });
    const es = FakeEventSource.instances[0];
    assert.doesNotThrow(() => es.emit());
    assert.equal(es.closed, false);
  });

  it("stop() closes the EventSource", () => {
    const w = createDocumentWatcher({
      filePath: "/tmp/x.md",
      onChange: () => {},
      EventSourceImpl: FakeEventSource,
    });
    const es = FakeEventSource.instances[0];
    assert.equal(es.closed, false);
    w.stop();
    assert.equal(es.closed, true);
  });

  it("stop() is idempotent", () => {
    const w = createDocumentWatcher({
      filePath: "/tmp/x.md",
      onChange: () => {},
      EventSourceImpl: FakeEventSource,
    });
    w.stop();
    assert.doesNotThrow(() => w.stop());
  });
});
