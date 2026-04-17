/**
 * Claude narrator — pure helpers that walk a normalized Claude transcript
 * entry and pull out the bits the feed tile cares about.
 *
 * Right now that's just the files Claude touched — used by the feed
 * renderer to show clickable chips next to each reply. Earlier versions
 * of this module also asked Ollama for a one-line title per reply and
 * maintained a rolling narrative summary; both were removed once the
 * feed's "one flat reply per turn, no collapsing" UX made them
 * redundant.
 *
 * No I/O, no state, no broker coupling. The processor imports these and
 * decides what to do with the results.
 */

/**
 * Extract unique file paths touched by an assistant entry's tool_use
 * blocks. Read, Write, Edit, Grep, Glob, and plain `cd <path>` Bash
 * commands all count. Globs (paths containing `*`) are skipped because
 * they don't point at a single file the user can open.
 *
 * Returns an array of `{ path, line? }`, deduped by path (first line
 * wins). Line is only set for Read at an offset — the only tool whose
 * arguments carry one we can show.
 *
 * @param {{ tools?: Array<{name: string, input: object}> }} entry
 * @returns {Array<{ path: string, line?: number }>}
 */
export function extractFilesFromEntry(entry) {
  if (!entry || !Array.isArray(entry.tools) || entry.tools.length === 0) return [];
  const seen = new Map();

  function add(path, line) {
    if (typeof path !== "string" || !path) return;
    if (path.includes("*")) return;
    if (seen.has(path)) return;
    seen.set(path, typeof line === "number" && line > 0 ? line : undefined);
  }

  for (const t of entry.tools) {
    const input = t.input || {};
    switch (t.name) {
      case "Read":
        add(input.file_path, input.offset);
        break;
      case "Write":
      case "Edit":
        add(input.file_path);
        break;
      case "Grep":
      case "Glob":
        if (typeof input.path === "string") add(input.path);
        break;
      case "Bash": {
        const cmd = typeof input.command === "string" ? input.command : "";
        const m = cmd.match(/^\s*cd\s+["']?([^"';&|]+)/);
        if (m) add(m[1].trim());
        break;
      }
      default:
        break;
    }
  }
  return [...seen.entries()].map(([path, line]) =>
    line !== undefined ? { path, line } : { path }
  );
}

// Re-export readTranscriptEntries so callers that used to reach for the
// narrator-plus-reader combo still have a single "read a slice" door.
export { readTranscriptEntries } from "./claude-event-transform.js";
