/**
 * Token Form Manager
 *
 * Generic composable form manager for token creation.
 * Follows composition pattern with callbacks for actions.
 */
import { addCsrfHeader } from "./csrf.js";

/**
 * Create token form manager
 */
export function createTokenFormManager(options = {}) {
  const {
    onCreate,
    onRename,
    onRevoke,
    onError = (err) => alert(err)
  } = options;

  const elements = {
    form: null,
    nameInput: null,
    submitBtn: null,
    cancelBtn: null,
    createBtn: null
  };

  /**
   * Show token creation form
   */
  function showForm() {
    if (!elements.form || !elements.nameInput || !elements.createBtn) return;
    elements.form.style.display = "block";
    elements.nameInput.value = "";
    elements.nameInput.focus();
    elements.createBtn.style.display = "none";
  }

  /**
   * Hide token creation form
   */
  function hideForm() {
    if (!elements.form || !elements.createBtn) return;
    elements.form.style.display = "none";
    elements.createBtn.style.display = "block";
    if (elements.nameInput) elements.nameInput.value = "";
  }

  /**
   * Update submit button state based on input
   */
  function updateSubmitButtonState() {
    if (!elements.nameInput || !elements.submitBtn) return;
    elements.submitBtn.disabled = elements.nameInput.value.trim().length === 0;
  }

  /**
   * Handle form submission
   */
  async function handleSubmit() {
    if (!elements.nameInput || !elements.submitBtn) return;

    const name = elements.nameInput.value.trim();
    if (!name) return;

    // Disable button and show loading state
    elements.submitBtn.disabled = true;
    const originalText = elements.submitBtn.textContent;
    elements.submitBtn.textContent = "Generating...";

    try {
      const res = await fetch("/api/tokens", {
        method: "POST",
        headers: addCsrfHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name }),
      });

      if (!res.ok) throw new Error("Failed to create token");

      const data = await res.json();

      // Reset form
      hideForm();
      elements.submitBtn.textContent = originalText;

      // Notify parent via callback
      if (onCreate) onCreate(data);

    } catch (err) {
      if (onError) onError("Failed to create token: " + err.message);
      elements.submitBtn.disabled = false;
      elements.submitBtn.textContent = originalText;
    }
  }

  /**
   * Rename a token
   */
  async function renameToken(tokenId) {
    const newName = prompt("Enter new token name:");
    if (!newName || newName.trim().length === 0) return;

    try {
      const res = await fetch(`/api/tokens/${tokenId}`, {
        method: "PATCH",
        headers: addCsrfHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify({ name: newName.trim() }),
      });

      if (!res.ok) throw new Error("Failed to rename token");

      // Notify parent via callback
      if (onRename) onRename(tokenId, newName.trim());

    } catch (err) {
      if (onError) onError("Failed to rename token: " + err.message);
    }
  }

  /**
   * Revoke a token (and its linked credential)
   */
  async function revokeToken(tokenId, hasCredential = false, isOrphaned = false) {
    // Orphaned credentials go through the direct credential revocation endpoint
    if (isOrphaned) {
      return revokeCredential(tokenId); // tokenId is actually the credential ID for orphaned entries
    }

    const message = hasCredential
      ? "Are you sure you want to revoke this device? The device will immediately lose access and need to re-register."
      : "Are you sure you want to revoke this token? It will no longer work for device pairing.";

    if (!confirm(message)) return;

    try {
      const res = await fetch(`/api/tokens/${tokenId}`, {
        method: "DELETE",
        headers: addCsrfHeader({}),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to revoke token");
      }

      // Notify parent via callback
      if (onRevoke) onRevoke(tokenId);

    } catch (err) {
      if (onError) onError("Failed to revoke: " + err.message);
    }
  }

  /**
   * Revoke a credential directly (for orphaned credentials without setup tokens)
   */
  async function revokeCredential(credentialId) {
    const message = "Are you sure you want to revoke this device? The device will immediately lose access and need to re-register.";
    if (!confirm(message)) return;

    try {
      const res = await fetch(`/api/credentials/${credentialId}`, {
        method: "DELETE",
        headers: addCsrfHeader({}),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to revoke credential");
      }

      if (onRevoke) onRevoke(credentialId);

    } catch (err) {
      if (onError) onError("Failed to revoke: " + err.message);
    }
  }

  /**
   * Initialize form manager
   */
  function init(elementIds = {}) {
    const {
      formId = "token-create-form",
      nameInputId = "token-name-input",
      submitBtnId = "token-form-submit",
      cancelBtnId = "token-form-cancel",
      createBtnId = "settings-create-token"
    } = elementIds;

    // Get DOM elements
    elements.form = document.getElementById(formId);
    elements.nameInput = document.getElementById(nameInputId);
    elements.submitBtn = document.getElementById(submitBtnId);
    elements.cancelBtn = document.getElementById(cancelBtnId);
    elements.createBtn = document.getElementById(createBtnId);

    // Validate elements
    if (!elements.form || !elements.nameInput || !elements.submitBtn || !elements.cancelBtn || !elements.createBtn) {
      console.error("Token form elements not found:", {
        form: !!elements.form,
        nameInput: !!elements.nameInput,
        submitBtn: !!elements.submitBtn,
        cancelBtn: !!elements.cancelBtn,
        createBtn: !!elements.createBtn
      });
      return;
    }

    // Event: Show form when "Generate New Token" clicked
    elements.createBtn.addEventListener("click", showForm);

    // Event: Hide form when "Cancel" clicked
    elements.cancelBtn.addEventListener("click", hideForm);

    // Event: Update submit button state on input
    elements.nameInput.addEventListener("input", updateSubmitButtonState);

    // Event: Submit form
    elements.submitBtn.addEventListener("click", handleSubmit);

    // Event: Allow Enter key to submit
    elements.nameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && elements.nameInput.value.trim().length > 0) {
        handleSubmit();
      }
    });
  }

  /**
   * Cleanup event listeners
   */
  function unmount() {
    // Elements will be garbage collected, no explicit cleanup needed
    // since we're using the elements directly
  }

  return {
    init,
    unmount,
    renameToken,
    revokeToken,
    revokeCredential,
    showForm,
    hideForm
  };
}
