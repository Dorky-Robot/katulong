/**
 * Shared DOM helper for the worktree badge rendered in document + image
 * tile headers. Extracted so both tiles stay byte-for-byte consistent —
 * any future tweak to the badge shape (icon prefix, truncation rules,
 * aria-label) lands once instead of twice.
 */

export function createWorktreeBadge(label) {
  const badge = document.createElement("span");
  badge.className = "tile-worktree-badge";
  badge.textContent = label;
  badge.title = `Worktree: ${label}`;
  return badge;
}
