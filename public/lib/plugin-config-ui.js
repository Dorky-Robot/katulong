/**
 * Plugin Config UI — Connector settings forms
 *
 * Renders config forms for each plugin that declares a config schema.
 * Users configure service URLs and API keys here.
 */

import { api } from "/lib/api-client.js";
import { showToast } from "/lib/image-upload.js";

let container = null;
let plugins = [];

export async function initPluginConfig(el) {
  container = el;
  try {
    const data = await api("GET", "/api/plugins");
    plugins = (data.plugins || []).filter(p => p.configSchema);
  } catch {
    plugins = [];
  }

  if (plugins.length === 0) {
    container.innerHTML = '<div style="padding: 16px; color: var(--text-dim); font-size: 12px;">No connectors available. Install a plugin with connector support.</div>';
    return;
  }

  // Fetch config for each plugin
  for (const plugin of plugins) {
    try {
      const configData = await api("GET", `/api/plugins/${plugin.name}/config`);
      plugin._config = configData.config || {};
      plugin._schema = configData.schema || plugin.configSchema;
    } catch {
      plugin._config = {};
      plugin._schema = plugin.configSchema;
    }
  }

  render();
}

function render() {
  container.innerHTML = plugins.map(p => renderPluginCard(p)).join("");

  // Wire save buttons
  for (const plugin of plugins) {
    const form = container.querySelector(`[data-plugin="${plugin.name}"]`);
    if (!form) continue;
    form.querySelector(".connector-save-btn").addEventListener("click", () => saveConfig(plugin));
  }
}

function renderPluginCard(plugin) {
  const schema = plugin._schema || {};
  const config = plugin._config || {};
  const configured = plugin.configured;

  const fields = Object.entries(schema).map(([key, field]) => {
    const value = config[key] || "";
    const inputType = field.type === "secret" ? "password" : "text";
    const placeholder = field.placeholder || "";
    return `
      <div class="settings-row">
        <span class="settings-label">${escapeHtml(field.label || key)}</span>
        <input type="${inputType}" class="instance-name-input" name="${escapeAttr(key)}"
               value="${escapeAttr(value)}" placeholder="${escapeAttr(placeholder)}"
               autocomplete="off" spellcheck="false" />
      </div>
    `;
  }).join("");

  const status = configured
    ? '<span style="color: var(--success); font-size: 11px;">Connected</span>'
    : '<span style="color: var(--text-dim); font-size: 11px;">Not configured</span>';

  return `
    <div class="connector-card" data-plugin="${escapeAttr(plugin.name)}">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 13px; text-transform: capitalize;">${escapeHtml(plugin.name)}</span>
        ${status}
      </div>
      ${fields}
      <div style="margin-top: 8px; display: flex; justify-content: flex-end;">
        <button class="btn btn--sm connector-save-btn">Save</button>
      </div>
    </div>
  `;
}

async function saveConfig(plugin) {
  const form = container.querySelector(`[data-plugin="${plugin.name}"]`);
  if (!form) return;

  const schema = plugin._schema || {};
  const values = {};
  for (const key of Object.keys(schema)) {
    const input = form.querySelector(`[name="${key}"]`);
    if (input) values[key] = input.value.trim();
  }

  try {
    const result = await api("PUT", `/api/plugins/${plugin.name}/config`, values);
    plugin._config = result.config || values;
    plugin.configured = true;
    showToast(`${plugin.name} connector saved`);
    render();
  } catch (err) {
    showToast(err.message || "Failed to save", true);
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
