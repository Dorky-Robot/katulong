/**
 * Session Manager
 *
 * Composable session management with SSH password utilities.
 */

import { api } from "/lib/api-client.js";

/**
 * Create session manager
 */
export function createSessionManager(options = {}) {
  const {
    modals,
    sessionStore,
    onSessionCreate,
    onError = (err) => console.error(err)
  } = options;

  let ac = null;

  const elements = {
    newNameInput: null,
    createBtn: null,
    pwInput: null,
    pwRevealBtn: null,
    pwCopyBtn: null
  };

  /**
   * Open session manager modal and load SSH password
   */
  async function openSessionManager(currentSessionName) {
    if (!modals) return;

    modals.open('session');

    // Invalidate sessions via callback
    if (onSessionCreate) onSessionCreate();

    // Fetch and populate SSH password
    try {
      const { password } = await api.get("/ssh/password");
      if (elements.pwInput) {
        elements.pwInput.value = password;
      }
    } catch {
      // Ignore - SSH might not be configured
    }
  }

  /**
   * Toggle SSH password visibility
   */
  function togglePasswordVisibility() {
    if (!elements.pwInput || !elements.pwRevealBtn) return;

    const icon = elements.pwRevealBtn.querySelector("i");
    if (!icon) return;

    if (elements.pwInput.type === "password") {
      elements.pwInput.type = "text";
      icon.className = "ph ph-eye-slash";
    } else {
      elements.pwInput.type = "password";
      icon.className = "ph ph-eye";
    }
  }

  /**
   * Copy SSH password to clipboard
   */
  async function copyPassword() {
    if (!elements.pwInput || !elements.pwCopyBtn) return;

    try {
      await navigator.clipboard.writeText(elements.pwInput.value);
      const originalHTML = elements.pwCopyBtn.innerHTML;
      const originalColor = elements.pwCopyBtn.style.color;

      elements.pwCopyBtn.innerHTML = '<i class="ph ph-check"></i>';
      elements.pwCopyBtn.style.color = "var(--success)";

      setTimeout(() => {
        elements.pwCopyBtn.innerHTML = originalHTML;
        elements.pwCopyBtn.style.color = originalColor;
      }, 1500);
    } catch (err) {
      // Clipboard not available - silent fail
    }
  }

  /**
   * Create a new session
   */
  async function createSession() {
    if (!elements.newNameInput) return;

    const name = elements.newNameInput.value.trim();
    if (!name) return;

    try {
      const data = await api.post("/sessions", { name });
      elements.newNameInput.value = "";
      window.open(`/?s=${encodeURIComponent(data.name)}`, "_blank");

      // Notify parent via callback
      if (onSessionCreate) onSessionCreate();
    } catch (err) {
      if (onError) onError(`Session create error: ${err.message}`);
    }
  }

  /**
   * Initialize session manager
   */
  function init(elementIds = {}) {
    const {
      newNameInputId = "session-new-name",
      createBtnId = "session-new-create",
      pwInputId = "ssh-password-value",
      pwRevealBtnId = "ssh-password-reveal",
      pwCopyBtnId = "ssh-password-copy"
    } = elementIds;

    if (ac) ac.abort();
    ac = new AbortController();
    const { signal } = ac;

    // Get DOM elements
    elements.newNameInput = document.getElementById(newNameInputId);
    elements.createBtn = document.getElementById(createBtnId);
    elements.pwInput = document.getElementById(pwInputId);
    elements.pwRevealBtn = document.getElementById(pwRevealBtnId);
    elements.pwCopyBtn = document.getElementById(pwCopyBtnId);

    // Event: SSH password reveal toggle
    if (elements.pwRevealBtn) {
      elements.pwRevealBtn.addEventListener("click", togglePasswordVisibility, { signal });
    }

    // Event: SSH password copy
    if (elements.pwCopyBtn) {
      elements.pwCopyBtn.addEventListener("click", copyPassword, { signal });
    }

    // Event: Create new session
    if (elements.createBtn) {
      elements.createBtn.addEventListener("click", createSession, { signal });
    }

    // Event: Allow Enter key to create session
    if (elements.newNameInput) {
      elements.newNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          createSession();
        }
      }, { signal });
    }
  }

  /**
   * Cleanup all event listeners
   */
  function unmount() {
    if (ac) { ac.abort(); ac = null; }
  }

  return {
    init,
    unmount,
    openSessionManager
  };
}
