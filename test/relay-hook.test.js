import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stampTmuxPane } from "../lib/cli/commands/relay-hook.js";

describe("stampTmuxPane", () => {
  it("adds _tmuxPane to a valid JSON object payload", () => {
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "abc" });
    const out = stampTmuxPane(input, "%3");
    const parsed = JSON.parse(out);
    assert.equal(parsed._tmuxPane, "%3");
    assert.equal(parsed.hook_event_name, "SessionStart");
  });

  it("returns the payload unchanged when TMUX_PANE is absent", () => {
    // Pass `null` explicitly: `undefined` triggers the default-parameter
    // fallback to `process.env.TMUX_PANE`, which is set when the test
    // suite runs inside tmux.
    const input = JSON.stringify({ hook_event_name: "SessionStart" });
    assert.equal(stampTmuxPane(input, null), input);
    assert.equal(stampTmuxPane(input, ""), input);
  });

  it("returns the payload unchanged when TMUX_PANE is malformed", () => {
    const input = JSON.stringify({ hook_event_name: "SessionStart" });
    assert.equal(stampTmuxPane(input, "3"), input);
    assert.equal(stampTmuxPane(input, "%"), input);
    assert.equal(stampTmuxPane(input, "pane-abc"), input);
  });

  it("returns the payload unchanged when input is not valid JSON", () => {
    const input = "not valid json";
    assert.equal(stampTmuxPane(input, "%3"), input);
  });

  it("returns the payload unchanged when input is a JSON array", () => {
    const input = JSON.stringify([1, 2, 3]);
    assert.equal(stampTmuxPane(input, "%3"), input);
  });

  it("overwrites an existing _tmuxPane field (server re-validates anyway)", () => {
    // A client that tries to spoof _tmuxPane is not a concern — the server's
    // pane index is authoritative. But stamping should still overwrite so
    // the observed behavior is "pane from env wins".
    const input = JSON.stringify({ _tmuxPane: "%99", hook_event_name: "SessionStart" });
    const out = stampTmuxPane(input, "%3");
    assert.equal(JSON.parse(out)._tmuxPane, "%3");
  });
});
