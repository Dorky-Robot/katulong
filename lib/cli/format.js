/**
 * CLI formatting utilities for table output and relative timestamps.
 */

/**
 * Format a table with column-aligned text output.
 */
export function formatTable(headers, rows) {
  if (rows.length === 0) {
    return headers.join("  ") + "\n(none)\n";
  }

  const widths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => Math.max(max, String(row[i] || "").length), 0);
    return Math.max(h.length, dataMax);
  });

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const separator = widths.map(w => "-".repeat(w)).join("  ");
  const dataLines = rows.map(row =>
    row.map((cell, i) => String(cell || "").padEnd(widths[i])).join("  ")
  );

  return [headerLine, separator, ...dataLines].join("\n") + "\n";
}

/**
 * Format a timestamp as relative time (e.g., "2h ago", "3d ago").
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp) return "never";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format an expiry timestamp (e.g., "6d", "12h", "expired").
 */
export function formatExpiry(timestamp) {
  if (!timestamp) return "none";
  const diff = timestamp - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
