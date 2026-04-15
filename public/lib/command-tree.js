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
 * @param {function} actions.createTile            — (type: string) => void
 * @param {function} [actions.showHelp]            — () => void
 *
 * The fuzzy picker (fzf over tiles + sessions) is NOT in this tree —
 * it's bound to the global Cmd+/ shortcut in app-keyboard.js since the
 * picker is a top-level navigation aid, not a chord destination.
 */
export function buildCommandTree(actions) {
  return {
    key: null,
    label: "root",
    children: [
      {
        key: "t",
        label: "tile",
        hint: "close, rename",
        children: [
          { key: "x", label: "close",  action: () => actions.closeCurrentTile() },
          { key: "r", label: "rename", action: () => actions.renameCurrentTile() },
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
