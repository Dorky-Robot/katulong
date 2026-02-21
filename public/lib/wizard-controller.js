/**
 * Wizard Controller
 *
 * Composable wizard control with view transitions and event handlers.
 */

import { WIZARD_ACTIONS } from "/lib/wizard-state.js";
import { addCsrfHeader } from "/lib/csrf.js";

/**
 * Create wizard controller
 */
export function createWizardController(options = {}) {
  const {
    wizardStore,
    settingsViews,
    viewMain,
    viewPair,
    viewSuccess,
    deviceStore,
    modals,
    onDeviceInvalidate
  } = options;

  /**
   * Switch settings view with animation
   */
  function switchSettingsView(toView) {
    if (!settingsViews || !toView) return;

    const current = settingsViews.querySelector(".settings-view.active");
    if (current === toView) return;

    // Measure target height
    toView.style.position = "relative";
    toView.style.visibility = "hidden";
    toView.style.opacity = "0";
    toView.classList.add("active");
    const targetHeight = toView.scrollHeight;
    toView.classList.remove("active");
    toView.style.position = "";
    toView.style.visibility = "";
    toView.style.opacity = "";

    // Animate wrapper height
    settingsViews.style.height = (current ? current.scrollHeight : 0) + "px";
    requestAnimationFrame(() => {
      settingsViews.style.height = targetHeight + "px";
    });

    // Cross-fade
    if (current) current.classList.remove("active");
    toView.classList.add("active");

    // Clear explicit height after transition
    const onEnd = () => {
      settingsViews.style.height = "";
      settingsViews.removeEventListener("transitionend", onEnd);
    };
    settingsViews.addEventListener("transitionend", onEnd);
  }

  /**
   * Start pairing step
   */
  async function startPairingStep() {
    if (!wizardStore) return;

    try {
      const res = await fetch("/auth/pair/start", {
        method: "POST",
        headers: addCsrfHeader()
      });

      if (!res.ok) return;

      const data = await res.json();

      wizardStore.dispatch({
        type: WIZARD_ACTIONS.START_PAIRING,
        code: data.code,
        pin: data.pin,
        url: data.url,
        expiresAt: data.expiresAt
      });
    } catch (err) {
      console.error('[Wizard] Failed to start pairing:', err);
      wizardStore.dispatch({
        type: WIZARD_ACTIONS.PAIRING_ERROR,
        error: "Failed to generate pairing code"
      });
    }
  }

  /**
   * Cleanup wizard state
   */
  function cleanupWizard() {
    if (!wizardStore) return;
    wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
    switchSettingsView(viewMain);
  }

  /**
   * Initialize wizard controller with event handlers
   */
  function init(elementIds = {}) {
    const {
      pairLanBtnId = "settings-pair-lan",
      wizardBackPairBtnId = "wizard-back-pair",
      wizardDoneBtnId = "wizard-done"
    } = elementIds;

    // Event: Pair Device → step 1 (pair)
    const pairLanBtn = document.getElementById(pairLanBtnId);
    if (pairLanBtn) {
      pairLanBtn.addEventListener("click", async () => {
        switchSettingsView(viewPair);
        await startPairingStep();
      });
    }

    // Event: Back from pair → main
    const wizardBackPairBtn = document.getElementById(wizardBackPairBtnId);
    if (wizardBackPairBtn) {
      wizardBackPairBtn.addEventListener("click", () => {
        if (wizardStore) wizardStore.dispatch({ type: WIZARD_ACTIONS.RESET });
        switchSettingsView(viewMain);
      });
    }

    // Event: Done → cleanup + show Remote tab (devices list is there now)
    const wizardDoneBtn = document.getElementById(wizardDoneBtnId);
    if (wizardDoneBtn) {
      wizardDoneBtn.addEventListener("click", () => {
        cleanupWizard();
        switchSettingsView(viewMain);

        // Switch to Remote tab to show newly paired device
        const remoteTab = document.querySelector('.settings-tab[data-tab="remote"]');
        if (remoteTab) remoteTab.click();
      });
    }

    // Update settings modal to include cleanup on close
    if (modals) {
      const settingsModal = modals.get('settings');
      if (settingsModal) {
        const originalOnClose = settingsModal.options.onClose;
        settingsModal.options.onClose = () => {
          cleanupWizard();
          if (originalOnClose) originalOnClose();
        };
      }
    }
  }

  return {
    init,
    switchSettingsView,
    startPairingStep,
    cleanupWizard
  };
}
