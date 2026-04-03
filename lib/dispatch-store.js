/**
 * Dispatch Feature Store
 *
 * File-based persistence for the dispatch feature queue.
 * Stores features in DATA_DIR/dispatch-features.json.
 * Each feature progresses: raw → refined → queued → active → done/failed/dismissed.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * Create a dispatch store backed by a JSON file in the given data directory.
 * @param {string} dataDir - Path to the data directory (e.g. ~/.katulong)
 * @returns {object} Store API
 */
export function createDispatchStore(dataDir) {
  const filePath = join(dataDir, "dispatch-features.json");

  /** Simple async mutex: chain operations to prevent concurrent file writes. */
  let _lock = Promise.resolve();

  function withLock(fn) {
    const op = _lock.then(fn);
    _lock = op.catch(() => {}); // keep chain alive on error
    return op;
  }

  function readFeatures() {
    try {
      if (!existsSync(filePath)) return [];
      return JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (err) {
      log.warn("Failed to read dispatch features, starting fresh", { error: err.message });
      return [];
    }
  }

  function writeFeatures(features) {
    mkdirSync(dataDir, { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(features, null, 2) + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  function generateId() {
    return `f-${randomUUID()}`;
  }

  return {
    /**
     * Add a new raw feature idea.
     * @param {string} raw - The raw idea text
     * @returns {Promise<object>} The created feature
     */
    addFeature(raw) {
      return withLock(() => {
        const features = readFeatures();
        const feature = {
          id: generateId(),
          raw,
          status: "raw",
          project: null,
          refined: null,
          execution: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        features.push(feature);
        writeFeatures(features);
        return feature;
      });
    },

    /**
     * Get a feature by ID.
     * @param {string} id
     * @returns {object|null}
     */
    getFeature(id) {
      return readFeatures().find((f) => f.id === id) || null;
    },

    /**
     * Update a feature by ID (shallow merge).
     * @param {string} id
     * @param {object} fields - Fields to merge
     * @returns {Promise<object|null>} Updated feature, or null if not found
     */
    updateFeature(id, fields) {
      return withLock(() => {
        const features = readFeatures();
        const idx = features.findIndex((f) => f.id === id);
        if (idx < 0) return null;
        features[idx] = { ...features[idx], ...fields, updatedAt: new Date().toISOString() };
        writeFeatures(features);
        return features[idx];
      });
    },

    /**
     * Delete a feature by ID.
     * @param {string} id
     * @returns {Promise<boolean>} True if deleted
     */
    deleteFeature(id) {
      return withLock(() => {
        const features = readFeatures();
        const idx = features.findIndex((f) => f.id === id);
        if (idx < 0) return false;
        features.splice(idx, 1);
        writeFeatures(features);
        return true;
      });
    },

    /**
     * List features, optionally filtered by status.
     * @param {string} [status] - Filter by status
     * @returns {object[]}
     */
    listFeatures(status) {
      const features = readFeatures();
      if (status) return features.filter((f) => f.status === status);
      return features;
    },

    /**
     * Get all active features for a given project.
     * @param {string} project - Project slug
     * @returns {object[]}
     */
    getActiveByProject(project) {
      return readFeatures().filter(
        (f) => f.project === project && f.status === "active"
      );
    },

    /**
     * Append a log entry to a feature's execution logs.
     * @param {string} id
     * @param {string} text
     * @returns {Promise<void>}
     */
    addLog(id, text) {
      return withLock(() => {
        const features = readFeatures();
        const feature = features.find((f) => f.id === id);
        if (!feature) return;
        if (!feature.execution) feature.execution = {};
        if (!feature.execution.logs) feature.execution.logs = [];
        feature.execution.logs.push(text);
        // Keep only last 200 log entries
        if (feature.execution.logs.length > 200) {
          feature.execution.logs = feature.execution.logs.slice(-200);
        }
        feature.updatedAt = new Date().toISOString();
        writeFeatures(features);
      });
    },
  };
}
