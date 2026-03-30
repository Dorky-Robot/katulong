/**
 * Quick Input — Semi-transparent floating button that expands into
 * text input and image attach actions.
 *
 * Positioned in the terminal pane (like the joystick), visible on
 * touch devices only. Tapping it reveals two buttons:
 *   - Text: opens the dictation modal for typing + speech-to-text
 *   - Attach: opens the file picker for image upload
 */

/**
 * Create the quick input button and attach it to the terminal container.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - Parent element (terminal pane)
 * @param {Function} opts.onTextClick - Called when text button is tapped
 * @param {Function} opts.onAttachClick - Called when attach button is tapped
 */
export function createQuickInput({ container, onTextClick, onAttachClick }) {
  const el = document.createElement("div");
  el.id = "quick-input";
  el.innerHTML = '<i class="ph ph-pencil-simple"></i>';

  let expanded = false;
  let panel = null;

  function collapse() {
    if (!expanded) return;
    expanded = false;
    if (panel) { panel.remove(); panel = null; }
    el.innerHTML = '<i class="ph ph-pencil-simple"></i>';
  }

  function expand() {
    if (expanded) return;
    expanded = true;
    el.innerHTML = '<i class="ph ph-x"></i>';

    panel = document.createElement("div");
    panel.className = "quick-input-panel";

    const textBtn = document.createElement("button");
    textBtn.className = "quick-input-action";
    textBtn.innerHTML = '<i class="ph ph-keyboard"></i>';
    textBtn.setAttribute("aria-label", "Type text");
    textBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapse();
      if (onTextClick) onTextClick();
    });

    const attachBtn = document.createElement("button");
    attachBtn.className = "quick-input-action";
    attachBtn.innerHTML = '<i class="ph ph-image"></i>';
    attachBtn.setAttribute("aria-label", "Attach image");
    attachBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      collapse();
      if (onAttachClick) onAttachClick();
    });

    panel.appendChild(textBtn);
    panel.appendChild(attachBtn);
    el.appendChild(panel);
  }

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (expanded) collapse();
    else expand();
  });

  // Collapse when tapping elsewhere
  document.addEventListener("click", () => collapse());

  container.appendChild(el);

  return {
    el,
    collapse,
    expand,
  };
}
