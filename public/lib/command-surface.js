/**
 * Command surface — the bar contents shown when command mode is active.
 *
 * Mounts as a sibling inside #shortcut-bar so it shares the slot with
 * <tile-tab-bar> + #key-island. CSS fades the existing bar children
 * out and this surface in (see #shortcut-bar selectors in index.html).
 *
 * Rendered state comes from a command-mode subscription: the surface is
 * passive and just draws what the walker is on. Each child of the
 * current node becomes a key pill. The breadcrumb shows how deep we
 * are so the user can read the chord they've typed.
 */

export const COMMAND_SURFACE_CLASS = "command-surface";

export function createCommandSurface({ mountIn, mode }) {
  if (!mountIn) throw new Error("createCommandSurface: mountIn required");

  const el = document.createElement("div");
  el.className = COMMAND_SURFACE_CLASS;
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Command mode menu");

  const crumb = document.createElement("span");
  crumb.className = "command-surface-crumb";
  el.appendChild(crumb);

  const pills = document.createElement("span");
  pills.className = "command-surface-pills";
  el.appendChild(pills);

  const exitHint = document.createElement("span");
  exitHint.className = "command-surface-exit";
  el.appendChild(exitHint);

  mountIn.appendChild(el);

  function keyLabel(child) {
    if (child.key === " ") return "␣";
    return child.key;
  }

  function render({ active, node }) {
    if (!active || !node) {
      crumb.textContent = "";
      pills.innerHTML = "";
      exitHint.textContent = "";
      return;
    }

    // Breadcrumb. Root shows "Command"; deeper nodes show "Command › <label>".
    crumb.textContent = node.label === "root"
      ? "Command"
      : `Command › ${node.label}`;

    pills.innerHTML = "";
    const children = node.children || [];
    for (const child of children) {
      const pill = document.createElement("span");
      pill.className = "command-surface-pill";

      const kbd = document.createElement("kbd");
      kbd.textContent = keyLabel(child);
      pill.appendChild(kbd);

      const label = document.createElement("span");
      label.className = "command-surface-pill-label";
      label.textContent = child.label;
      pill.appendChild(label);

      pills.appendChild(pill);
    }

    exitHint.textContent = node.label === "root"
      ? "Esc to exit"
      : "Backspace ← · Esc to exit";
  }

  const unsubscribe = mode?.subscribe
    ? mode.subscribe(render)
    : null;

  // Initial paint — mode may already be active (e.g. hot-reload).
  if (mode?.isActive && mode.isActive()) {
    render({ active: true, node: mode.getNode?.() });
  }

  return {
    element: el,
    destroy() {
      if (unsubscribe) unsubscribe();
      el.remove();
    },
  };
}
