/**
 * Session State — single owner of "which session is focused"
 *
 * Manages: state.session.name, URL ?s= parameter, document.title.
 * All code that needs to know or change the current session goes through here.
 */

const DEFAULT_TITLE = "katulong";

export function createSessionState() {
  let currentName = new URLSearchParams(location.search).get("s") || null;

  if (currentName) document.title = currentName;

  /** Get the current session name. */
  function get() {
    return currentName;
  }

  /**
   * Set the current session name (replaceState — no history entry).
   * Pass null to clear.
   */
  function set(name) {
    currentName = name || null;
    document.title = currentName || DEFAULT_TITLE;
    const url = new URL(window.location);
    if (currentName) {
      url.searchParams.set("s", currentName);
    } else {
      url.searchParams.delete("s");
    }
    history.replaceState(null, "", url);
  }

  /**
   * Navigate to a session (pushState — creates a history entry).
   */
  function push(name) {
    currentName = name;
    document.title = name;
    const url = new URL(window.location);
    url.searchParams.set("s", name);
    history.pushState(null, "", url);
  }

  /**
   * Read the session name from the current URL (for popstate handling).
   */
  function fromUrl() {
    return new URLSearchParams(location.search).get("s") || null;
  }

  return { get, set, push, fromUrl };
}
