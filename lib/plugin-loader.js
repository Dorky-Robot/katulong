/**
 * Plugin Loader
 *
 * Discovers, loads, and manages katulong plugins. A plugin is an npm package
 * that exports a manifest with server-side (routes, WS handlers, lifecycle),
 * client-side (CSS, sidebar button, panel, module URL), and config definitions.
 *
 * Plugin manifest shape:
 *
 *   export default {
 *     name: "my-plugin",
 *     version: "1.0.0",
 *
 *     // Configuration fields the plugin requires (connector settings)
 *     config: {
 *       url:    { type: "url",    label: "Service URL", required: true, placeholder: "http://..." },
 *       apiKey: { type: "secret", label: "API Key",     required: true, placeholder: "key_..." },
 *     },
 *
 *     server: {
 *       routes(ctx)      → [{ method, path|prefix, handler }]
 *       wsHandlers(ctx)  → { "my-plugin:msg-type": (ws, msg, clientId) => {} }
 *       init(ctx)        → called once at startup (ctx.pluginConfig has stored values)
 *       shutdown()       → called during graceful shutdown
 *     },
 *     client: {
 *       css:              string of CSS to inject
 *       sidebarButton:    { id, icon, label, title }
 *       panelId:          string — DOM id for the panel container
 *       moduleUrl:        string — URL to the client-side ES module
 *       hiddenClass:      string — class added to #terminal-container when panel is active
 *     }
 *   }
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/** @type {Map<string, { manifest: object, configPath: string, pluginConfig: object }>} */
const loadedPlugins = new Map();

/**
 * Load plugins configured for this katulong instance.
 */
