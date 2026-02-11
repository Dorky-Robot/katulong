/**
 * Shared Utilities
 *
 * Reusable DOM helpers and utility functions used across the application.
 * Extracted from app.js to reduce duplication.
 */

/**
 * Create a DOM element with attributes and children.
 * @param {string} tag - HTML tag name
 * @param {Object} attrs - Element attributes (class, id, etc.)
 * @param {...(Node|string)} children - Child nodes or text
 * @returns {HTMLElement}
 *
 * @example
 * el('div', { class: 'modal', id: 'my-modal' },
 *   el('h2', {}, 'Title'),
 *   el('p', {}, 'Content')
 * )
 */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);

  // Set attributes
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') {
      element.className = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      // Event listeners (onclick, onchange, etc.)
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element.setAttribute(key, value);
    }
  }

  // Append children
  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  }

  return element;
}

/**
 * Create a button element with consistent styling.
 * @param {string} variant - Button variant (primary, danger, secondary, ghost)
 * @param {string} text - Button text content
 * @param {Function} onClick - Click handler
 * @param {Object} attrs - Additional attributes
 * @returns {HTMLButtonElement}
 *
 * @example
 * button('primary', 'Save', () => console.log('Saved'), { disabled: true })
 */
export function button(variant, text, onClick, attrs = {}) {
  const variantClass = {
    primary: 'btn--primary',
    danger: 'btn--danger',
    secondary: 'btn--secondary',
    ghost: 'btn--ghost'
  }[variant] || '';

  return el('button', {
    class: `btn ${variantClass}`,
    type: 'button',
    onclick: onClick,
    ...attrs
  }, text);
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str - String to escape
 * @returns {string} - HTML-safe string
 *
 * @example
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert("xss")&lt;/script&gt;'
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Format a timestamp as relative time (e.g., "2m ago", "3h ago").
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} - Formatted relative time
 *
 * @example
 * formatRelativeTime(Date.now() - 120000) // "2m ago"
 * formatRelativeTime(Date.now() - 7200000) // "2h ago"
 */
export function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Sleep for a specified duration.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 *
 * @example
 * await sleep(1000); // Wait 1 second
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Escape a string for use in an HTML attribute.
 * More strict than escapeHtml - also escapes quotes.
 * @param {string} str - String to escape
 * @returns {string} - Attribute-safe string
 *
 * @example
 * escapeAttr('value with "quotes" and <tags>')
 * // Returns: 'value with &quot;quotes&quot; and &lt;tags&gt;'
 */
export function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Debounce a function call.
 * @param {Function} fn - Function to debounce
 * @param {number} delay - Delay in milliseconds
 * @returns {Function} - Debounced function
 *
 * @example
 * const debouncedSearch = debounce((query) => search(query), 300);
 * input.addEventListener('input', (e) => debouncedSearch(e.target.value));
 */
export function debounce(fn, delay) {
  let timeoutId;
  return function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Throttle a function call.
 * @param {Function} fn - Function to throttle
 * @param {number} limit - Minimum time between calls in milliseconds
 * @returns {Function} - Throttled function
 *
 * @example
 * const throttledScroll = throttle(() => handleScroll(), 100);
 * window.addEventListener('scroll', throttledScroll);
 */
export function throttle(fn, limit) {
  let inThrottle;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}
