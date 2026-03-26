/**
 * HTML Tile
 *
 * Renders HTML content inside a tile. Useful as a back-face for terminals,
 * for displaying dashboards, status pages, or any custom content.
 *
 * Usage:
 *   createTile("html", {
 *     title: "Status",
 *     icon: "chart-bar",
 *     html: "<h1>All systems go</h1>",
 *   })
 */

export function createHtmlTileFactory() {
  return function createHtmlTile({ title = "View", icon = "browser", html = "" } = {}) {
    let container = null;
    let contentDiv = null;

    return {
      type: "html",

      mount(el, ctx) {
        container = el;

        contentDiv = document.createElement("div");
        contentDiv.className = "html-tile-content";
        contentDiv.innerHTML = html;
        el.appendChild(contentDiv);

        if (ctx?.chrome?.toolbar) {
          ctx.chrome.toolbar.setTitle(title);
          // Add a flip-back button if this tile is on the back face
          ctx.chrome.toolbar.addButton({
            icon: "arrow-u-up-left",
            label: "Back to terminal",
            position: "right",
            onClick: () => ctx.flip(),
          });
        }
      },

      unmount() {
        contentDiv?.remove();
        contentDiv = null;
        container = null;
      },

      focus() {},
      blur() {},
      resize() {},

      getTitle() { return title; },
      getIcon() { return icon; },

      /** Update the HTML content in-place. */
      setContent(newHtml) {
        html = newHtml;
        if (contentDiv) contentDiv.innerHTML = newHtml;
      },

      serialize() {
        return { type: "html", title, icon, html };
      },
    };
  };
}
