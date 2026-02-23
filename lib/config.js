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

        // Ensure instanceIcon exists (for backward compatibility)
        if (!this.config.instanceIcon) {
          this.config.instanceIcon = "terminal-window";
          needsSave = true;
        }

        // Ensure toolbarColor exists (for backward compatibility)
        if (!this.config.toolbarColor) {
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
   * Get instance ID (unique identifier for this instance)
   */
  getInstanceId() {
    if (!this.config) {
      this.initialize();
    }
    return this.config.instanceId;
  }

  /**
   * Get instance name
   */
  getInstanceName() {
    if (!this.config) {
      this.initialize();
    }
    return this.config.instanceName;
  }

  /**
   * Set instance name
   */
  setInstanceName(name) {
    if (!this.config) {
      this.initialize();
    }

    // Validate
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Instance name must be a non-empty string");
    }

    if (name.length > 100) {
      throw new Error("Instance name must be 100 characters or less");
    }

    this.config.instanceName = name.trim();
    this.config.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Get instance icon
   */
  getInstanceIcon() {
    if (!this.config) {
      this.initialize();
    }
    return this.config.instanceIcon || "terminal-window";
  }

  /**
   * Set instance icon
   */
  setInstanceIcon(icon) {
    if (!this.config) {
      this.initialize();
    }

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

    this.config.instanceIcon = icon.trim();
    this.config.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Get toolbar color
   */
  getToolbarColor() {
    if (!this.config) {
      this.initialize();
    }
    return this.config.toolbarColor || "default";
  }

  /**
   * Set toolbar color
   */
  setToolbarColor(color) {
    if (!this.config) {
      this.initialize();
    }

    // Validate
    if (typeof color !== "string" || color.trim().length === 0) {
      throw new Error("Toolbar color must be a non-empty string");
    }

    if (color.length > 50) {
      throw new Error("Toolbar color must be 50 characters or less");
    }

    this.config.toolbarColor = color.trim();
    this.config.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Get all config
   */
  getConfig() {
    if (!this.config) {
      this.initialize();
    }
    return { ...this.config };
  }

  /**
   * Save config atomically
   */
  save() {
    const tmpPath = `${this.configPath}.tmp`;
    const content = JSON.stringify(this.config, null, 2);

    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, this.configPath);
  }
}
