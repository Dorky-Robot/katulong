/**
 * Command tree — pure data describing the vim-style chord menu.
 *
 * Shape: a tree of nodes. Each node is either a **branch** (opens a
 * submenu via `children`) or a **leaf** (invokes `action`). The
 * dispatcher walks the tree one keystroke at a time. When a key hits
 * a leaf, its action callback fires and the tree resets to root.
 *
 *   { key, label, hint?, children }    // branch
 *   { key, label, hint?, action }      // leaf
 *
 * The tree is intentionally pure — no DOM, no store, no app imports.
 * Actions arrive as an injected registry (see buildTree below), so
 * the tree stays testable in isolation and the app can swap action
 * implementations (e.g. different behavior per cluster) without
 * rewriting the data.
 */

/**
 * Build the default chord tree with the host's action registry wired in.
 *
 * @param {object} actions
 * @param {function} actions.closeCurrentTile      — () => void
 * @param {function} actions.renameCurrentTile     — () => void
 * @param {function} actions.killCurrentTile       — () => void
 * @param {function} actions.clearCurrentTerminal  — () => void
 * @param {function} actions.searchCurrentTerminal — () => void
 * @param {function} actions.createTile            — (type: string) => void
 * @param {function} [actions.showHelp]            — () => void
 *
 * The fuzzy picker (fzf over tiles + sessions) is NOT in this tree —
 * it's bound to the global Cmd+/ shortcut in app-keyboard.js since the
 * picker is a top-level navigation aid, not a chord destination. The
 * two surfaces stay distinct: chord menu = verbs on focused tile + new,
 * picker = jump to an existing tile or session.
 *
 * Verbs that already have clean Cmd+ bindings in PWA mode (jump-to-tab,
 * navigate, move) intentionally do NOT appear here — adding them would
 * split-brain muscle memory. Only verbs without a Cmd+ key live here
 * (close / kill / clear / search / rename) plus the `n`ew tile branch.
 */
export function buildCommandTree(actions) {
  return {
    key: null,
    label: "root",
    children: [
      {
        key: "t",
        label: "tile",
        hint: "detach, rename, kill, clear, search",
        children: [
          // detach: removes the tile from the UI but leaves the tmux session
          // alive on the server. Other devices stay attached; this device can
          // re-attach later. Non-terminal tiles (browser/feed/sipag) just
          // unmount — there's no underlying session to outlive them.
          { key: "x", label: "detach", action: () => actions.closeCurrentTile() },
          { key: "r", label: "rename", action: () => actions.renameCurrentTile() },
          // kill: removes the tile AND DELETEs the tmux session on the server.
          // The session is gone; reattaching from any device fails.
          { key: "k", label: "kill",   action: () => actions.killCurrentTile() },
          { key: "c", label: "clear",  action: () => actions.clearCurrentTerminal() },
          { key: "/", label: "search", action: () => actions.searchCurrentTerminal() },
        ],
      },
      {
        key: "n",
        label: "new",
        hint: "terminal, files, browser…",
        children: [
          { key: "t", label: "terminal",    action: () => actions.createTile("terminal") },
          { key: "f", label: "files",       action: () => actions.createTile("file-browser") },
          { key: "b", label: "browser",     action: () => actions.createTile("localhost-browser") },
          { key: "d", label: "feed",        action: () => actions.createTile("feed") },
          { key: "s", label: "sipag",       action: () => actions.createTile("sipag") },
        ],
      },
      ...(actions.showHelp
        ? [{ key: "h", label: "help", action: () => actions.showHelp() }]
        : []),
    ],
  };
}

/**
 * Resolve a keydown against a node's children.
 *
 * Returns the matched child, or null if no match.
 */
export function matchChild(node, keyStr) {
  if (!node?.children) return null;
  for (const child of node.children) {
    if (child.key && child.key === keyStr) return child;
  }
  return null;
}

export function isLeaf(node) {
  return !!node && typeof node.action === "function";
}
