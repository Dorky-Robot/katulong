import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * ConfigManager handles instance configuration
 * - Instance name (defaults to hostname)
 * - Editable via UI
 * - Persisted to config.json
 */
export class ConfigManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, "config.json");
    this.config = null;
    this._lock = Promise.resolve();
  }

  /**
   * Execute fn under a mutex so concurrent config writes serialize.
   * Same pattern as withStateLock in auth.js.
   */
  async withLock(fn) {
    const prev = this._lock;
    let release;
    this._lock = new Promise((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Initialize config - load or create with defaults
   */
  initialize() {
    if (existsSync(this.configPath)) {
      try {
        const content = readFileSync(this.configPath, "utf-8");
        this.config = JSON.parse(content);

        let needsSave = false;

        // Ensure instanceId exists (for backward compatibility)
        if (!this.config.instanceId) {
          this.config.instanceId = randomUUID();
          needsSave = true;
        }

        // Ensure instanceName is valid (resets poisoned/legacy values that may contain HTML)
        if (!this.config.instanceName || !/^[a-zA-Z0-9 ._-]+$/.test(this.config.instanceName)) {
          this.config.instanceName = hostname();
          needsSave = true;
        }

        // Ensure instanceIcon exists and is valid (resets poisoned/legacy values)
        if (!this.config.instanceIcon || !/^[a-z0-9-]+$/.test(this.config.instanceIcon)) {
          this.config.instanceIcon = "terminal-window";
          needsSave = true;
        }

        // Ensure toolbarColor exists and is valid (resets poisoned/legacy values)
        if (!this.config.toolbarColor || !/^[a-z0-9-]+$/.test(this.config.toolbarColor)) {
          this.config.toolbarColor = "default";
          needsSave = true;
        }

        if (needsSave) {
          this.save();
        }
      } catch (error) {
        log.error("Failed to load config, using defaults", { path: this.configPath, error: error.message });
        this.config = this.getDefaultConfig();
      }
    } else {
      this.config = this.getDefaultConfig();
      this.save();
    }

    return this.config;
  }

  /**
   * Get default configuration
   */
  getDefaultConfig() {
    return {
      instanceId: randomUUID(), // Unique ID for this instance (used in CA cert)
      instanceName: hostname(),
      instanceIcon: "terminal-window", // Default Phosphor icon
      toolbarColor: "default", // Default toolbar color
      portProxyEnabled: true, // Whether /_proxy/<port>/ routes are active
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Get a config value, initializing if needed.
   */
  _get(key, defaultValue = null) {
    if (!this.config) this.initialize();
    return this.config[key] ?? defaultValue;
  }

  /**
   * Set a config value, initializing if needed, then persist.
   */
  _set(key, value) {
    if (!this.config) this.initialize();
    this.config[key] = value;
    this.config.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Get instance ID (unique identifier for this instance)
   */
  getInstanceId() {
    return this._get('instanceId');
  }

  /**
   * Get instance name
   */
  getInstanceName() {
    return this._get('instanceName');
  }

  /**
   * Set instance name
   */
  async setInstanceName(name) {
    // Validate
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Instance name must be a non-empty string");
    }

    if (name.length > 100) {
      throw new Error("Instance name must be 100 characters or less");
    }

    // Restrict to safe characters: letters, digits, spaces, hyphens, underscores, dots
    // Prevents stored XSS if the frontend renders the name without escaping
    if (!/^[a-zA-Z0-9 ._-]+$/.test(name.trim())) {
      throw new Error("Instance name must only contain letters, digits, spaces, hyphens, underscores, and periods");
    }

    await this.withLock(() => this._set('instanceName', name.trim()));
  }

  /**
   * Get instance icon
   */
  getInstanceIcon() {
    return this._get('instanceIcon', 'terminal-window');
  }

  /**
   * Set instance icon
   */
  async setInstanceIcon(icon) {
    // Validate
    if (typeof icon !== "string" || icon.trim().length === 0) {
      throw new Error("Instance icon must be a non-empty string");
    }

    if (icon.length > 50) {
      throw new Error("Instance icon must be 50 characters or less");
    }

    if (!/^[a-z0-9-]+$/.test(icon.trim())) {
      throw new Error("Instance icon must only contain lowercase letters, digits, and hyphens");
    }

    await this.withLock(() => this._set('instanceIcon', icon.trim()));
  }

  /**
   * Get toolbar color
   */
  getToolbarColor() {
    return this._get('toolbarColor', 'default');
  }

  /**
   * Set toolbar color
   */
  async setToolbarColor(color) {
    // Validate
    if (typeof color !== "string" || color.trim().length === 0) {
      throw new Error("Toolbar color must be a non-empty string");
    }

    if (color.length > 50) {
      throw new Error("Toolbar color must be 50 characters or less");
    }

    // Restrict to safe characters: lowercase letters, digits, hyphens
    if (!/^[a-z0-9-]+$/.test(color.trim())) {
      throw new Error("Toolbar color must only contain lowercase letters, digits, and hyphens");
    }

    await this.withLock(() => this._set('toolbarColor', color.trim()));
  }

  /**
   * Get public URL (tunnel/external URL for remote access)
   */
  getPublicUrl() {
    return this._get('publicUrl', '');
  }

  /**
   * Set public URL
   */
  async setPublicUrl(url) {
    if (typeof url !== "string") {
      throw new Error("Public URL must be a string");
    }

    const trimmed = url.trim();

    // Allow empty string to clear the URL
    if (trimmed === '') {
      await this.withLock(() => this._set('publicUrl', ''));
      return;
    }

    if (trimmed.length > 200) {
      throw new Error("Public URL must be 200 characters or less");
    }

    // Must be a valid https URL
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Public URL must use http or https");
      }
    } catch (e) {
      if (e.message.includes("http")) throw e;
      throw new Error("Public URL must be a valid URL (e.g., https://myhost.example.com)");
    }

    // Strip trailing slash for consistency
    const normalized = trimmed.replace(/\/+$/, '');
    await this.withLock(() => this._set('publicUrl', normalized));
  }

  /**
   * Get port proxy enabled
   */
  getPortProxyEnabled() {
    return this._get('portProxyEnabled', true);
  }

  /**
   * Set port proxy enabled
   */
  async setPortProxyEnabled(value) {
    if (typeof value !== "boolean") {
      throw new Error("portProxyEnabled must be a boolean");
    }
    await this.withLock(() => this._set('portProxyEnabled', value));
  }

  /**
   * Get the configured external Ollama URL, or null if unset.
   * When set, outbound LLM calls (summarizer + narrator) route through
   * this URL instead of localhost:11434. Pairs with `ollamaPeerToken`.
   */
  getOllamaPeerUrl() {
    return this._get('ollamaPeerUrl', null);
  }

  async setOllamaPeerUrl(value) {
    if (value === null || value === "") {
      await this.withLock(() => this._set('ollamaPeerUrl', null));
      return;
    }
    if (typeof value !== "string") {
      throw new Error("ollamaPeerUrl must be a string or null");
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      await this.withLock(() => this._set('ollamaPeerUrl', null));
      return;
    }
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("ollamaPeerUrl must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ollamaPeerUrl must use http or https");
    }
    // Reject embedded credentials — they would land in the request URL
    // and bypass the explicit Bearer token mechanism, plus risk leaking
    // into upstream logs. Use the dedicated token field instead.
    if (parsed.username || parsed.password) {
      throw new Error("ollamaPeerUrl must not contain credentials; use the token field instead");
    }
    // Strip trailing slash so callers can predictably append paths.
    const normalized = trimmed.replace(/\/+$/, "");
    await this.withLock(() => this._set('ollamaPeerUrl', normalized));
  }

  /**
   * Get the configured Bearer token for the external Ollama proxy, or null.
   * Stored in the same 0600-mode config file as the rest; rotate by
   * calling `setOllamaPeerToken(null)` then re-setting.
   */
  getOllamaPeerToken() {
    return this._get('ollamaPeerToken', null);
  }

  async setOllamaPeerToken(value) {
    if (value === null || value === "") {
      await this.withLock(() => this._set('ollamaPeerToken', null));
      return;
    }
    if (typeof value !== "string") {
      throw new Error("ollamaPeerToken must be a string or null");
    }
    // Trim clipboard whitespace — a copied token with leading/trailing
    // newline would otherwise save with a malformed Bearer header and
    // silently fail the test handshake.
    const trimmed = value.trim();
    if (trimmed === "") {
      await this.withLock(() => this._set('ollamaPeerToken', null));
      return;
    }
    // 32-char minimum aligns with the bridge's 32-byte hex default and
    // gives ~128 bits of entropy. Enough to make brute-force infeasible
    // even if the bridge ends up on a publicly-resolvable hostname.
    if (trimmed.length < 32) {
      throw new Error("ollamaPeerToken must be at least 32 characters");
    }
    if (trimmed.length > 512) {
      throw new Error("ollamaPeerToken must be 512 characters or less");
    }
    await this.withLock(() => this._set('ollamaPeerToken', trimmed));
  }

  /**
   * Get the URL where sipag's web UI lives, or null if unset.
   * The sipag tile uses this to decide where to point its iframe. When
   * sipag runs on the same host as this katulong (the common case), set
   * to the relative reverse-proxy path (e.g. "/_proxy/7100/") to keep
   * everything same-origin and skip Cloudflare/CSP. When sipag runs
   * elsewhere, set to its public URL (e.g. "https://sipag.felixflor.es").
   * Falls back at the tile layer to a sensible default when null.
   */
  getSipagUrl() {
    return this._get('sipagUrl', null);
  }

  async setSipagUrl(value) {
    if (value === null || value === "") {
      await this.withLock(() => this._set('sipagUrl', null));
      return;
    }
    if (typeof value !== "string") {
      throw new Error("sipagUrl must be a string or null");
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      await this.withLock(() => this._set('sipagUrl', null));
      return;
    }
    // Accept two shapes: an absolute http(s) URL OR a relative path
    // (must start with `/`). Relative paths route through katulong's
    // own static server / reverse proxy and stay same-origin.
    if (trimmed.startsWith("/")) {
      // Reject path traversal up the tree; keep the value confined to
      // a recognizable shape so a buggy setter can't end up serving
      // arbitrary cross-host content via the same field.
      if (trimmed.includes("..")) {
        throw new Error("sipagUrl path must not contain ..");
      }
      await this.withLock(() => this._set('sipagUrl', trimmed));
      return;
    }
    let parsed;
    try { parsed = new URL(trimmed); } catch { throw new Error("sipagUrl must be a valid URL or path"); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("sipagUrl must use http or https");
    }
    if (parsed.username || parsed.password) {
      throw new Error("sipagUrl must not contain credentials");
    }
    const normalized = trimmed.replace(/\/+$/, "");
    await this.withLock(() => this._set('sipagUrl', normalized));
  }

  /**
   * Get all config — but with secret fields redacted. Used by the public
   * `GET /api/config` endpoint, which is reached by any authenticated
   * client. The dedicated peer-config endpoint exposes presence-only
   * (`hasToken: bool`); we must not bypass that here.
   *
   * If you genuinely need the unredacted in-memory config (e.g., for
   * server-side wiring like resolveEndpoint), call the field-specific
   * getter directly.
   */
  getConfig() {
    if (!this.config) this.initialize();
    const { ollamaPeerToken, ...safe } = this.config;
    return safe;
  }

  /**
   * Save config atomically
   */
  save() {
    const tmpPath = `${this.configPath}.tmp`;
    const content = JSON.stringify(this.config, null, 2);

    // mode 0o600: owner read/write only — config contains instanceId used in CA cert
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, this.configPath);
  }
}
