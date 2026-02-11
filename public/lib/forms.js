/**
 * Forms Module
 *
 * Provides utilities for handling common form submission patterns, particularly
 * button state management and error handling during async operations.
 */

/**
 * Wraps an async function with button state management
 * Disables the button during execution, re-enables in finally block,
 * and handles error display.
 *
 * @param {HTMLButtonElement} button - Button to disable during execution
 * @param {HTMLElement|null} errorElement - Element to display errors (optional)
 * @param {Function} asyncFn - Async function to execute
 * @returns {Promise<any>} Result of asyncFn
 *
 * @example
 * await withButtonState(submitBtn, errorDiv, async () => {
 *   const res = await fetch('/api/submit', {
 *     method: 'POST',
 *     body: JSON.stringify(data)
 *   });
 *   if (!res.ok) throw new Error('Submit failed');
 *   return await res.json();
 * });
 */
export async function withButtonState(button, errorElement, asyncFn) {
  button.disabled = true;
  if (errorElement) {
    errorElement.textContent = "";
  }

  try {
    return await asyncFn();
  } catch (err) {
    if (errorElement) {
      errorElement.textContent = err.message || "An error occurred";
    }
    throw err; // Re-throw to allow caller to handle
  } finally {
    button.disabled = false;
  }
}

/**
 * Helper for JSON API calls with error handling
 * Automatically handles response.ok checks and JSON parsing
 *
 * @param {string} url - API endpoint
 * @param {Object} options - fetch options (method, body, etc.)
 * @param {string} [fallbackError] - Fallback error message if response doesn't include one
 * @returns {Promise<any>} Parsed JSON response
 *
 * @example
 * const data = await fetchJSON('/api/login', {
 *   method: 'POST',
 *   body: JSON.stringify({ username, password })
 * });
 */
export async function fetchJSON(url, options = {}, fallbackError = "Request failed") {
  // Ensure Content-Type header is set for JSON requests
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers
  });

  if (!res.ok) {
    let errorMsg = fallbackError;
    try {
      const err = await res.json();
      errorMsg = err.error || fallbackError;
    } catch {
      // If JSON parsing fails, use status text
      errorMsg = `${fallbackError} (${res.status} ${res.statusText})`;
    }
    throw new Error(errorMsg);
  }

  return await res.json();
}

/**
 * Combines button state management with JSON API call
 * Common pattern for form submissions
 *
 * @param {HTMLButtonElement} button - Button to disable during execution
 * @param {HTMLElement|null} errorElement - Element to display errors
 * @param {string} url - API endpoint
 * @param {Object} data - Data to send (will be JSON stringified)
 * @param {string} [fallbackError] - Fallback error message
 * @returns {Promise<any>} Parsed JSON response
 *
 * @example
 * const result = await submitForm(
 *   submitBtn,
 *   errorDiv,
 *   '/api/save',
 *   { name: 'John', email: 'john@example.com' }
 * );
 */
export async function submitForm(button, errorElement, url, data, fallbackError = "Submission failed") {
  return await withButtonState(button, errorElement, async () => {
    return await fetchJSON(url, {
      method: "POST",
      body: JSON.stringify(data)
    }, fallbackError);
  });
}

/**
 * Sets a loading message on an element, useful for showing progress
 * @param {HTMLElement} element - Element to update
 * @param {string} message - Loading message to display
 */
export function setLoadingMessage(element, message = "Loading...") {
  if (element) {
    element.textContent = message;
  }
}

/**
 * Clears an error/status message
 * @param {HTMLElement} element - Element to clear
 */
export function clearMessage(element) {
  if (element) {
    element.textContent = "";
  }
}
