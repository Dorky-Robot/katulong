/**
 * Modal Initialization
 *
 * Register all application modals with the modal registry.
 */

/**
 * Initialize all modals
 */
export function initModals(modals, terminal) {
  // Shortcuts modal
  modals.register('shortcuts', 'shortcuts-overlay', {
    returnFocus: terminal,
    onClose: () => terminal.focus()
  });

  // Edit shortcuts modal
  modals.register('edit', 'edit-overlay', {
    returnFocus: terminal,
    onClose: () => terminal.focus()
  });

  // Add shortcut modal
  modals.register('add', 'add-modal', {
    returnFocus: terminal,
    onOpen: () => {
      // Focus the key composer input after modal opens
      const keyInput = document.getElementById("key-composer-input");
      if (keyInput) keyInput.focus();
    },
    onClose: () => terminal.focus()
  });

  // Session manager modal
  modals.register('session', 'session-overlay', {
    returnFocus: terminal,
    onClose: () => terminal.focus()
  });

  // Dictation modal
  modals.register('dictation', 'dictation-overlay', {
    returnFocus: terminal,
    onClose: () => terminal.focus()
  });

  // Settings modal
  modals.register('settings', 'settings-overlay', {
    returnFocus: terminal,
    onClose: () => terminal.focus()
  });
}
