import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCommandTree, matchChild, isLeaf } from "../public/lib/command-tree.js";

/**
 * Command tree spec — pins the chord menu shape so future edits to
 * command-tree.js can't silently drop a binding.
 *
 * The chord menu is the home for verbs that do NOT have a clean Cmd+
 * binding in PWA mode (close, kill, rename, clear, search) plus the
 * `n`ew tile branch. Verbs that ARE on Cmd+ keys (jump-to-tab, navigate,
 * move) intentionally do NOT appear here — adding them would split-brain
 * muscle memory.
 */

function noopActions() {
  const calls = [];
  const stub = (name) => (...args) => calls.push([name, ...args]);
  return {
    actions: {
      closeCurrentTile: stub("closeCurrentTile"),
      renameCurrentTile: stub("renameCurrentTile"),
      killCurrentTile: stub("killCurrentTile"),
      clearCurrentTerminal: stub("clearCurrentTerminal"),
      searchCurrentTerminal: stub("searchCurrentTerminal"),
      createTile: stub("createTile"),
      showHelp: stub("showHelp"),
    },
    calls,
  };
}

describe("buildCommandTree — shape", () => {
  it("root has t, n, h branches in that order", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    assert.equal(tree.label, "root");
    const keys = tree.children.map((c) => c.key);
    assert.deepEqual(keys, ["t", "n", "h"]);
  });

  it("omits help branch when showHelp is not provided", () => {
    const { actions } = noopActions();
    const { showHelp: _drop, ...rest } = actions;
    const tree = buildCommandTree(rest);
    const keys = tree.children.map((c) => c.key);
    assert.deepEqual(keys, ["t", "n"]);
  });
});

describe("buildCommandTree — t (tile) branch", () => {
  it("contains x close, r rename, k kill, c clear, / search", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    const tBranch = matchChild(tree, "t");
    const keys = tBranch.children.map((c) => c.key);
    assert.deepEqual(keys, ["x", "r", "k", "c", "/"]);
  });

  const dispatchCases = [
    ["x", "closeCurrentTile"],
    ["r", "renameCurrentTile"],
    ["k", "killCurrentTile"],
    ["c", "clearCurrentTerminal"],
    ["/", "searchCurrentTerminal"],
  ];
  for (const [chordKey, expectedAction] of dispatchCases) {
    it(`t ${chordKey} dispatches ${expectedAction}`, () => {
      const { actions, calls } = noopActions();
      const tree = buildCommandTree(actions);
      const leaf = matchChild(matchChild(tree, "t"), chordKey);
      assert.equal(isLeaf(leaf), true);
      leaf.action();
      assert.deepEqual(calls, [[expectedAction]]);
    });
  }
});

describe("buildCommandTree — n (new) branch", () => {
  it("contains t terminal, f files, b browser, d feed, s sipag", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    const nBranch = matchChild(tree, "n");
    const keys = nBranch.children.map((c) => c.key);
    assert.deepEqual(keys, ["t", "f", "b", "d", "s"]);
  });

  const newCases = [
    ["t", "terminal"],
    ["f", "file-browser"],
    ["b", "localhost-browser"],
    ["d", "feed"],
    ["s", "sipag"],
  ];
  for (const [chordKey, tileType] of newCases) {
    it(`n ${chordKey} creates ${tileType}`, () => {
      const { actions, calls } = noopActions();
      const tree = buildCommandTree(actions);
      const leaf = matchChild(matchChild(tree, "n"), chordKey);
      assert.equal(isLeaf(leaf), true);
      leaf.action();
      assert.deepEqual(calls, [["createTile", tileType]]);
    });
  }
});

describe("buildCommandTree — discoverability invariants", () => {
  // Hint strings appear in the breadcrumb / surface UI — keep them
  // present so users always see what's available at the current depth.
  it("t branch has a hint string", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    const tBranch = matchChild(tree, "t");
    assert.ok(tBranch.hint && tBranch.hint.length > 0);
  });

  it("n branch has a hint string", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    const nBranch = matchChild(tree, "n");
    assert.ok(nBranch.hint && nBranch.hint.length > 0);
  });

  // Every leaf must have a label so the surface can render a pill.
  it("every leaf has a label", () => {
    const { actions } = noopActions();
    const tree = buildCommandTree(actions);
    function walk(node) {
      if (isLeaf(node)) {
        assert.ok(node.label && node.label.length > 0,
          `leaf ${node.key} missing a label`);
        return;
      }
      for (const child of node.children || []) walk(child);
    }
    walk(tree);
  });
});
