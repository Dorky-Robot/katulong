/**
 * Client-side Plugin Loader
 *
 * Fetches plugin manifests from /api/plugins, injects CSS, creates sidebar
 * buttons and panel containers, and lazily loads plugin ES modules on first
 * panel toggle. Handles mutual exclusion with other panels.
 *
 * Usage in app.js:
 *   const pluginManager = await initPlugins({ api, ws, showToast, ... });
 *   // pluginManager.closeAll() — close all plugin panels
 *   // pluginManager.getPluginButtons() — for shortcut bar
 */

import { api } from "/lib/api-client.js";

/**
 * @param {object} opts
 * @param {Function} opts.showToast
 * @param {Function} opts.getWs - returns current WebSocket instance
 * @param {Function} opts.getSessionName - returns current session name
 * @param {Function} opts.closeOtherPanels - close built-in panels before opening a plugin panel
 * @param {Function} opts.returnToTerminal - focus back to terminal
 * @param {HTMLElement} opts.termContainer - #terminal-container element
 * @param {HTMLElement} opts.pluginPanelsContainer - #plugin-panels element
 * @param {HTMLElement} opts.sidebarFooter - #sidebar-footer element
 * @param {Function} opts.fitActiveTerminal - resize terminal after panel toggle
 * @param {Function} opts.closeSidebarIfOverlay - close sidebar on mobile after action
 */
export async function initPlugins(opts) {
  const {
    showToast, getWs, getSessionName,
    closeOtherPanels, returnToTerminal,
    termContainer, pluginPanelsContainer, sidebarFooter,
    fitActiveTerminal, closeSidebarIfOverlay,
  } = opts;

  let plugins = [];

  try {
    const data = await api("GET", "/api/plugins");
    plugins = data.plugins || [];
  } catch (err) {
    // No plugins or server doesn't support plugins yet — silently continue
    return createEmptyManager();
  }

  if (plugins.length === 0) return createEmptyManager();

  const loadedModules = new Map(); // name -> { mount, unmount, focus }
  const panelEls = new Map();     // name -> HTMLElement
  const mounted = new Set();

  for (const plugin of plugins) {
    // Inject CSS
    if (plugin.css) {
      const style = document.createElement("style");
      style.dataset.plugin = plugin.name;
      style.textContent = plugin.css;
      document.head.appendChild(style);
    }

    // Create panel container
    if (plugin.panelId) {
      const panel = document.createElement("div");
      panel.id = plugin.panelId;
      panel.style.display = "none";
      panel.style.flex = "1";
      panel.style.minHeight = "0";
      panel.style.overflow = "hidden";
      pluginPanelsContainer.appendChild(panel);
      panelEls.set(plugin.name, panel);
    }

    // Create sidebar button
    if (plugin.sidebarButton) {
      const btn = document.createElement("button");
      btn.className = "sidebar-icon-btn";
      btn.id = plugin.sidebarButton.id;
      btn.setAttribute("aria-label", plugin.sidebarButton.title || plugin.sidebarButton.label);
      btn.title = plugin.sidebarButton.title || plugin.sidebarButton.label;
      btn.innerHTML = `<i class="ph ${plugin.sidebarButton.icon}"></i>`;
      btn.addEventListener("click", () => togglePlugin(plugin.name));

      // Insert before settings button
      const settingsBtn = document.getElementById("sidebar-settings-btn");
      if (settingsBtn) {
        sidebarFooter.insertBefore(btn, settingsBtn);
      } else {
        sidebarFooter.appendChild(btn);
      }
    }
  }

  function getActivePlugin() {
    for (const [name, el] of panelEls) {
      if (el.style.display !== "none") return name;
    }
    return null;
  }

  function closePlugin(name) {
    const el = panelEls.get(name);
    if (!el) return;
    const plugin = plugins.find((p) => p.name === name);
    el.style.display = "none";
    if (plugin?.hiddenClass) {
      termContainer.classList.remove(plugin.hiddenClass);
    }
  }

  function closeAll() {
    for (const name of panelEls.keys()) {
      closePlugin(name);
    }
  }

  async function togglePlugin(name) {
    const el = panelEls.get(name);
    if (!el) return;

    const plugin = plugins.find((p) => p.name === name);
    const isActive = el.style.display !== "none";

    if (isActive) {
      closePlugin(name);
      returnToTerminal();
      return;
    }

    // Close other panels (built-in + plugin)
    closeOtherPanels();
    closeAll();

    // Lazy-load the module
    if (!mounted.has(name) && plugin.moduleUrl) {
      try {
        const mod = await import(plugin.moduleUrl);
        loadedModules.set(name, mod);
        const clientCtx = {
          api: (method, path, body) => api(method, path, body),
          sendWs: (msg) => { const ws = getWs(); if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); },
          getSessionName,
          showToast,
        };
        if (typeof mod.mount === "function") {
          mod.mount(el, clientCtx);
        }
        mounted.add(name);
      } catch (err) {
        showToast(`Failed to load plugin: ${name}`);
        console.error(`Plugin load error (${name}):`, err);
        return;
      }
    }

    // Show panel, hide terminal
    if (plugin?.hiddenClass) {
      termContainer.classList.add(plugin.hiddenClass);
    }
    el.style.display = "flex";

    const mod = loadedModules.get(name);
    if (mod?.focus) mod.focus();

    if (closeSidebarIfOverlay) closeSidebarIfOverlay();
  }

  function getPluginButtons() {
    return plugins
      .filter((p) => p.sidebarButton)
      .map((p) => ({
        icon: p.sidebarButton.icon.replace("ph-", ""),
        label: p.sidebarButton.label,
        click: () => togglePlugin(p.name),
      }));
  }

  return { closeAll, togglePlugin, getPluginButtons, plugins };
}

function createEmptyManager() {
  return {
    closeAll() {},
    togglePlugin() {},
    getPluginButtons() { return []; },
    plugins: [],
  };
}
