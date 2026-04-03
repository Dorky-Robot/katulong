/**
 * Dispatch Feature Store
 *
 * Each feature is a markdown file in DATA_DIR/dispatch/ with YAML frontmatter.
 * Status, projects, and metadata live in frontmatter; the body is the idea/spec.
 * Human-readable, editable, greppable, git-friendly.
 *
 * File layout:
 *   ~/.katulong/dispatch/f-<uuid>.md
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * Parse YAML-ish frontmatter from markdown.
 * Handles simple key: value, key: [array], and multiline body.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    // Parse arrays: [a, b, c]
    const arrMatch = val.match(/^\[([^\]]*)\]$/);
    if (arrMatch) {
      meta[key] = arrMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (val === "null" || val === "") {
      meta[key] = null;
    } else if (val === "true") {
      meta[key] = true;
    } else if (val === "false") {
      meta[key] = false;
    } else if (/^\d+$/.test(val)) {
      meta[key] = parseInt(val, 10);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: match[2].replace(/^\n+/, '') };
}

/**
 * Serialize frontmatter + body to markdown string.
 */
function toMarkdown(meta, body) {
  const lines = ["---"];
  for (const [key, val] of Object.entries(meta)) {
    if (val === null || val === undefined) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(", ")}]`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(body);
  return lines.join("\n");
}

/**
 * Create a dispatch store backed by markdown files in dataDir/dispatch/.
 */
export function createDispatchStore(dataDir) {
  const dir = join(dataDir, "dispatch");
  mkdirSync(dir, { recursive: true });

  function featurePath(id) {
    return join(dir, `${id}.md`);
  }

  function readFeature(id) {
    const path = featurePath(id);
    if (!existsSync(path)) return null;
    try {
      const content = readFileSync(path, "utf-8");
      const { meta, body } = parseFrontmatter(content);
      return { id, ...meta, body };
    } catch (err) {
      log.warn("Failed to read dispatch feature", { id, error: err.message });
      return null;
    }
  }

  function writeFeature(feature) {
    const { id, body, ...meta } = feature;
    meta.updated = new Date().toISOString();
    const content = toMarkdown(meta, body || "");
    writeFileSync(featurePath(id), content, "utf-8");
  }

  function listIds() {
    try {
      return readdirSync(dir)
        .filter((f) => f.startsWith("f-") && f.endsWith(".md"))
        .map((f) => f.slice(0, -3));
    } catch {
      return [];
    }
  }

  return {
    /**
     * Add a new raw feature idea.
     * @param {string} raw - The raw idea text
     * @param {string[]} [projects] - Optional project scoping
     * @returns {object} The created feature
     */
    addFeature(raw, projects) {
      const id = `f-${randomUUID()}`;
      const feature = {
        id,
        status: "raw",
        projects: Array.isArray(projects) && projects.length > 0 ? projects : null,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        body: raw,
      };
      writeFeature(feature);
      return feature;
    },

    /**
     * Get a feature by ID.
     */
    getFeature(id) {
      return readFeature(id);
    },

    /**
     * Update a feature by ID (shallow merge of metadata).
     */
    updateFeature(id, fields) {
      const existing = readFeature(id);
      if (!existing) return null;
      const updated = { ...existing, ...fields };
      writeFeature(updated);
      return updated;
    },

    /**
     * Delete a feature by ID.
     */
    deleteFeature(id) {
      const path = featurePath(id);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    },

    /**
     * List features, optionally filtered by status.
     */
    listFeatures(status) {
      const features = listIds().map(readFeature).filter(Boolean);
      if (status) return features.filter((f) => f.status === status);
      return features;
    },

    /**
     * Get all active features for a given project.
     */
    getActiveByProject(project) {
      return this.listFeatures("active").filter(
        (f) => f.projects && f.projects.includes(project)
      );
    },

    /**
     * Append a log entry to a feature's execution logs.
     */
    addLog(id, text) {
      const feature = readFeature(id);
      if (!feature) return;
      const logLine = `- ${new Date().toISOString().slice(11, 19)} ${text}`;
      feature.body = feature.body
        ? feature.body + "\n" + logLine
        : logLine;
      writeFeature(feature);
    },
  };
}
