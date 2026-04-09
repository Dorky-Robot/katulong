/**
 * Regression test for file-browser tile dismissal (#542).
 *
 * PR #542 (545b110) added the file-browser as a first-class tile. The tile
 * factory stores whatever sessionName it's passed and exposes it via
 * `get sessionName()`. When app.js opens a file-browser, it passes the
 * currently focused terminal's session name — so the file-browser tile
 * aliases a real tmux session it does not own.
 *
 * Bug: onCardDismissed fell through to the generic dismiss path that calls
 * wsConnection.sendUnsubscribe(sessionName) and windowTabSet.removeTab().
 * This unsubscribed the real terminal session and removed its tab, leaving
 * the tmux pane running but unreachable from the client.
 *
 * Fix: early return for file-browser tiles in onCardDismissed. The file
 * browser is a *view* over a session, not the owner — no sendUnsubscribe,
 * no removeTab.
 *
 * Mirrors the pattern from 7fa1e22 (PR #538) which fixed the analogous
 * bug for cluster tiles — see test/cluster-composite.test.js.
 *
 * Test harness pattern: mirrors the real onCardDismissed logic from app.js
 * (same approach as websocket-subscribe.test.js). The callback is an inline
 * closure in app.js and can't be imported directly.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("file-browser tile dismissal (regression: #542)", () => {
  let wsConnection;
  let windowTabSet;
  let tiles;
  let onCardDismissed;

  beforeEach(() => {
    wsConnection = { sendUnsubscribe: mock.fn() };
    windowTabSet = { removeTab: mock.fn() };
    tiles = new Map();

    // Mirrors app.js onCardDismissed (public/app.js ~line 505).
    // Keep in sync — if the real callback changes shape, update here.
    onCardDismissed = (tileId) => {
      const tile = tiles.get(tileId);
      if (tile?.type === "cluster") {
        for (const { tile: subTile } of tile.getSubTiles()) {
          const subName = subTile?.sessionName;
          if (!subName) continue;
          if (windowTabSet) windowTabSet.removeTab(subName);
          wsConnection.sendUnsubscribe(subName);
        }
        return;
      }
      // The fix under test: file-browser tiles must not unsubscribe.
      if (tile?.type === "file-browser") return;

      const sessionName = tile?.sessionName || tileId;
      if (windowTabSet) windowTabSet.removeTab(sessionName);
      wsConnection.sendUnsubscribe(sessionName);
    };
  });

  it("does not unsubscribe the aliased terminal session", () => {
    // Terminal tile owns "session-xyz"
    tiles.set("term-1", { type: "terminal", sessionName: "session-xyz" });
    // File-browser tile aliases "session-xyz" (opened from term-1)
    tiles.set("fb-1", { type: "file-browser", sessionName: "session-xyz" });

    onCardDismissed("fb-1");

    assert.equal(
      wsConnection.sendUnsubscribe.mock.callCount(),
      0,
      "sendUnsubscribe must NOT be called when dismissing a file-browser tile"
    );
  });

  it("does not remove the terminal tab from windowTabSet", () => {
    tiles.set("term-1", { type: "terminal", sessionName: "session-xyz" });
    tiles.set("fb-1", { type: "file-browser", sessionName: "session-xyz" });

    onCardDismissed("fb-1");

    assert.equal(
      windowTabSet.removeTab.mock.callCount(),
      0,
      "removeTab must NOT be called when dismissing a file-browser tile"
    );
  });

  it("still unsubscribes when a real terminal tile is dismissed (positive control)", () => {
    tiles.set("term-1", { type: "terminal", sessionName: "session-xyz" });
    tiles.set("fb-1", { type: "file-browser", sessionName: "session-xyz" });

    onCardDismissed("term-1");

    assert.equal(
      wsConnection.sendUnsubscribe.mock.callCount(),
      1,
      "sendUnsubscribe MUST be called when dismissing a terminal tile"
    );
    assert.deepEqual(
      wsConnection.sendUnsubscribe.mock.calls[0].arguments,
      ["session-xyz"]
    );
    assert.equal(
      windowTabSet.removeTab.mock.callCount(),
      1,
      "removeTab MUST be called when dismissing a terminal tile"
    );
  });

  it("falls back to tileId when tile has no sessionName", () => {
    tiles.set("orphan-tile", { type: "terminal" });

    onCardDismissed("orphan-tile");

    assert.deepEqual(
      wsConnection.sendUnsubscribe.mock.calls[0].arguments,
      ["orphan-tile"],
      "must fall back to tileId when sessionName is undefined"
    );
  });
});
