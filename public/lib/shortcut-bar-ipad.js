/**
 * iPad Tab Bar Renderer
 *
 * Renders [+] button (absolute positioned) plus session tabs in a scroll area.
 *
 * Extracted from shortcut-bar.js for modularity.
 */

/**
 * Render the iPad tab bar.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - The shortcut bar container element
 * @param {string} opts.sessionName - Currently active session name
 * @param {Array}  opts.sessions - Array of { name } session objects
 * @param {Function} opts.createTabEl - Factory: (session, isActive) => HTMLElement
 * @param {Function} opts.showAddMenu - Show the "add session" dropdown
 */
export function renderIPadBar(opts) {
  const { container, sessionName, sessions, createTabEl, showAddMenu } = opts;

  // Tab row: [+] button + scrollable tabs
  const tabRow = document.createElement("div");
  tabRow.className = "bar-tab-row";

  const addBtn = document.createElement("button");
  addBtn.className = "ipad-add-btn";
  addBtn.tabIndex = -1;
  addBtn.setAttribute("aria-label", "New session");
  addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
  addBtn.addEventListener("click", () => showAddMenu(addBtn));
  tabRow.appendChild(addBtn);

  const tabArea = document.createElement("div");
  tabArea.className = "tab-scroll-area";
  for (const s of sessions) {
    tabArea.appendChild(createTabEl(s, s.name === sessionName));
  }
  tabRow.appendChild(tabArea);

  container.appendChild(tabRow);
}
