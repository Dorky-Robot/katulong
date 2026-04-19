import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replayPasteSequence } from "../lib/paste-sequence.js";

function makeSession() {
  const writes = [];
  return {
    alive: true,
    write(bytes) { writes.push(bytes); },
    writes,
  };
}

function makeDeps(overrides = {}) {
  const calls = { setClipboard: [], bridgeClipboard: [], bridgePane: [], sleeps: [], imagePasted: [] };
  return {
    calls,
    setClipboard: overrides.setClipboard || (async (p, e) => { calls.setClipboard.push({ p, e }); return true; }),
    bridgeClipboardToContainers: overrides.bridgeClipboardToContainers
      || (async (f, m) => { calls.bridgeClipboard.push({ f, m }); return false; }),
    bridgePaneContainer: overrides.bridgePaneContainer
      || (async (n, sm, p, m) => { calls.bridgePane.push({ n, p, m }); return false; }),
    imageMimeType: overrides.imageMimeType || ((e) => `image/${e}`),
    logger: { warn: () => {}, info: () => {} },
    sleep: (ms) => { calls.sleeps.push(ms); return Promise.resolve(); },
    onImagePasted: (p) => { calls.imagePasted.push(p); },
  };
}

let uploadsDir;
const imgA = "/uploads/a.png";
const imgB = "/uploads/b.png";

before(() => {
  uploadsDir = mkdtempSync(join(tmpdir(), "paste-seq-"));
  writeFileSync(join(uploadsDir, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(uploadsDir, "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

after(() => {
  rmSync(uploadsDir, { recursive: true, force: true });
});

describe("replayPasteSequence", () => {
  it("returns early on empty/missing tokens", async () => {
    const out = await replayPasteSequence({ tokens: [], uploadsDir, ...makeDeps() });
    assert.deepEqual(out, { pasted: 0, aborted: false });
  });

  it("writes text tokens verbatim to the session", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [
        { type: "text", value: "hello " },
        { type: "text", value: "world\nline two" },
      ],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, ["hello ", "world\nline two"]);
  });

  it("for images: sets clipboard, bridges, writes \\x16, sleeps", async () => {
    const session = makeSession();
    const deps = makeDeps();
    const out = await replayPasteSequence({
      tokens: [{ type: "image", path: imgA }],
      session, uploadsDir, ...deps,
    });
    assert.equal(out.pasted, 1);
    assert.equal(deps.calls.setClipboard.length, 1);
    assert.equal(deps.calls.bridgeClipboard.length, 1);
    assert.deepEqual(session.writes, ["\x16"]);
    assert.deepEqual(deps.calls.sleeps, [50]);
    assert.deepEqual(deps.calls.imagePasted, [imgA]);
  });

  it("interleaves text and image in order", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [
        { type: "text", value: "before " },
        { type: "image", path: imgA },
        { type: "text", value: " middle " },
        { type: "image", path: imgB },
        { type: "text", value: " after" },
      ],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, [
      "before ",
      "\x16",
      " middle ",
      "\x16",
      " after",
    ]);
  });

  it("appends real Enter (\\r) when submit: true", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [{ type: "text", value: "hi" }],
      session, uploadsDir, submit: true, ...deps,
    });
    assert.deepEqual(session.writes, ["hi", "\r"]);
  });

  it("does NOT write \\x16 when both clipboard-set and bridges fail", async () => {
    const session = makeSession();
    const deps = makeDeps({
      setClipboard: async () => false,
      bridgeClipboardToContainers: async () => false,
      bridgePaneContainer: async () => false,
    });
    const out = await replayPasteSequence({
      tokens: [{ type: "image", path: imgA }],
      session, uploadsDir, ...deps,
    });
    assert.equal(out.pasted, 0);
    assert.deepEqual(session.writes, []);
    // Still reports progress so the client isn't stuck waiting.
    assert.deepEqual(deps.calls.imagePasted, [imgA]);
  });

  it("uses \\x16 if clipboard failed but a container bridge succeeded", async () => {
    const session = makeSession();
    const deps = makeDeps({
      setClipboard: async () => false,
      bridgeClipboardToContainers: async () => true,
    });
    await replayPasteSequence({
      tokens: [{ type: "image", path: imgA }],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, ["\x16"]);
  });

  it("tries pane-container bridge only when global bridge fails", async () => {
    const session = makeSession();
    const deps = makeDeps({ bridgeClipboardToContainers: async () => true });
    await replayPasteSequence({
      tokens: [{ type: "image", path: imgA }],
      session, sessionName: "work", sessionManager: {}, uploadsDir, ...deps,
    });
    assert.equal(deps.calls.bridgePane.length, 0);
  });

  it("calls pane-container bridge when global bridge failed", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [{ type: "image", path: imgA }],
      session, sessionName: "work", sessionManager: {}, uploadsDir, ...deps,
    });
    assert.equal(deps.calls.bridgePane.length, 1);
    assert.equal(deps.calls.bridgePane[0].n, "work");
  });

  it("aborts mid-sequence when the session dies", async () => {
    const session = makeSession();
    const deps = makeDeps();
    // After the first text chunk, kill the session.
    const origWrite = session.write.bind(session);
    session.write = (bytes) => {
      origWrite(bytes);
      if (bytes === "kill") session.alive = false;
    };
    const out = await replayPasteSequence({
      tokens: [
        { type: "text", value: "kill" },
        { type: "text", value: "unreachable" },
        { type: "image", path: imgA },
      ],
      session, uploadsDir, ...deps,
    });
    assert.equal(out.aborted, true);
    assert.deepEqual(session.writes, ["kill"]);
    assert.equal(deps.calls.setClipboard.length, 0);
  });

  it("ignores image tokens with paths outside uploadsDir", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [{ type: "image", path: "/uploads/../../../etc/passwd" }],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, []);
    assert.equal(deps.calls.setClipboard.length, 0);
  });

  it("ignores image tokens whose file is missing", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [{ type: "image", path: "/uploads/ghost.png" }],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, []);
    assert.equal(deps.calls.setClipboard.length, 0);
  });

  it("ignores unknown token shapes without throwing", async () => {
    const session = makeSession();
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [
        null,
        { type: "audio", path: "/foo" },
        { type: "text" },                 // missing value
        { type: "image" },                // missing path
        { type: "text", value: "ok" },
      ],
      session, uploadsDir, ...deps,
    });
    assert.deepEqual(session.writes, ["ok"]);
  });

  it("without a session: still sets clipboard for image tokens, skips text + submit", async () => {
    const deps = makeDeps();
    await replayPasteSequence({
      tokens: [
        { type: "text", value: "dropped" },
        { type: "image", path: imgA },
      ],
      uploadsDir, submit: true, ...deps,
    });
    assert.equal(deps.calls.setClipboard.length, 1);
    assert.deepEqual(deps.calls.imagePasted, [imgA]);
  });
});
