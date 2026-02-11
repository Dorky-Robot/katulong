/**
 * List Renderer Module
 *
 * Provides reusable list rendering with automatic event delegation,
 * empty states, loading states, and consistent update patterns.
 */

/**
 * Renders and manages a list of items with automatic event handling
 */
export class ListRenderer {
  /**
   * Creates a list renderer instance
   * @param {HTMLElement} container - Container element for the list
   * @param {Object} options - Configuration options
   * @param {Function} options.itemTemplate - Function that returns HTML string for an item
   * @param {string} [options.emptyState] - HTML to show when list is empty
   * @param {string} [options.loadingState] - HTML to show while loading
   * @param {Function} [options.onAction] - Callback for action button clicks
   * @param {string} [options.itemClass] - CSS class for list items
   * @param {Function} [options.beforeRender] - Hook called before rendering
   * @param {Function} [options.afterRender] - Hook called after rendering
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      emptyState: '<div class="empty-state">No items</div>',
      loadingState: '<div class="loading-state">Loading...</div>',
      itemClass: 'list-item',
      onAction: null,
      beforeRender: null,
      afterRender: null,
      ...options
    };

    if (!this.options.itemTemplate) {
      throw new Error('ListRenderer requires itemTemplate function');
    }

    this.data = [];
    this.isLoading = false;
    this._setupEventDelegation();
  }

  /**
   * Renders the list with the given items
   * @param {Array} items - Array of items to render
   */
  render(items) {
    this.data = items;

    // Call beforeRender hook
    if (this.options.beforeRender) {
      this.options.beforeRender(items);
    }

    // Show loading state
    if (this.isLoading) {
      this.container.innerHTML = this.options.loadingState;
      return;
    }

    // Show empty state
    if (!items || items.length === 0) {
      this.container.innerHTML = this.options.emptyState;
      return;
    }

    // Render items
    try {
      const html = items
        .map((item, index) => this.options.itemTemplate(item, index))
        .join('');
      this.container.innerHTML = html;
    } catch (err) {
      console.error('ListRenderer: Error rendering items', err);
      this.container.innerHTML = '<div class="error-state">Error rendering list</div>';
      return;
    }

    // Call afterRender hook
    if (this.options.afterRender) {
      this.options.afterRender(items);
    }
  }

  /**
   * Updates a single item by index
   * @param {number} index - Index of item to update
   * @param {Object} newData - New data for the item
   */
  update(index, newData) {
    if (index < 0 || index >= this.data.length) {
      console.warn('ListRenderer: Invalid index for update', index);
      return;
    }

    this.data[index] = { ...this.data[index], ...newData };
    this.render(this.data);
  }

  /**
   * Removes an item by index
   * @param {number} index - Index of item to remove
   */
  remove(index) {
    if (index < 0 || index >= this.data.length) {
      console.warn('ListRenderer: Invalid index for remove', index);
      return;
    }

    this.data.splice(index, 1);
    this.render(this.data);
  }

  /**
   * Adds an item to the list
   * @param {Object} item - Item to add
   * @param {number} [index] - Optional index to insert at (defaults to end)
   */
  add(item, index) {
    if (index !== undefined && index >= 0 && index <= this.data.length) {
      this.data.splice(index, 0, item);
    } else {
      this.data.push(item);
    }
    this.render(this.data);
  }

  /**
   * Clears all items
   */
  clear() {
    this.data = [];
    this.render([]);
  }

  /**
   * Sets loading state
   * @param {boolean} loading - Whether list is loading
   */
  setLoading(loading) {
    this.isLoading = loading;
    if (loading) {
      this.container.innerHTML = this.options.loadingState;
    } else {
      this.render(this.data);
    }
  }

  /**
   * Gets current data
   * @returns {Array} Current list data
   */
  getData() {
    return [...this.data];
  }

  /**
   * Finds an item by predicate
   * @param {Function} predicate - Function to test each item
   * @returns {Object|undefined} First matching item
   */
  find(predicate) {
    return this.data.find(predicate);
  }

  /**
   * Filters items by predicate and re-renders
   * @param {Function} predicate - Function to test each item
   */
  filter(predicate) {
    const filtered = this.data.filter(predicate);
    this.render(filtered);
  }

  /**
   * Sets up event delegation for action buttons
   * @private
   */
  _setupEventDelegation() {
    if (!this.options.onAction) return;

    this.container.addEventListener('click', (e) => {
      // Find closest element with data-action attribute
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;

      const action = actionBtn.dataset.action;
      const id = actionBtn.dataset.id;
      const index = actionBtn.dataset.index;

      // Prevent default button behavior
      e.preventDefault();

      // Call action handler with context
      this.options.onAction({
        action,
        id,
        index: index !== undefined ? parseInt(index, 10) : undefined,
        element: actionBtn,
        event: e,
        item: index !== undefined ? this.data[parseInt(index, 10)] : undefined
      });
    });
  }

  /**
   * Destroys the list renderer and cleans up
   */
  destroy() {
    this.container.innerHTML = '';
    this.data = [];
  }
}

/**
 * Creates a simple list renderer with common defaults
 * @param {HTMLElement} container - Container element
 * @param {Function} itemTemplate - Template function
 * @param {Function} onAction - Action handler
 * @returns {ListRenderer}
 */
export function createList(container, itemTemplate, onAction) {
  return new ListRenderer(container, {
    itemTemplate,
    onAction
  });
}
