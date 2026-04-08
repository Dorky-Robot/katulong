/**
 * Command Palette
 *
 * Alfred/Spotlight-style overlay that lets the user run app actions by
 * typing. PR 1 ships three one-shot providers (toggle theme, toggle
 * vibrancy, find in terminal); PR 2 will add session-scoped actions and
 * a two-stage prompt flow; v2 will hydrate providers from filesystem
 * plugins. The provider shape below is intentionally future-proof for
 * both — `prompt` is reserved for PR 2's follow-up step but unused here,
 * and `id` is the stable handle for the future recency-bias rank.
 *
 * Wiring is the established katulong factory pattern: createCommandPalette
 * takes its dependencies as named args, returns an object with init() and
 * a few imperative entry points. No globals, no module-level state.
 *
 * ## Hotkey: Option+Space
 *
 * Intercepted at TWO layers, both required (see commits c6f1c31 and
 * 2a13634 for the history of why single-layer interception leaks):
 *
 *   1. terminal-key-decider.js → returns action `togglePalette`. The
 *      keyboard shell in terminal-keyboard.js maps that to the callback
 *      we pass in via createTerminalKeyboard's `onTogglePalette`. This
 *      catches Option+Space when the xterm helper textarea has focus.
 *
 *   2. document.addEventListener("keydown", ..., true) below — capture
 *      phase. Catches Option+Space when focus is anywhere ELSE (a real
 *      input, the body, a modal). Without this layer, the palette
 *      wouldn't open from the settings panel or while a rename input
 *      is focused.
 *
 * Both layers must key off `ev.code === "Space"`, NOT `ev.key`. macOS
 * substitutes the Option layer character (a non-breaking space, U+00A0)
 * before the event reaches JS, so checking `ev.key === " "` silently
 * misses every press. ev.code is the physical key — stable across
 * modifiers and keyboard layouts. The same rule killed Option+F /
 * Option+K back in c6f1c31.
 *
 * ## Provider interface
 *
 * Each provider is a plain object:
 *
 *   {
 *     id: "theme.toggle",      // stable handle for recency (PR 3)
 *     title: "Toggle theme",   // shown in the list
 *     subtitle: "Switch ...",  // optional secondary line
 *     category: "Appearance",  // shown as a tag on the right
 *     keywords: ["dark", ...], // extra match tokens
 *     prompt: undefined,       // RESERVED for PR 2 — see typedef
 *     run(ctx, choice) { ... } // called on Enter / click
 *   }
 *
 * PR 1 has no provider that uses `prompt`. The shape is documented so
 * PR 2 can add follow-up-prompt providers without restructuring the
 * registry or the dispatch path.
 */

/**
 * @typedef {Object} PaletteProvider
 * @property {string} id
 * @property {string} title
 * @property {string} [subtitle]
 * @property {string} [category]
 * @property {string[]} [keywords]
 * @property {Object} [prompt]                       — reserved for PR 2
 * @property {string} [prompt.placeholder]
 * @property {function} [prompt.choices]             — (ctx) => [{id,label,hint}]
 * @property {function} run                          — (ctx, choice?) => void
 */

// ── Pure ranking helpers ─────────────────────────────────────────────────
//
// scoreMatch / rankProviders are pure so they can be unit-tested without
// the DOM. The matcher is a small subsequence ranker with bonuses for
// prefix and word-boundary hits — good enough for tens of providers and
// dependency-free. If the registry ever grows to thousands of providers
// we can swap in a heavier fuzzy library, but the function signature
// stays the same.

