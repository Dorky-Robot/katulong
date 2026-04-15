/**
 * App-level Keyboard Decisions
 *
 * Pure decision function for global keyboard shortcuts (tab management,
 * help overlay, jump-to-tab). Wired by app.js's document keydown listener.
 *
 * The full keyboard spec is pinned by test/keyboard-spec.test.js — keep
 * that file and the kb-help overlay in index.html in sync with any change
 * made here.
 */

/**
 * Decide what action a global keydown event should trigger.
 *
 * @param {KeyboardEvent} ev — DOM-shaped event with key/code/type/modifier flags
 * @param {object}        ctx — { isTextInput?: boolean }
 * @returns {{ action: string|null, args: any, preventDefault: boolean }}
 *   action          — symbolic name (newSession, jumpToTab, …) or null
 *   args            — argument for the action (tab index, direction)
 *   preventDefault  — whether the caller should ev.preventDefault()
 *
 * Rules:
 *  - Option shortcuts are suppressed when ctx.isTextInput is true so they
 *    don't hijack typing inside rename inputs, settings panels, or the
 *    inline textbox. Without this guard, Option+R re-enters rename while
 *    the rename input is already focused.
 */
// Returned as a fresh object every call so callers can never accidentally
// mutate a shared instance. Distinct from terminal-key-decider's `pass`
// helper (different fields, different shape).
const NO_ACTION = () => ({ action: null, args: null, preventDefault: false });

export function decideAppKey(ev, ctx = {}) {
  // ── Cmd shortcuts ────────────────────────────────────────────────────
  // Cmd+/ — fuzzy picker over tiles/sessions. Global; fires from any
  // focus (including text inputs), matching the vibe of Spotlight-style
  // launchers.
  if (ev.metaKey && ev.key === "/" && !ev.shiftKey) {
    return { action: "openPicker", args: null, preventDefault: true };
  }

  // ── Option (Alt) shortcuts ───────────────────────────────────────────
  // Must be Option alone, not Cmd+Option or Ctrl+Option.
  if (!ev.altKey || ev.metaKey || ev.ctrlKey) return NO_ACTION();

  // Navigation shortcuts (moveTab, navigateTab, jumpToTab) work even
  // inside text inputs — they're structural tile management, not text
  // editing. This ensures they work from any tile type (browser tile
  // port input, document tile editor, etc.) without each tile needing
  // to forward them.

  // Shift variants — must check before non-shift so Option+Shift+W doesn't
  // get caught by the Option+W branch.
  if (ev.shiftKey) {
    if (ev.code === "BracketLeft") return { action: "moveTab", args: -1, preventDefault: true };
    if (ev.code === "BracketRight") return { action: "moveTab", args: 1, preventDefault: true };
    // killSession suppressed inside text inputs (Shift+W could be typing)
    if (!ctx.isTextInput && ev.code === "KeyW") return { action: "killSession", args: null, preventDefault: true };
    return NO_ACTION();
  }

  // Option+Digit → positional tab jump. 1..9 = tabs 1..9, 0 = tab 10.
  // Use ev.code (layout-independent) so the shortcut works across non-US
  // keyboard layouts where ev.key may be a Unicode char on macOS.
  if (/^Digit[0-9]$/.test(ev.code || "")) {
    const d = Number(ev.code.slice(5));
    return { action: "jumpToTab", args: d === 0 ? 10 : d, preventDefault: true };
  }

  // Navigation (Option+[ / ]) works in text inputs; the rest is suppressed.
  if (ev.code === "BracketLeft") return { action: "navigateTab", args: -1, preventDefault: true };
  if (ev.code === "BracketRight") return { action: "navigateTab", args: 1, preventDefault: true };

  // Remaining session-management shortcuts are suppressed inside text inputs
  // so they don't hijack typing in rename inputs, settings panels, etc.
  if (ctx.isTextInput) return NO_ACTION();

  switch (ev.code) {
    case "KeyT": return { action: "newSession", args: null, preventDefault: true };
    case "KeyW": return { action: "closeSession", args: null, preventDefault: true };
    case "KeyQ": return { action: "killSession", args: null, preventDefault: true };
    // Tradeoff: this takes over readline's `revert-line` (\er). The app
    // owns the whole Option key space for tab management (see 2a13634),
    // and tab rename is a far more common need for katulong users than
    // revert-line. Users who rely on revert-line can still invoke it via
    // `Ctrl+_` or the readline bind `Ctrl+X u`.
    case "KeyR": return { action: "renameSession", args: null, preventDefault: true };
  }

  return NO_ACTION();
}

/**
 * Helper for the wiring layer to detect text-input focus.
 * Pulled out so app.js doesn't have to duplicate the logic.
 *
 * Important: xterm.js captures keystrokes via a hidden
 * `<textarea class="xterm-helper-textarea">`. When the terminal has focus,
 * document.activeElement is that textarea — which is almost always. Treating
 * it as a text input would block every Option shortcut (Option+T new tab,
 * Option+W close, etc.) whenever the user has the terminal focused, which is
 * the primary case we care about. Exempt it here. paste-handler.js applies
 * the same exemption for the same reason.
 */
export function isTextInputTarget(target) {
  if (!target) return false;
  if (target.classList?.contains("xterm-helper-textarea")) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable === true;
}
