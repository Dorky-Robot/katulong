/**
 * WebAuthn Bridge for Dart interop
 *
 * Wraps @simplewebauthn/browser for use via dart:js_interop.
 * Loaded as an ES module — imports from self-hosted vendor ESM bundle.
 */
import {
  startRegistration,
  startAuthentication,
} from '/vendor/simplewebauthn/browser.esm.js';

window.webauthnBridge = {
  /**
   * Start WebAuthn registration ceremony.
   * @param {object} optionsJSON - PublicKeyCredentialCreationOptionsJSON from server
   * @returns {Promise<object>} Registration response to send back to server
   */
  async startRegistration(optionsJSON) {
    return startRegistration({ optionsJSON });
  },

  /**
   * Start WebAuthn authentication ceremony.
   * @param {object} optionsJSON - PublicKeyCredentialRequestOptionsJSON from server
   * @returns {Promise<object>} Authentication response to send back to server
   */
  async startAuthentication(optionsJSON) {
    return startAuthentication({ optionsJSON });
  },

  /**
   * Check if WebAuthn is supported in this browser.
   * @returns {boolean}
   */
  isSupported() {
    return !!(navigator.credentials && navigator.credentials.create && navigator.credentials.get);
  },
};
