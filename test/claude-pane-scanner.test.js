/**
 * claude-pane-scanner tests.
 *
 * Covers:
 *   - detectPermissionPrompt: pure regex classifier on captured pane text.
 *   - pollForPermissionPrompt: retry loop over a capture callback with
 *     an early-exit `shouldStop` signal (used by PostToolUse to abort
 *     a poll once the tool has actually run).
 *   - capturePane pane-id validation: we never shell out on an invalid
 *     pane id because that's an attacker-influenced field.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  detectPermissionPrompt,
  pollForPermissionPrompt,
  capturePane,
} from "../lib/claude-pane-scanner.js";

const BASH_PROMPT = `
  Bash command
    rm -f /tmp/katulong-nonexistent-file-xyz
    Remove a nonexistent temp file

  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and always allow access to tmp/ from this project
    3. No
`;

const EDIT_PROMPT = `
  Edit file
    /tmp/foo.txt

  Do you want to make this edit to foo.txt?
  > 1. Yes
    2. No
`;

const NO_PROMPT = `
  Some arbitrary pane content.
  > echo hello
  hello
`;

const MENU_WITHOUT_QUESTION = `
  Pick a number:
  1. Apples
  2. Oranges
`;

const QUESTION_WITHOUT_MENU = `
  Do you want to skip this?
  (just a sentence — no numbered options here)
`;

describe("detectPermissionPrompt", () => {
  it("matches the Bash permission menu", () => {
    const hit = detectPermissionPrompt(BASH_PROMPT);
    assert.equal(hit?.question, "Do you want to proceed?");
  });

  it("matches the Edit permission menu", () => {
    const hit = detectPermissionPrompt(EDIT_PROMPT);
    assert.match(hit?.question ?? "", /Do you want to make this edit/i);
  });

  it("returns null on ordinary pane content", () => {
    assert.equal(detectPermissionPrompt(NO_PROMPT), null);
  });

  it("requires both a question and a numbered option list", () => {
    // "1. Apples" alone (no "Do you want to ...?") is not a prompt.
    assert.equal(detectPermissionPrompt(MENU_WITHOUT_QUESTION), null);
    // A question without a numbered-option line is not a prompt either.
    assert.equal(detectPermissionPrompt(QUESTION_WITHOUT_MENU), null);
  });

  it("is null-safe for bad inputs", () => {
    assert.equal(detectPermissionPrompt(null), null);
    assert.equal(detectPermissionPrompt(undefined), null);
    assert.equal(detectPermissionPrompt(42), null);
  });
});

describe("pollForPermissionPrompt", () => {
  /**
   * Driver that lets a test script a sequence of capture responses
   * (one per poll attempt) and asserts the resulting behavior.
   */
  function scripted(responses) {
    let idx = 0;
    return async () => {
      const out = responses[idx] ?? null;
      idx += 1;
      return out;
    };
  }

  const noSleep = () => Promise.resolve();

  it("stops at the first attempt that captures a prompt", async () => {
    const capture = scripted([NO_PROMPT, NO_PROMPT, BASH_PROMPT, BASH_PROMPT]);
    const hit = await pollForPermissionPrompt("%1", {
      delaysMs: [1, 1, 1, 1, 1, 1],
      capture, sleep: noSleep,
    });
    assert.ok(hit, "expected a hit once the prompt appeared");
    assert.match(hit.question, /proceed\?/);
  });

  it("returns null if the prompt never appears within the window", async () => {
    const capture = scripted([NO_PROMPT, NO_PROMPT, NO_PROMPT]);
    const hit = await pollForPermissionPrompt("%1", {
      delaysMs: [1, 1, 1],
      capture, sleep: noSleep,
    });
    assert.equal(hit, null);
  });

  it("exits early when shouldStop flips to true", async () => {
    let captures = 0;
    const capture = async () => { captures += 1; return NO_PROMPT; };
    let stop = false;
    const stopAfterTwo = () => { const out = stop; stop = captures >= 2; return out; };
    const hit = await pollForPermissionPrompt("%1", {
      delaysMs: [1, 1, 1, 1, 1, 1],
      capture, sleep: noSleep, shouldStop: stopAfterTwo,
    });
    assert.equal(hit, null);
    // One capture past the flip is acceptable; what we care about is
    // that we stop *well before* exhausting the delays.
    assert.ok(captures < 6, `should have stopped early, ran ${captures}`);
  });

  it("tolerates a capture that resolves null (tmux unreachable)", async () => {
    const capture = scripted([null, null, BASH_PROMPT]);
    const hit = await pollForPermissionPrompt("%1", {
      delaysMs: [1, 1, 1],
      capture, sleep: noSleep,
    });
    assert.ok(hit);
  });
});

describe("capturePane", () => {
  it("short-circuits on a malformed pane id (never shells out)", async () => {
    let called = false;
    const exec = async () => { called = true; return { code: 0, stdout: "x" }; };
    const out = await capturePane("not-a-pane", { exec });
    assert.equal(out, null);
    assert.equal(called, false);
  });

  it("short-circuits on non-string pane", async () => {
    let called = false;
    const exec = async () => { called = true; return { code: 0, stdout: "x" }; };
    assert.equal(await capturePane(null, { exec }), null);
    assert.equal(await capturePane(42, { exec }), null);
    assert.equal(called, false);
  });

  it("returns stdout on a successful capture", async () => {
    const exec = async () => ({ code: 0, stdout: BASH_PROMPT });
    const out = await capturePane("%7", { exec });
    assert.equal(out, BASH_PROMPT);
  });

  it("returns null on non-zero exit", async () => {
    const exec = async () => ({ code: 1, stdout: "", stderr: "nope" });
    const out = await capturePane("%7", { exec });
    assert.equal(out, null);
  });
});