function _scoreString(query, source, weight) {
  if (!source) return 0;
  const hay = source.toLowerCase();
  const needle = query.toLowerCase();
  if (!needle) return 0;

  // Exact prefix is the strongest signal.
  if (hay.startsWith(needle)) return 100 * weight;

  // Word-boundary hit (e.g. query "tog" matches "Toggle theme").
  if (new RegExp("(^|\\s|\\b|[._-])" + escapeRegex(needle)).test(hay)) {
    return 60 * weight;
  }

  // Subsequence: every char of needle must appear in order in hay.
  // Score is higher when chars are consecutive (closer indices).
  let i = 0, last = -1, run = 0, score = 0;
  for (let h = 0; h < hay.length && i < needle.length; h++) {
    if (hay[h] === needle[i]) {
      if (h === last + 1) { run++; score += 5 * run; } else { run = 1; score += 5; }
      last = h;
      i++;
    }
  }
  if (i < needle.length) return 0; // not all chars matched
  return score * weight;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a provider against a query. Higher is better, 0 means no match.
 * Title is weighted highest, then keywords, then category, then subtitle.
 */
export function scoreMatch(query, provider) {
  if (!query) return 1; // empty query — all providers match equally
  let total = 0;
  total += _scoreString(query, provider.title, 1.0);
  if (provider.keywords) {
    for (const kw of provider.keywords) {
      total += _scoreString(query, kw, 0.7);
    }
  }
  total += _scoreString(query, provider.category, 0.5);
  total += _scoreString(query, provider.subtitle, 0.4);
  return total;
}

/**
 * Rank providers by score. Empty query returns insertion order. Ties are
 * broken stably (Array.sort is stable in modern engines).
 */
export function rankProviders(query, providers) {
  if (!query) return providers.slice();
  return providers
    .map((p) => ({ p, s: scoreMatch(query, p) }))
    .filter((entry) => entry.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((entry) => entry.p);
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create the command palette.
 *
 * @param {object} deps
 * @param {object} deps.themeManager     — see lib/theme-manager.js
 * @param {function} deps.toggleSearchBar — opens/closes the in-terminal find bar
 * @param {function} deps.getTerm         — () => active xterm instance
 */
export function createCommandPalette(deps = {}) {
  const { themeManager, toggleSearchBar, getTerm } = deps;

  // Closure state — no module-level globals.
  /** @type {Map<string, PaletteProvider>} */
  const providers = new Map();
  /** @type {PaletteProvider[]} */
  let currentMatches = [];
  let selectedIndex = 0;
  let isOpen = false;
  /** @type {Element|null} */
  let savedFocus = null;
  let initialized = false;

  // DOM refs — looked up lazily on init() so the module can be imported
  // before the DOM is parsed without exploding. The HTML is owned by
  // public/index.html (sibling agent's slice).
  let rootEl = null;
  let panelEl = null;
  let inputEl = null;
  let resultsEl = null;
  let emptyEl = null;
  let backdropEl = null;

  /** Build the ctx passed to provider.run(). Easy to extend in PR 2. */
  function buildCtx() {
    return { themeManager, toggleSearchBar, getTerm };
  }

  /** Register a provider. Existing id is replaced (last write wins). */
  function registerProvider(provider) {
    if (!provider || typeof provider.id !== "string" || typeof provider.run !== "function") {
      throw new Error("registerProvider: provider must have {id: string, run: function}");
    }
    providers.set(provider.id, provider);
  }

  /** All providers in registration order. */
  function listProviders() {
    return Array.from(providers.values());
  }

  /** Render the result list to match currentMatches + selectedIndex. */
  function render() {
    // Clear previous results. We rebuild from scratch every render — the
    // list is small (tens of items max in PR 1) and incremental diffing
    // is not worth the complexity.
    resultsEl.replaceChildren();

    if (currentMatches.length === 0) {
      emptyEl.removeAttribute("hidden");
      return;
    }
    emptyEl.setAttribute("hidden", "");

    currentMatches.forEach((provider, idx) => {
      // Use createElement + textContent — NEVER innerHTML with provider
      // strings. Even though PR 1 providers are static, the habit matters
      // for the future plugin system (CLAUDE.md code-review checklist #8).
      const li = document.createElement("li");
      li.className = "palette-item" + (idx === selectedIndex ? " selected" : "");
      li.setAttribute("role", "option");
      li.dataset.providerId = provider.id;

      const main = document.createElement("div");
      main.className = "palette-item-main";

      const title = document.createElement("div");
      title.className = "palette-item-title";
      title.textContent = provider.title;
      main.appendChild(title);

      if (provider.subtitle) {
        const subtitle = document.createElement("div");
        subtitle.className = "palette-item-subtitle";
        subtitle.textContent = provider.subtitle;
        main.appendChild(subtitle);
      }

      li.appendChild(main);

      if (provider.category) {
        const cat = document.createElement("div");
        cat.className = "palette-item-category";
        cat.textContent = provider.category;
        li.appendChild(cat);
      }

      // Mouse: hover doesn't change selection (the .palette-item:hover
      // CSS already paints feedback); click selects + runs.
      li.addEventListener("click", () => {
        selectedIndex = idx;
        runSelected();
      });

      resultsEl.appendChild(li);
    });

    // Make sure the selected row is in view if the list scrolled.
    const selEl = resultsEl.children[selectedIndex];
    if (selEl) selEl.scrollIntoView({ block: "nearest" });
  }

  /** Recompute matches for the current input value, reset selection. */
  function recompute() {
    const q = inputEl.value.trim();
    currentMatches = rankProviders(q, listProviders());
    selectedIndex = 0;
    render();
  }

  /** Run the currently selected provider, then close. */
  function runSelected() {
    const provider = currentMatches[selectedIndex];
    if (!provider) return;
    // PR 1: all providers are one-shot. PR 2 will branch here on
    // provider.prompt being defined.
    try {
      provider.run(buildCtx());
    } catch (err) {
      console.error("[command-palette] provider.run threw:", err);
    }
    close();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  function open() {
    if (isOpen || !rootEl) return;
    // Save focus so close() can restore it. The xterm helper textarea is
    // the most common case; we restore via getTerm() if the saved element
    // has been removed from the DOM in the meantime.
    savedFocus = document.activeElement;
    isOpen = true;
    rootEl.classList.add("visible");
    rootEl.setAttribute("aria-hidden", "false");
    inputEl.value = "";
    recompute();
    // Focus after the class change so the browser doesn't fight the
    // animation by snapping to a hidden element.
    inputEl.focus();
  }

  function close() {
    if (!isOpen || !rootEl) return;
    isOpen = false;
    rootEl.classList.remove("visible");
    rootEl.setAttribute("aria-hidden", "true");
    // Restore focus. Falls back to the active terminal if the saved
    // element was unmounted (e.g. tab closed while palette was open).
    const target = savedFocus && document.contains(savedFocus) ? savedFocus : null;
    savedFocus = null;
    if (target && typeof target.focus === "function") {
      target.focus();
    } else if (typeof getTerm === "function") {
      getTerm()?.focus?.();
    }
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // ── Event handlers ─────────────────────────────────────────────────────

  /**
   * Document-level capture-phase keydown listener. This is the
   * defense-in-depth layer for Option+Space — catches the keystroke
   * when focus is NOT inside the xterm helper textarea (which is
   * handled by the in-terminal layer). Also handles Esc/arrows/Enter
   * while the palette itself is open.
   */
  function onDocumentKeydown(ev) {
    // Esc closes the palette regardless of focus, but only when open.
    if (isOpen && ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close();
      return;
    }

    // While open, intercept arrows + Enter so the input field doesn't
    // try to handle Enter as a form submit and arrows don't move the
    // caret around in the input.
    if (isOpen) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        if (currentMatches.length === 0) return;
        selectedIndex = Math.min(currentMatches.length - 1, selectedIndex + 1);
        render();
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        if (currentMatches.length === 0) return;
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
        return;
      }
      if (ev.key === "Enter") {
        ev.preventDefault();
        runSelected();
        return;
      }
    }

    // Option+Space: open the palette. Must use ev.code === "Space" — on
    // macOS Option+Space arrives as a non-breaking space (U+00A0) in
    // ev.key, so an ev.key check would silently miss every press. This
    // is the same trap that killed Option+F / Option+K in c6f1c31.
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && ev.code === "Space") {
      // Skip if focus is in a real text input that is NOT xterm's helper
      // textarea — the user might be typing into a rename field, the
      // settings panel, etc. The xterm helper textarea has its own
      // interception in terminal-key-decider.js, so we don't need to
      // double-handle here, but the absence of a test for that case is
      // why we still let it fall through to toggle() below if the target
      // happens to BE the helper textarea (it would have been blocked
      // already, so we won't see it here in practice).
      const target = ev.target;
      const isXtermHelper =
        target?.classList?.contains?.("xterm-helper-textarea");
      const isOtherInput = !isXtermHelper && (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true
      );
      if (isOtherInput) return;

      ev.preventDefault();
      ev.stopPropagation();
      toggle();
    }
  }

  function onInput() {
    recompute();
  }

  function onBackdropClick() {
    close();
  }

  // ── Default providers ──────────────────────────────────────────────────

  /**
   * Resolve the current effective polarity. The theme manager exposes
   * `getEffective()` (legacy alias `getResolvedPolarity` is not present)
   * which returns "dark" or "light" with "auto" already resolved against
   * `prefers-color-scheme`. We fall back to inspecting matchMedia
   * directly if the manager is missing or stripped down.
   */
  function getEffectivePolarity() {
    if (themeManager && typeof themeManager.getEffective === "function") {
      return themeManager.getEffective();
    }
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    return "dark";
  }

  function registerDefaultProviders() {
    registerProvider({
      id: "theme.toggle",
      title: "Toggle theme",
      subtitle: "Switch between light and dark",
      category: "Appearance",
      keywords: ["dark", "light", "polarity", "color", "appearance"],
      run: (ctx) => {
        // If polarity is "auto" we don't want to flip to "auto" again —
        // resolve to the concrete current polarity first, then invert.
        const current = getEffectivePolarity();
        const next = current === "dark" ? "light" : "dark";
        ctx.themeManager?.setPolarity?.(next);
      },
    });

    registerProvider({
      id: "theme.vibrancy",
      title: "Toggle vibrancy",
      subtitle: "Switch between subtle and colorful palette",
      category: "Appearance",
      keywords: ["color", "vivid", "subtle", "colorful", "saturation"],
      run: (ctx) => {
        const current = ctx.themeManager?.getVibrancy?.() ?? "subtle";
        const next = current === "subtle" ? "colorful" : "subtle";
        ctx.themeManager?.setVibrancy?.(next);
      },
    });

    registerProvider({
      id: "terminal.find",
      title: "Find in terminal",
      subtitle: "Open the in-terminal search bar",
      category: "Terminal",
      keywords: ["search", "find", "grep", "filter"],
      run: (ctx) => {
        ctx.toggleSearchBar?.();
      },
    });
  }

  // ── init / destroy ─────────────────────────────────────────────────────

  function init() {
    if (initialized) return;
    rootEl = document.getElementById("palette");
    if (!rootEl) {
      // The HTML markup is owned by the sibling agent's slice. If it's
      // missing we don't want to crash app boot — log loudly and bail.
      console.warn("[command-palette] #palette element missing — palette disabled");
      return;
    }
    panelEl = rootEl.querySelector(".palette-panel");
    inputEl = rootEl.querySelector(".palette-input");
    resultsEl = rootEl.querySelector(".palette-results");
    emptyEl = rootEl.querySelector(".palette-empty");
    backdropEl = rootEl.querySelector(".palette-backdrop");

    if (!inputEl || !resultsEl || !emptyEl || !backdropEl || !panelEl) {
      console.warn("[command-palette] expected children missing under #palette — palette disabled");
      return;
    }

    inputEl.addEventListener("input", onInput);
    backdropEl.addEventListener("click", onBackdropClick);
    document.addEventListener("keydown", onDocumentKeydown, true);

    registerDefaultProviders();
    initialized = true;
  }

  function destroy() {
    if (!initialized) return;
    inputEl?.removeEventListener("input", onInput);
    backdropEl?.removeEventListener("click", onBackdropClick);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    initialized = false;
    isOpen = false;
  }

  return {
    init,
    destroy,
    open,
    close,
    toggle,
    registerProvider,
    // Exposed for tests / future PRs that want to inspect the registry.
    listProviders,
  };
}
