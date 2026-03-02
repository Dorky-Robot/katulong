/**
 * Session Manager
 *
 * SSH password reveal/copy utilities for the session sidebar.
 */

/**
 * Create session manager for SSH password UI
 */
export function createSessionManager() {
  let ac = null;

  const elements = {
    pwInput: null,
    pwRevealBtn: null,
    pwCopyBtn: null
  };

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
    } catch {
      // Clipboard not available
    }
  }

  function init() {
    if (ac) ac.abort();
    ac = new AbortController();
    const { signal } = ac;

    elements.pwInput = document.getElementById("ssh-password-value");
    elements.pwRevealBtn = document.getElementById("ssh-password-reveal");
    elements.pwCopyBtn = document.getElementById("ssh-password-copy");

    if (elements.pwRevealBtn) {
      elements.pwRevealBtn.addEventListener("click", togglePasswordVisibility, { signal });
    }
    if (elements.pwCopyBtn) {
      elements.pwCopyBtn.addEventListener("click", copyPassword, { signal });
    }
  }

  function unmount() {
    if (ac) { ac.abort(); ac = null; }
  }

  return { init, unmount };
}
