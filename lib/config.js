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
   * Get all config
   */
  getConfig() {
    if (!this.config) this.initialize();
    return { ...this.config };
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
