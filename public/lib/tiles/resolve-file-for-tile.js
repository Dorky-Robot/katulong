/**
 * Shared resolver call for the document/image tile open paths.
 *
 * Two concrete consumers go through this helper:
 *   - `openFileInDocTile` in `public/app.js` — terminal file-link clicks
 *     and feed reply/thumbnail chips (relative paths, resolver also does
 *     cwd + worktree-fallback resolution).
 *   - `onFileOpen` in `public/lib/tile-renderers/file-browser.js` — file
 *     browser row clicks (paths are already absolute, but the resolver
 *     still returns the `worktreeLabel` so the tile's worktree badge
 *     lights up for files in sibling worktrees).
 *
 * Only the `/api/resolve-file` call and response normalization are
 * shared here. Each caller keeps its own try/catch because their
 * fallback strategies differ: the terminal path can still join against
 * the cached session cwd when the server is unreachable, file-browser
 * paths are absolute so there is nothing to join. Extract pushed any
 * further would have to carry a fallback strategy parameter, which is
 * more indirection than two 10-line callers justify.
 *
 * See `lib/worktree-resolver.js` and `docs/file-link-worktree-resolution.md`
 * for the server side.
 *
 * @param {{ get: (url: string) => Promise<any> }} api
 * @param {string} filePath  absolute or relative path the user clicked
 * @param {string | null} [sessionName]  scopes cwd lookup on the server
 * @returns {Promise<{ resolvedPath: string, worktreeLabel: string | null }>}
 */
export async function resolveFilePathForTile(api, filePath, sessionName) {
  if (typeof filePath !== "string" || !filePath) {
    return { resolvedPath: filePath || "", worktreeLabel: null };
  }
  const q = `path=${encodeURIComponent(filePath)}`
    + (sessionName ? `&session=${encodeURIComponent(sessionName)}` : "");
  const res = await api.get(`/api/resolve-file?${q}`);
  if (res && typeof res.absPath === "string" && res.absPath) {
    return {
      resolvedPath: res.absPath,
      worktreeLabel: res.worktreeLabel || null,
    };
  }
  return { resolvedPath: filePath, worktreeLabel: null };
}
