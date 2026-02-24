import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterTerminalResponses, registerResponseSuppressors } from "../public/lib/terminal-input-filter.js";

describe("filterTerminalResponses", () => {
  it("passes through normal keyboard input", () => {
    assert.equal(filterTerminalResponses("hello"), "hello");
    assert.equal(filterTerminalResponses("\r"), "\r");
    assert.equal(filterTerminalResponses("\x1b[A"), "\x1b[A"); // arrow up
  });

  it("filters focus-in sequence (CSI I)", () => {
    assert.equal(filterTerminalResponses("\x1b[I"), "");
    assert.equal(filterTerminalResponses("a\x1b[Ib"), "ab");
  });

  it("filters focus-out sequence (CSI O)", () => {
    assert.equal(filterTerminalResponses("\x1b[O"), "");
    assert.equal(filterTerminalResponses("a\x1b[Ob"), "ab");
  });

  it("filters cursor position report (CPR)", () => {
    assert.equal(filterTerminalResponses("\x1b[1;140R"), "");
    assert.equal(filterTerminalResponses("\x1b[56;36R"), "");
  });

  it("filters primary device attributes response", () => {
    assert.equal(filterTerminalResponses("\x1b[?1;2c"), "");
    assert.equal(filterTerminalResponses("\x1b[?62;1;2;6;7;8;9c"), "");
  });

  it("filters secondary device attributes response", () => {
    assert.equal(filterTerminalResponses("\x1b[>0;0;0c"), "");
  });

  it("filters multiple responses concatenated together", () => {
    const input = "\x1b[1;140R\x1b[?1;2c\x1b[I";
    assert.equal(filterTerminalResponses(input), "");
  });

  it("preserves user input mixed with terminal responses", () => {
    assert.equal(filterTerminalResponses("ls\x1b[I -la"), "ls -la");
    assert.equal(filterTerminalResponses("x\x1b[1;1Ry"), "xy");
  });

  it("handles empty string", () => {
    assert.equal(filterTerminalResponses(""), "");
  });
});

describe("registerResponseSuppressors", () => {
  it("registers OSC handlers for color query IDs 10, 11, 12", () => {
    const registered = [];
    const fakeTerm = {
      parser: {
        registerOscHandler: (id, handler) => {
          registered.push({ id, returns: handler("?") });
          return { dispose: () => {} };
        }
      }
    };

    const disposables = registerResponseSuppressors(fakeTerm);

    assert.equal(disposables.length, 3);
    assert.deepEqual(registered.map(r => r.id), [10, 11, 12]);
    // Each handler returns true to suppress the default response
    assert.ok(registered.every(r => r.returns === true));
  });

  it("returns disposable objects", () => {
    let disposed = 0;
    const fakeTerm = {
      parser: {
        registerOscHandler: () => ({ dispose: () => disposed++ })
      }
    };

    const disposables = registerResponseSuppressors(fakeTerm);
    disposables.forEach(d => d.dispose());

    assert.equal(disposed, 3);
  });
});
