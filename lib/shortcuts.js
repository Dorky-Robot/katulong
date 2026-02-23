/**
 * Shortcuts Management - Functional Core
 *
 * Handles parsing, validation, and serialization of keyboard shortcuts.
 * File I/O is handled by the caller (imperative shell).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Success, Failure } from "./result.js";

/**
 * Validate an already-parsed shortcuts array
 * @param {unknown} shortcuts - Value to validate
 * @returns {Success|Failure}
 */
export function validateShortcutsArray(shortcuts) {
  if (!Array.isArray(shortcuts)) {
    return new Failure("invalid-format", "Shortcuts must be an array");
  }

  for (const [index, shortcut] of shortcuts.entries()) {
    if (!shortcut || typeof shortcut !== "object") {
      return new Failure(
        "invalid-entry",
        `Entry at index ${index} is not an object`
      );
    }

    if (!shortcut.label || typeof shortcut.label !== "string") {
      return new Failure(
        "missing-label",
        `Entry at index ${index} is missing a valid label`
      );
    }

    if (!shortcut.keys || typeof shortcut.keys !== "string") {
      return new Failure(
        "missing-keys",
        `Entry at index ${index} is missing a valid keys field`
      );
    }
  }

  return new Success(shortcuts);
}

/**
 * Parse shortcuts JSON data
 * @param {string} jsonText - Raw JSON text
 * @returns {Success|Failure}
 */
export function parseShortcuts(jsonText) {
  try {
    const shortcuts = JSON.parse(jsonText);
    return validateShortcutsArray(shortcuts);
  } catch (err) {
    return new Failure("parse-error", err.message);
  }
}

/**
 * Serialize shortcuts to JSON string
 * @param {Array} shortcuts - Array of shortcut objects
 * @returns {string} Formatted JSON string
 */
export function serializeShortcuts(shortcuts) {
  return JSON.stringify(shortcuts, null, 2) + "\n";
}

/**
 * Load shortcuts from file
 * @param {string} filePath - Path to shortcuts file
 * @returns {Success|Failure}
 */
export function loadShortcuts(filePath) {
  try {
    if (!existsSync(filePath)) {
      return new Success([]);
    }

    const data = readFileSync(filePath, "utf-8");
    return parseShortcuts(data);
  } catch (err) {
    return new Failure("file-error", err.message);
  }
}

/**
 * Save shortcuts to file
 * @param {string} filePath - Path to shortcuts file
 * @param {Array} shortcuts - Array of shortcut objects to save
 * @returns {Success|Failure}
 */
export function saveShortcuts(filePath, shortcuts) {
  // Validate before saving
  const validation = validateShortcutsArray(shortcuts);
  if (!validation.success) {
    return validation;
  }

  try {
    const content = serializeShortcuts(shortcuts);
    writeFileSync(filePath, content, "utf-8");
    return new Success(shortcuts);
  } catch (err) {
    return new Failure("file-error", err.message);
  }
}

/**
 * Validate shortcut structure (pure function)
 * @param {object} shortcut - Shortcut object to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateShortcut(shortcut) {
  const errors = [];

  if (!shortcut || typeof shortcut !== "object") {
    errors.push("Shortcut must be an object");
    return { valid: false, errors };
  }

  if (!shortcut.label || typeof shortcut.label !== "string") {
    errors.push("Shortcut must have a string 'label' field");
  }

  if (!shortcut.keys || typeof shortcut.keys !== "string") {
    errors.push("Shortcut must have a string 'keys' field");
  }

  if (shortcut.label && shortcut.label.length > 50) {
    errors.push("Label must be 50 characters or less");
  }

  return { valid: errors.length === 0, errors };
}
