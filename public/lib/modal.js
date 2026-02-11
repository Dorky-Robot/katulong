/**
 * Modal Manager Module
 *
 * Provides centralized modal management with consistent behavior:
 * - Keyboard handling (Esc to close)
 * - Backdrop dismiss (click outside to close)
 * - Focus management
 * - Animation handling
 */

/**
 * Manages a single modal instance
 */
export class ModalManager {
  /**
   * Creates a modal manager instance
   * @param {string} modalId - ID of the modal element (without -overlay suffix)
   * @param {Object} options - Configuration options
   * @param {Function} [options.onOpen] - Callback when modal opens
   * @param {Function} [options.onClose] - Callback when modal closes
   * @param {boolean} [options.closeOnEscape] - Allow Esc key to close (default: true)
   * @param {boolean} [options.closeOnBackdrop] - Allow backdrop click to close (default: true)
   * @param {HTMLElement} [options.returnFocus] - Element to focus when modal closes
   */
  constructor(modalId, options = {}) {
    this.modalId = modalId;
    this.overlay = document.getElementById(`${modalId}-overlay`) || document.getElementById(modalId);
    this.panel = document.getElementById(modalId);

    if (!this.overlay) {
      console.warn(`Modal overlay not found: ${modalId}-overlay or ${modalId}`);
    }

    this.options = {
      closeOnEscape: true,
      closeOnBackdrop: true,
      returnFocus: null,
      onOpen: null,
      onClose: null,
      ...options
    };

    this.isOpen = false;
    this._boundHandleEscape = this._handleEscape.bind(this);
    this._boundHandleBackdrop = this._handleBackdrop.bind(this);

    this._setupEventListeners();
  }

  /**
   * Opens the modal
   * @param {Object} openOptions - Options for this specific open call
   * @param {Function} [openOptions.onClose] - One-time close callback for this open
   */
  open(openOptions = {}) {
    if (this.isOpen || !this.overlay) return;

    this.isOpen = true;
    this._currentOnClose = openOptions.onClose;

    // Add visible class
    this.overlay.classList.add('visible');

    // Call onOpen callback
    if (this.options.onOpen) {
      this.options.onOpen();
    }

    // Enable keyboard handling
    if (this.options.closeOnEscape) {
      document.addEventListener('keydown', this._boundHandleEscape);
    }

    // Store currently focused element to return focus later
    this._previousFocus = document.activeElement;

    // Focus first focusable element in modal
    this._focusFirstElement();
  }

  /**
   * Closes the modal
   */
  close() {
    if (!this.isOpen || !this.overlay) return;

    this.isOpen = false;

    // Remove visible class
    this.overlay.classList.remove('visible');

    // Disable keyboard handling
    document.removeEventListener('keydown', this._boundHandleEscape);

    // Return focus to previous element or specified returnFocus
    const focusTarget = this.options.returnFocus || this._previousFocus;
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus();
    }

    // Call close callbacks
    if (this._currentOnClose) {
      this._currentOnClose();
      this._currentOnClose = null;
    }
    if (this.options.onClose) {
      this.options.onClose();
    }
  }

  /**
   * Toggles the modal open/closed
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  /**
   * Sets up event listeners for backdrop dismiss
   * @private
   */
  _setupEventListeners() {
    if (!this.overlay || !this.options.closeOnBackdrop) return;

    this.overlay.addEventListener('click', this._boundHandleBackdrop);
  }

  /**
   * Handles Escape key press
   * @private
   */
  _handleEscape(e) {
    if (e.key === 'Escape' && this.isOpen) {
      e.preventDefault();
      this.close();
    }
  }

  /**
   * Handles backdrop click
   * @private
   */
  _handleBackdrop(e) {
    // Only close if clicking directly on overlay (not on children)
    if (e.target === this.overlay) {
      this.close();
    }
  }

  /**
   * Focuses the first focusable element in the modal
   * @private
   */
  _focusFirstElement() {
    if (!this.panel) return;

    const focusableSelectors = [
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'a[href]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const firstFocusable = this.panel.querySelector(focusableSelectors);
    if (firstFocusable) {
      // Small delay to ensure modal is visible
      setTimeout(() => firstFocusable.focus(), 50);
    }
  }

  /**
   * Destroys the modal manager and cleans up event listeners
   */
  destroy() {
    if (this.isOpen) {
      this.close();
    }

    document.removeEventListener('keydown', this._boundHandleEscape);
    if (this.overlay) {
      this.overlay.removeEventListener('click', this._boundHandleBackdrop);
    }
  }
}

/**
 * Creates and manages multiple modals
 */
export class ModalRegistry {
  constructor() {
    this.modals = new Map();
  }

  /**
   * Registers a modal
   * @param {string} name - Unique name for the modal
   * @param {string} modalId - DOM ID of the modal
   * @param {Object} options - Modal options
   * @returns {ModalManager}
   */
  register(name, modalId, options = {}) {
    const modal = new ModalManager(modalId, options);
    this.modals.set(name, modal);
    return modal;
  }

  /**
   * Gets a registered modal
   * @param {string} name - Name of the modal
   * @returns {ModalManager|undefined}
   */
  get(name) {
    return this.modals.get(name);
  }

  /**
   * Opens a modal by name
   * @param {string} name - Name of the modal
   * @param {Object} options - Open options
   */
  open(name, options = {}) {
    const modal = this.modals.get(name);
    if (modal) {
      modal.open(options);
    } else {
      console.warn(`Modal not found: ${name}`);
    }
  }

  /**
   * Closes a modal by name
   * @param {string} name - Name of the modal
   */
  close(name) {
    const modal = this.modals.get(name);
    if (modal) {
      modal.close();
    }
  }

  /**
   * Closes all open modals
   */
  closeAll() {
    this.modals.forEach(modal => {
      if (modal.isOpen) {
        modal.close();
      }
    });
  }

  /**
   * Destroys all modals and cleans up
   */
  destroyAll() {
    this.modals.forEach(modal => modal.destroy());
    this.modals.clear();
  }
}
