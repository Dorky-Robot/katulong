/**
 * CSRF Protection Utilities
 *
 * Generic helpers for CSRF token management.
 */

/**
 * Get CSRF token from meta tag
 */
export function getCsrfToken() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.content : null;
}

/**
 * Add CSRF token to headers
 */
export function addCsrfHeader(headers = {}) {
  const token = getCsrfToken();
  if (token) {
    headers['X-CSRF-Token'] = token;
  }
  return headers;
}
