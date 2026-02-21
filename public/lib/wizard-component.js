/**
 * Reactive Wizard Component
 *
 * Renders device pairing wizard views based on wizard store state.
 * Handles QR codes, countdowns, and status polling as side effects.
 */

import { createComponent } from '/lib/component.js';
import { WIZARD_STATES, WIZARD_ACTIONS } from '/lib/wizard-state.js';

/**
 * Create wizard component
 * @param {object} wizardStore - Wizard state store
 * @param {object} options - Component options
 * @param {Function} options.loadQRLib - Load QR code library
 * @param {Function} options.checkPairingStatus - Check if pairing consumed
 * @param {Function} options.onSuccess - Called when pairing succeeds
 * @returns {object} Component instance
 */
export function createWizardComponent(wizardStore, options) {
  const { loadQRLib, checkPairingStatus, onSuccess } = options;

  // Track active timers for cleanup
  let countdownInterval = null;
  let statusPollInterval = null;

  const render = (state) => {
    // Wizard is controlled by switching views via switchSettingsView()
    // This component just handles dynamic content within those views
    return ''; // Views are static HTML, we just update content
  };

  const afterRender = async (container, state) => {
    // Clean up old timers
    if (countdownInterval) clearInterval(countdownInterval);
    if (statusPollInterval) clearInterval(statusPollInterval);

    // Handle state-specific rendering
    switch (state.currentState) {
      case WIZARD_STATES.PAIRING:
        if (state.pairCode) {
          await renderPairingQR(state);
          setupCountdown(state);
          setupStatusPolling(state);
        }
        break;

      case WIZARD_STATES.ERROR:
        showError(state.errorMessage);
        break;

      default:
        break;
    }
  };

  /**
   * Render pairing QR code
   */
  async function renderPairingQR(state) {
    const qrContainer = document.getElementById("wizard-pair-qr");
    const copyBtn = document.getElementById("wizard-pair-copy-url");
    const pinEl = document.getElementById("wizard-pair-pin");
    if (!qrContainer || !copyBtn || !pinEl) return;

    qrContainer.innerHTML = "";
    copyBtn.style.display = "none";
    pinEl.textContent = state.pairPin || '';

    if (!state.pairUrl) return;

    try {
      await loadQRLib();
      const isDark = getEffectiveTheme() === "dark";

      QRCode.toCanvas(state.pairUrl, {
        width: 200,
        margin: 2,
        color: {
          dark: isDark ? "#cdd6f4" : "#4c4f69",
          light: isDark ? "#1e1e2e" : "#eff1f5"
        }
      }, (err, canvas) => {
        if (!err) {
          qrContainer.appendChild(canvas);
          copyBtn.style.display = "flex";
          copyBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(state.pairUrl);
              const originalText = copyBtn.innerHTML;
              copyBtn.innerHTML = '<i class="ph ph-check"></i> Copied!';
              setTimeout(() => { copyBtn.innerHTML = originalText; }, 2000);
            } catch {
              alert("Failed to copy URL");
            }
          };
        }
      });
    } catch (err) {
      console.error('[Wizard] Failed to render pairing QR:', err);
    }
  }

  /**
   * Set up countdown timer
   */
  function setupCountdown(state) {
    if (!state.expiresAt) return;

    const countdownEl = document.getElementById("wizard-pair-countdown");
    if (!countdownEl) return;

    function updateCountdown() {
      const left = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
      countdownEl.textContent = left > 0 ? `Refreshing in ${left}s` : "Refreshing…";
    }

    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 1000);
  }

  /**
   * Set up status polling for pairing completion
   */
  function setupStatusPolling(state) {
    if (!state.pairCode) return;

    const viewPair = document.getElementById("settings-view-pair");
    if (!viewPair) return;

    statusPollInterval = setInterval(async () => {
      // Stop polling if view is no longer active
      if (!viewPair.classList.contains("active")) {
        clearInterval(statusPollInterval);
        return;
      }

      try {
        const consumed = await checkPairingStatus(state.pairCode);
        if (consumed) {
          clearInterval(statusPollInterval);
          if (onSuccess) onSuccess();
        }
      } catch (err) {
        console.error('[Wizard] Status check failed:', err);
        clearInterval(statusPollInterval);
        wizardStore.dispatch({
          type: WIZARD_ACTIONS.PAIRING_ERROR,
          error: "Connection lost. Please try again."
        });
      }
    }, 2000);
  }

  /**
   * Show error message
   */
  function showError(message) {
    const errorEl = document.getElementById("wizard-error");
    if (!errorEl) return;

    if (message) {
      errorEl.textContent = message;
      errorEl.style.display = "block";
    } else {
      errorEl.style.display = "none";
      errorEl.textContent = "";
    }
  }

  /**
   * Get effective theme for QR code colors
   */
  function getEffectiveTheme() {
    const theme = localStorage.getItem('theme') || 'auto';
    if (theme !== 'auto') return theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Create and return component
  const component = createComponent(wizardStore, render, { afterRender });

  // Add cleanup method to clear timers
  const originalUnmount = component.unmount;
  component.unmount = function() {
    if (countdownInterval) clearInterval(countdownInterval);
    if (statusPollInterval) clearInterval(statusPollInterval);
    originalUnmount.call(this);
  };

  // Add manual trigger method for when component is not mounted
  // This allows afterRender to be called without mounting the component
  component.trigger = function() {
    const state = wizardStore.getState();
    afterRender(null, state);
  };

  return component;
}
