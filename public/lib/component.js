/**
 * Lightweight Component Pattern
 *
 * Provides reactive UI updates without a framework.
 * Components automatically re-render when their store changes.
 */

/**
 * Creates a reactive component that subscribes to a store
 * @param {object} store - Store instance with getState() and subscribe()
 * @param {Function} render - Render function: (state) => HTML string
 * @param {object} options - Component options
 * @param {Function} options.afterRender - Called after each render with (container, state)
 * @returns {object} Component instance with mount/unmount methods
 */
export function createComponent(store, render, options = {}) {
  let container = null;
  let unsubscribe = null;
  let mounted = false;
  const { afterRender } = options;

  return {
    /**
     * Mount component to a DOM element
     * @param {HTMLElement} element - Container element
     */
    mount(element) {
      if (mounted) {
        console.warn('[Component] Already mounted');
        return;
      }

      container = element;
      mounted = true;

      // Subscribe to store changes
      unsubscribe = store.subscribe(() => {
        if (mounted) {
          this.render();
        }
      });

      // Initial render
      this.render();
    },

    /**
     * Manually trigger a re-render
     */
    render() {
      if (!container || !mounted) return;

      const state = store.getState();
      const html = render(state);

      // Simple innerHTML replacement (can be optimized with morphdom later)
      container.innerHTML = html;

      // Run side effects after render (QR codes, event handlers, etc.)
      if (afterRender) {
        afterRender(container, state);
      }
    },

    /**
     * Unmount component and clean up subscriptions
     */
    unmount() {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      mounted = false;
      container = null;
    },

    /**
     * Check if component is mounted
     */
    isMounted() {
      return mounted;
    },

    /**
     * Get the container element
     */
    getContainer() {
      return container;
    }
  };
}

/**
 * Helper: Safely escape HTML to prevent XSS
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