export async function loadPlugins(ctx) {
  const pluginNames = discoverPlugins(ctx.dataDir, ctx.rootDir);
  const pluginRoutes = [];
  const pluginWsHandlers = {};
  const pluginClientManifests = [];
  const shutdownFns = [];

  for (const name of pluginNames) {
    try {
      const plugin = await loadPlugin(name, ctx);
      if (plugin.routes) pluginRoutes.push(...plugin.routes);
      if (plugin.wsHandlers) Object.assign(pluginWsHandlers, plugin.wsHandlers);
      if (plugin.clientManifest) pluginClientManifests.push(plugin.clientManifest);
      if (plugin.shutdown) shutdownFns.push(plugin.shutdown);
      log.info("Plugin loaded", { name, version: plugin.version });
    } catch (err) {
      log.error("Failed to load plugin", { name, error: err.message, stack: err.stack });
    }
  }

  // --- Plugin API routes ---

  // GET /api/plugins — discovery (client manifests + config schemas)
  pluginRoutes.push({
    method: "GET",
    path: "/api/plugins",
    handler: ctx.auth((_req, res) => {
      ctx.json(res, 200, { plugins: pluginClientManifests });
    }),
  });

  // GET /api/plugins/<name>/config — read config (secrets masked)
  pluginRoutes.push({
    method: "GET",
    prefix: "/api/plugins/",
    handler: ctx.auth((req, res, param) => {
      const match = param.match(/^(.+)\/config$/);
      if (!match) { ctx.json(res, 404, { error: "Not found" }); return; }
      const pluginName = match[1];
      const entry = loadedPlugins.get(pluginName);
      if (!entry) { ctx.json(res, 404, { error: "Plugin not found" }); return; }
      ctx.json(res, 200, {
        name: pluginName,
        config: maskSecrets(entry.pluginConfig, entry.manifest.config),
        schema: entry.manifest.config || null,
      });
    }),
  });

  // PUT /api/plugins/<name>/config — save config
  pluginRoutes.push({
    method: "PUT",
    prefix: "/api/plugins/",
    handler: ctx.auth(ctx.csrf(async (req, res, param) => {
      const match = param.match(/^(.+)\/config$/);
      if (!match) { ctx.json(res, 404, { error: "Not found" }); return; }
      const pluginName = match[1];
      const entry = loadedPlugins.get(pluginName);
      if (!entry) { ctx.json(res, 404, { error: "Plugin not found" }); return; }

      const body = await ctx.parseJSON(req);
      const schema = entry.manifest.config || {};

      // Validate
      const error = validateConfig(body, schema);
      if (error) { ctx.json(res, 400, { error }); return; }

      // Save atomically
      const tmp = `${entry.configPath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), { mode: 0o600 });
      renameSync(tmp, entry.configPath);

      // Update in-memory config
      Object.assign(entry.pluginConfig, body);

      // Notify plugin of config change
      if (typeof entry.manifest.server?.onConfigChange === "function") {
        try {
          await entry.manifest.server.onConfigChange(entry.pluginConfig);
        } catch (err) {
          log.warn("Plugin config change handler error", { plugin: pluginName, error: err.message });
        }
      }

      log.info("Plugin config saved", { plugin: pluginName });
      ctx.json(res, 200, {
        ok: true,
        config: maskSecrets(entry.pluginConfig, schema),
      });
    })),
  });

  return {
    pluginRoutes,
    pluginWsHandlers,
    pluginClientManifests,
    async shutdownPlugins() {
      for (const fn of shutdownFns) {
        try { await fn(); } catch (err) {
          log.warn("Plugin shutdown error", { error: err.message });
        }
      }
    },
  };
}

/**
 * Discover plugin names from config files.
 */
function discoverPlugins(dataDir, rootDir) {
  const pluginsJsonPath = join(dataDir, "plugins.json");
  if (existsSync(pluginsJsonPath)) {
    try {
      const config = JSON.parse(readFileSync(pluginsJsonPath, "utf-8"));
      if (Array.isArray(config.plugins) && config.plugins.length > 0) {
        log.info("Plugins discovered from plugins.json", { count: config.plugins.length });
        return config.plugins;
      }
    } catch (err) {
      log.warn("Failed to read plugins.json", { error: err.message });
    }
  }

  const pkgPath = join(rootDir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.katulong?.plugins && Array.isArray(pkg.katulong.plugins)) {
      log.info("Plugins discovered from package.json", { count: pkg.katulong.plugins.length });
      return pkg.katulong.plugins;
    }
  } catch { /* no plugins */ }

  return [];
}

/**
 * Load a single plugin by package name.
 */
async function loadPlugin(name, ctx) {
  const mod = await import(name);
  const manifest = mod.default || mod;

  if (!manifest.name || typeof manifest.name !== "string") {
    throw new Error(`Plugin ${name} must export a 'name' field`);
  }

  // Plugin-specific data directory
  const pluginDataDir = join(ctx.dataDir, "plugins", manifest.name);
  mkdirSync(pluginDataDir, { recursive: true });

  // Load stored config
  const configPath = join(pluginDataDir, "config.json");
  let pluginConfig = {};
  if (existsSync(configPath)) {
    try {
      pluginConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      log.warn("Failed to read plugin config", { plugin: manifest.name, error: err.message });
    }
  }

  // Track for config API
  loadedPlugins.set(manifest.name, { manifest, configPath, pluginConfig });

  const pluginCtx = {
    ...ctx,
    pluginDataDir,
    pluginName: manifest.name,
    pluginConfig,
  };

  const result = {
    name: manifest.name,
    version: manifest.version || "0.0.0",
    routes: null,
    wsHandlers: null,
    clientManifest: null,
    shutdown: null,
  };

  // Server-side
  if (manifest.server) {
    if (typeof manifest.server.init === "function") {
      await manifest.server.init(pluginCtx);
    }
    if (typeof manifest.server.routes === "function") {
      const routes = manifest.server.routes(pluginCtx);
      if (Array.isArray(routes)) {
        result.routes = routes.map((route) => ({ ...route, _plugin: manifest.name }));
      }
    }
    if (typeof manifest.server.wsHandlers === "function") {
      result.wsHandlers = manifest.server.wsHandlers(pluginCtx);
    }
    if (typeof manifest.server.shutdown === "function") {
      result.shutdown = manifest.server.shutdown.bind(manifest.server);
    }
  }

  // Client-side manifest
  if (manifest.client) {
    result.clientManifest = {
      name: manifest.name,
      css: manifest.client.css || null,
      sidebarButton: manifest.client.sidebarButton || null,
      panelId: manifest.client.panelId || null,
      moduleUrl: manifest.client.moduleUrl || null,
      hiddenClass: manifest.client.hiddenClass || `${manifest.name}-hidden`,
      configSchema: manifest.config || null,
      configured: isConfigured(pluginConfig, manifest.config),
    };
  }

  return result;
}

/**
 * Check if all required config fields are set.
 */
function isConfigured(config, schema) {
  if (!schema) return true;
  for (const [key, field] of Object.entries(schema)) {
    if (field.required && !config[key]) return false;
  }
  return true;
}

/**
 * Mask secret values for API responses.
 */
function maskSecrets(config, schema) {
  if (!schema || !config) return config || {};
  const masked = { ...config };
  for (const [key, field] of Object.entries(schema)) {
    if (field.type === "secret" && masked[key]) {
      const val = masked[key];
      masked[key] = val.length > 8 ? val.slice(0, 8) + "..." : "***";
    }
  }
  return masked;
}

/**
 * Validate config values against schema.
 */
function validateConfig(values, schema) {
  if (!values || typeof values !== "object") return "Config must be an object";
  for (const [key, field] of Object.entries(schema)) {
    const val = values[key];
    if (field.required && (!val || typeof val !== "string" || !val.trim())) {
      return `${field.label || key} is required`;
    }
    if (val && field.type === "url") {
      try {
        const parsed = new URL(val);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return `${field.label || key} must be an HTTP(S) URL`;
        }
      } catch {
        return `${field.label || key} is not a valid URL`;
      }
      if (val.length > 2048) return `${field.label || key} is too long`;
    }
    if (val && field.type === "secret" && val.length > 500) {
      return `${field.label || key} is too long`;
    }
  }
  // Reject unknown keys
  for (const key of Object.keys(values)) {
    if (!schema[key]) return `Unknown config field: ${key}`;
  }
  return null;
}
