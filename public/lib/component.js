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
 * Creates a derived component that depends on multiple stores
 * @param {Array} stores - Array of store instances
 * @param {Function} render - Render function: (...states) => HTML string
 * @returns {object} Component instance
 */
export function createDerivedComponent(stores, render) {
  let container = null;
  let unsubscribes = [];
  let mounted = false;

  const component = {
    mount(element) {
      if (mounted) {
        console.warn('[Component] Already mounted');
        return;
      }

      container = element;
      mounted = true;

      // Subscribe to all stores
      stores.forEach(store => {
        const unsub = store.subscribe(() => {
          if (mounted) {
            component.render();
          }
        });
        unsubscribes.push(unsub);
      });

      // Initial render
      component.render();
    },

    render() {
      if (!container || !mounted) return;

      const states = stores.map(store => store.getState());
      const html = render(...states);
      container.innerHTML = html;
    },

    unmount() {
      unsubscribes.forEach(unsub => unsub());
      unsubscribes = [];
      mounted = false;
      container = null;
    },

    isMounted() {
      return mounted;
    }
  };

  return component;
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

/**
 * Helper: Create event handler that works with innerHTML re-rendering
 * Usage: <button onclick="window.handleClick('arg')">
 */
export function registerGlobalHandler(name, handler) {
  window[name] = handler;
}
