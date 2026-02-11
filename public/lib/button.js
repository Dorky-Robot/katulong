/**
 * Button Factory Module
 *
 * Provides utilities for creating buttons programmatically using the unified
 * button system (.btn base classes and variants).
 */

/**
 * Creates a button element with the unified button system classes
 * @param {Object} options - Button configuration
 * @param {string} options.variant - Button variant: 'primary', 'secondary', 'danger', 'ghost'
 * @param {string} options.size - Button size: 'sm', 'md' (default), 'lg'
 * @param {string} options.text - Button text content
 * @param {string} [options.icon] - Optional Phosphor icon class (e.g., 'ph-plus')
 * @param {Function} [options.onClick] - Click event handler
 * @param {boolean} [options.disabled] - Whether button is disabled
 * @param {boolean} [options.full] - Whether button should be full width
 * @param {string} [options.id] - Optional element ID
 * @param {string} [options.ariaLabel] - Optional ARIA label for accessibility
 * @returns {HTMLButtonElement}
 *
 * @example
 * const saveBtn = button({
 *   variant: 'primary',
 *   text: 'Save',
 *   icon: 'ph-check',
 *   onClick: () => save()
 * });
 */
export function button({
  variant = 'primary',
  size = 'md',
  text = '',
  icon = null,
  onClick = null,
  disabled = false,
  full = false,
  id = null,
  ariaLabel = null
}) {
  const btn = document.createElement('button');

  // Add base button class
  btn.className = 'btn';

  // Add variant class
  if (variant) {
    btn.classList.add(`btn--${variant}`);
  }

  // Add size class (skip 'md' as it's the default)
  if (size && size !== 'md') {
    btn.classList.add(`btn--${size}`);
  }

  // Add full width modifier
  if (full) {
    btn.classList.add('btn--full');
  }

  // Add icon if provided
  if (icon) {
    const iconEl = document.createElement('i');
    iconEl.className = `ph ${icon}`;
    btn.appendChild(iconEl);
  }

  // Add text content
  if (text) {
    btn.appendChild(document.createTextNode(text));
  }

  // Set optional attributes
  if (id) btn.id = id;
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  if (disabled) btn.disabled = true;

  // Attach click handler
  if (onClick) {
    btn.addEventListener('click', onClick);
  }

  return btn;
}

/**
 * Creates an icon-only button (square shape, no text)
 * @param {Object} options - Button configuration
 * @param {string} options.icon - Phosphor icon class (required, e.g., 'ph-x')
 * @param {string} [options.variant] - Button variant
 * @param {string} [options.size] - Button size
 * @param {Function} [options.onClick] - Click event handler
 * @param {string} [options.ariaLabel] - ARIA label (required for accessibility)
 * @returns {HTMLButtonElement}
 *
 * @example
 * const closeBtn = iconButton({
 *   icon: 'ph-x',
 *   variant: 'secondary',
 *   ariaLabel: 'Close modal',
 *   onClick: () => closeModal()
 * });
 */
export function iconButton({
  icon,
  variant = 'secondary',
  size = 'md',
  onClick = null,
  ariaLabel = 'Button'
}) {
  if (!icon) {
    throw new Error('iconButton requires an icon');
  }

  const btn = button({
    variant,
    size,
    icon,
    text: '',
    onClick,
    ariaLabel
  });

  btn.classList.add('btn--icon-only');

  return btn;
}

/**
 * Creates a danger button (for destructive actions like delete)
 * Convenience wrapper around button() with variant='danger'
 * @param {Object} options - Button configuration
 * @returns {HTMLButtonElement}
 */
export function dangerButton(options) {
  return button({ ...options, variant: 'danger' });
}

/**
 * Creates a primary action button
 * Convenience wrapper around button() with variant='primary'
 * @param {Object} options - Button configuration
 * @returns {HTMLButtonElement}
 */
export function primaryButton(options) {
  return button({ ...options, variant: 'primary' });
}

/**
 * Creates a secondary button
 * Convenience wrapper around button() with variant='secondary'
 * @param {Object} options - Button configuration
 * @returns {HTMLButtonElement}
 */
export function secondaryButton(options) {
  return button({ ...options, variant: 'secondary' });
}
