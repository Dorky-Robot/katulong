/**
 * Terminal Setup
 *
 * Composable xterm.js terminal initialization and configuration.
 */

import { Terminal } from "/vendor/xterm/xterm.esm.js";
import { FitAddon } from "/vendor/xterm/addon-fit.esm.js";
import { WebLinksAddon } from "/vendor/xterm/addon-web-links.esm.js";
import { DARK_THEME, LIGHT_THEME } from "/lib/theme-manager.js";
import { withPreservedScroll, scrollToBottom } from "/lib/scroll-utils.js";

/**
 * Create and configure terminal
 */
export function createTerminal(options = {}) {
  const {
    containerId = "terminal-container",
    theme = "dark",
    onInit
  } = options;

  // Create terminal with configuration
  const term = new Terminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
    theme: theme === "light" ? LIGHT_THEME : DARK_THEME,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
  });

  // Load addons
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  // Open terminal
  const container = document.getElementById(containerId);
  if (container) {
    term.open(container);
  }

  // Callback after terminal is initialized
  if (onInit) onInit(term);

  // Disable mobile autocorrect/suggestions on xterm's hidden textarea
  function patchTextarea() {
    const ta = document.querySelector(".xterm-helper-textarea");
    if (!ta || ta._patched) return;
    ta._patched = true;
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "none");
    ta.setAttribute("autocomplete", "new-password");
    ta.setAttribute("spellcheck", "false");
    ta.autocomplete = "new-password";
    ta.autocapitalize = "none";
    ta.spellcheck = false;
    ta.addEventListener("compositionstart", (e) => e.preventDefault());
  }

  patchTextarea();

  // Watch for DOM changes to re-patch textarea if needed
  if (container) {
    new MutationObserver(patchTextarea).observe(container, {
      childList: true,
      subtree: true
    });
  }

  // Fit terminal after fonts are loaded
  document.fonts.ready.then(() => {
    withPreservedScroll(term, () => fit.fit());
    // Ensure we start at bottom on initial page load
    scrollToBottom(term);
  });

  return { term, fit };
}
