/**
 * Phone Bar Renderer
 *
 * Renders the mobile shortcut bar: session button, new-session button,
 * spacer, and utility icon buttons (terminal, notes, files, etc.).
 *
 * Extracted from shortcut-bar.js for modularity.
 */

/**
 * Render the phone shortcut bar.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - The shortcut bar container element
 * @param {string} opts.sessionName - Currently active session name
 * @param {string} opts.sessionIcon - Icon class for the session (e.g. "terminal-window")
 * @param {Function} opts.onSessionClick
 * @param {Function} opts.showAddMenu - Show the "add session" dropdown
 * @param {Function} [opts.onTerminalClick]
 * @param {Function} [opts.onNotepadClick]
 * @param {Function} [opts.onFilesClick]
 * @param {Function} [opts.onPortForwardClick]
 * @param {Function} [opts.onSettingsClick]
 * @param {boolean}  opts.portProxyEnabled
 * @param {Array}    [opts.pluginButtons] - Array of { icon, label, click }
 */
export function renderPhoneBar(opts) {
  const {
    container,
    sessionName,
    sessionIcon,
    onSessionClick,
    showAddMenu,
    onTerminalClick,
    onNotepadClick,
    onFilesClick,
    onPortForwardClick,
    onSettingsClick,
    portProxyEnabled,
    pluginButtons,
  } = opts;

  const sessBtn = document.createElement("button");
  sessBtn.className = "session-btn";
  sessBtn.tabIndex = -1;
  sessBtn.setAttribute("aria-label", `Session: ${sessionName}`);
  const iconEl = document.createElement("i");
  iconEl.className = `ph ph-${sessionIcon}`;
  sessBtn.appendChild(iconEl);
  sessBtn.appendChild(document.createTextNode(" "));
  sessBtn.appendChild(document.createTextNode(sessionName));
  if (onSessionClick) {
    sessBtn.addEventListener("click", onSessionClick);
  }
  container.appendChild(sessBtn);

  const newSessBtn = document.createElement("button");
  newSessBtn.className = "bar-new-session-btn";
  newSessBtn.style.display = "flex";
  newSessBtn.tabIndex = -1;
  newSessBtn.setAttribute("aria-label", "New session");
  newSessBtn.innerHTML = '<i class="ph ph-plus"></i>';
  newSessBtn.addEventListener("click", () => showAddMenu(newSessBtn));
  container.appendChild(newSessBtn);

  const spacer = document.createElement("span");
  spacer.className = "bar-spacer";
  container.appendChild(spacer);

  const utils = [
    { icon: "terminal-window", label: "Terminal", click: onTerminalClick },
    { icon: "note-pencil", label: "Notes", click: onNotepadClick },
    { icon: "folder-open", label: "Files", click: onFilesClick },
    { icon: "plug", label: "Port Forward", click: onPortForwardClick, id: "bar-portfwd-btn", hidden: !portProxyEnabled },
    ...(pluginButtons || []).map(p => ({ icon: p.icon, label: p.label, click: p.click })),
    { icon: "gear", label: "Settings", click: onSettingsClick },
  ];
  for (const u of utils) {
    if (!u.click) continue;
    const btn = document.createElement("button");
    btn.className = "bar-icon-btn";
    btn.tabIndex = -1;
    btn.setAttribute("aria-label", u.label);
    btn.innerHTML = `<i class="ph ph-${u.icon}"></i>`;
    if (u.id) btn.id = u.id;
    if (u.hidden) btn.style.display = "none";
    btn.addEventListener("click", u.click);
    container.appendChild(btn);
  }
}
