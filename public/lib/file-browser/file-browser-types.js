/**
 * File Browser Types
 *
 * Extension → kind string mapping and icon helpers.
 */

const EXT_ICONS = {
  // Folders
  directory: "\u{1F4C1}",
  // Images
  ".png": "\u{1F5BC}", ".jpg": "\u{1F5BC}", ".jpeg": "\u{1F5BC}",
  ".gif": "\u{1F5BC}", ".svg": "\u{1F5BC}", ".webp": "\u{1F5BC}",
  ".ico": "\u{1F5BC}",
  // Code
  ".js": "\u{1F4DD}", ".ts": "\u{1F4DD}", ".jsx": "\u{1F4DD}", ".tsx": "\u{1F4DD}",
  ".py": "\u{1F4DD}", ".rb": "\u{1F4DD}", ".go": "\u{1F4DD}", ".rs": "\u{1F4DD}",
  ".html": "\u{1F4DD}", ".css": "\u{1F4DD}", ".sh": "\u{1F4DD}",
  // Documents
  ".pdf": "\u{1F4C4}", ".doc": "\u{1F4C4}", ".docx": "\u{1F4C4}",
  ".xls": "\u{1F4C4}", ".xlsx": "\u{1F4C4}",
  // Archives
  ".zip": "\u{1F4E6}", ".tar": "\u{1F4E6}", ".gz": "\u{1F4E6}",
  ".dmg": "\u{1F4E6}", ".pkg": "\u{1F4E6}",
  // Media
  ".mp3": "\u{1F3B5}", ".mp4": "\u{1F3AC}", ".mov": "\u{1F3AC}",
  // Config
  ".json": "\u{2699}", ".yaml": "\u{2699}", ".yml": "\u{2699}",
  ".toml": "\u{2699}", ".ini": "\u{2699}", ".env": "\u{2699}",
  // Text
  ".txt": "\u{1F4C4}", ".md": "\u{1F4C4}", ".log": "\u{1F4C4}",
};

/**
 * Get emoji icon for a file entry.
 */
export function getFileIcon(entry) {
  if (entry.type === "directory") return EXT_ICONS.directory;
  const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop().toLowerCase() : "";
  return EXT_ICONS[ext] || "\u{1F4C4}";
}

/**
 * Format file size for display.
 */
export function formatSize(bytes) {
  if (bytes === 0) return "\u2014";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format date for display.
 */
export function formatDate(isoString) {
  if (!isoString) return "\u2014";
  const d = new Date(isoString);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
