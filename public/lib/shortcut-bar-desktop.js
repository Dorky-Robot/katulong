/**
 * Desktop Tab Bar Renderer
 *
 * Renders browser-like session tabs with close, drag-reorder support,
 * a [+] button for new sessions, and responsive tab shrinking.
 *
 * Extracted from shortcut-bar.js for modularity.
 */

/**
 * Render the desktop tab bar.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - The shortcut bar container element
 * @param {string} opts.sessionName - Currently active session name
 * @param {Array}  opts.sessions - Array of { name } session objects
 * @param {Function} opts.createTabEl - Factory: (session, isActive) => HTMLElement
 * @param {Function} opts.showAddMenu - Show the "add session" dropdown
 */
export function renderDesktopTabs(opts) {
  const { container, sessionName, sessions, createTabEl, showAddMenu } = opts;

  // + button sits outside the scroll area so it stays fixed during drag
  const addBtn = document.createElement("button");
  addBtn.className = "tab-bar-add";
  addBtn.tabIndex = -1;
  addBtn.setAttribute("aria-label", "New session");
  addBtn.innerHTML = '<i class="ph ph-plus-circle"></i>';
  addBtn.addEventListener("click", () => showAddMenu(addBtn));
  container.appendChild(addBtn);

  const tabScroll = document.createElement("div");
  tabScroll.className = "tab-scroll-area";

  for (const s of sessions) {
    tabScroll.appendChild(createTabEl(s, s.name === sessionName));
  }

  container.appendChild(tabScroll);

  // Shrink tabs to fit: progressively hide close buttons then labels
  // when there are too many tabs to fit at full width.
  requestAnimationFrame(() => {
    if (!tabScroll.isConnected) return;
    const areaWidth = tabScroll.clientWidth;
    const tabCount = sessions.length;
    if (tabCount === 0) return;
    const gap = parseFloat(getComputedStyle(tabScroll).gap) || 0;
    const availPerTab = (areaWidth - gap * (tabCount - 1)) / tabCount;

    // Thresholds (px): below these, hide elements to save space
    const HIDE_CLOSE = 5.5 * 16;  // ~88px — hide close button
    const ICON_ONLY = 3 * 16;     // ~48px — hide label, icon only

    if (availPerTab < ICON_ONLY) {
      tabScroll.classList.add("tabs-icon-only");
    } else if (availPerTab < HIDE_CLOSE) {
      tabScroll.classList.add("tabs-compact");
    }
  });
}
