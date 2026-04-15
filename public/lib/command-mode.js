/**
 * Command mode — vim-style modal layer for chord-driven navigation.
 *
 * Holds two pieces of state:
 *   1. active           — boolean: is the mode on at all?
 *   2. node             — current node in the chord tree when active;
 *                         null otherwise. Starts at the tree root on
 *                         entry and walks deeper as keys are consumed.
 *
 * Hotkey contract:
 *
 *   Cmd+. / Ctrl+.  toggle command mode
 *   Esc             exit command mode (from any depth)
 *   Backspace       step back one level (no-op at root)
 *   any other key   forwarded to the tree walker when active;
 *                   leaves invoke their action and reset to root
 *
 * The listener attaches at `window` capture so it sees keys before
 * xterm (which mounts its own keydown handler inside the terminal
 * element). When active, *every* keystroke is preventDefault'd — this
 * is the whole point of modal mode, xterm must not receive them.
 *
 * Visual presentation lives elsewhere — this module never touches DOM
 * beyond setting `documentElement.dataset.commandMode` so CSS can
 * react. Subscribers receive `{ active, node }` and render accordingly.
 */

import { matchChild, isLeaf } from "./command-tree.js";

const ATTR = "commandMode";

export function createCommandMode({ tree = null } = {}) {
  let active = false;
  let node = null;  // current tree node when active
  const subs = new Set();

  function notify() {
    for (const fn of subs) {
      try { fn({ active, node }); }
      catch (e) { console.error("command-mode subscriber threw", e); }
    }
  }

  function setActive(next) {
    if (active === next) return;
    active = next;
    node = active ? tree : null;
    document.documentElement.dataset[ATTR] = active ? "true" : "false";
    notify();
  }

  function resetToRoot() {
    if (!active) return;
    if (node === tree) return;
    node = tree;
    notify();
  }

  function isToggleChord(e) {
    if (e.key !== ".") return false;
    // Mac uses Cmd; everywhere else Ctrl. We accept either so the
    // shortcut works regardless of how the OS reports the modifier
    // (e.g. external keyboards on iPad, Windows over TeamViewer, etc).
    return e.metaKey || e.ctrlKey;
  }

  function handleChordKey(e) {
    if (!tree) return;  // no tree wired — toggle-only mode
    if (e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      resetToRoot();
      return;
    }
    // Ignore bare modifier presses. A user holding Shift to type ?
    // still arrives here with e.key === "?", which is matched
    // literally by the tree.
    if (e.key === "Meta" || e.key === "Control" || e.key === "Shift" || e.key === "Alt") return;

    const child = matchChild(node, e.key);
    if (!child) return;
    e.preventDefault();
    e.stopPropagation();
    if (isLeaf(child)) {
      try { child.action(); }
      catch (err) { console.error("command-mode action threw", err); }
      setActive(false);  // leaf → exit mode
    } else {
      node = child;
      notify();
    }
  }

  function onKeydown(e) {
    if (isToggleChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      setActive(!active);
      return;
    }
    if (!active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setActive(false);
      return;
    }
    handleChordKey(e);
  }

  // Initial attribute write so CSS selectors that key on
  // [data-command-mode="false"] match before the first keypress.
  document.documentElement.dataset[ATTR] = "false";
  window.addEventListener("keydown", onKeydown, true);

  return {
    isActive: () => active,
    getNode:  () => node,
    enter: () => setActive(true),
    exit:  () => setActive(false),
    toggle: () => setActive(!active),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    destroy() {
      window.removeEventListener("keydown", onKeydown, true);
      subs.clear();
      delete document.documentElement.dataset[ATTR];
    },
  };
}
