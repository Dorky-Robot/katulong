/**
 * Device Management Module
 *
 * Provides utilities for device identification and persistence using IndexedDB
 * with localStorage fallback. Used across app.js, login.js, and pair.js.
 */

/**
 * Opens the IndexedDB database for device configuration
 * @returns {Promise<IDBDatabase>}
 */
export async function openDeviceDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('katulong', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config');
      }
    };
  });
}

/**
 * Retrieves a value from IndexedDB
 * @param {string} key - The key to retrieve
 * @returns {Promise<any|null>} The stored value or null if not found/error
 */
export async function getFromIndexedDB(key) {
  try {
    const db = await openDeviceDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readonly');
      const store = tx.objectStore('config');
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return null;
  }
}

/**
 * Saves a value to IndexedDB
 * @param {string} key - The key to store under
 * @param {any} value - The value to store
 * @returns {Promise<void>}
 */
export async function saveToIndexedDB(key, value) {
  try {
    const db = await openDeviceDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite');
      const store = tx.objectStore('config');
      const request = store.put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch {
    // IndexedDB not available, localStorage fallback is primary
  }
}

/**
 * Gets or creates a stable device ID that persists across pairing methods
 * @returns {Promise<string>} UUID device identifier
 */
export async function getOrCreateDeviceId() {
  // Try localStorage first (fastest)
  let deviceId = localStorage.getItem('katulong_device_id');

  // Fallback to IndexedDB
  if (!deviceId) {
    deviceId = await getFromIndexedDB('deviceId');
    if (deviceId) {
      // Sync back to localStorage
      localStorage.setItem('katulong_device_id', deviceId);
    }
  }

  // Generate new ID if not found anywhere
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('katulong_device_id', deviceId);
    await saveToIndexedDB('deviceId', deviceId);
  }

  return deviceId;
}

/**
 * Generates a human-readable device name from the user agent
 * @returns {string} Device name (e.g., "iPhone (iOS 15)", "Chrome on Mac")
 */
export function generateDeviceName() {
  const ua = navigator.userAgent;

  // Mobile devices
  if (/iPhone/i.test(ua)) {
    const match = ua.match(/iPhone OS (\d+)/);
    return match ? `iPhone (iOS ${match[1]})` : 'iPhone';
  }
  if (/iPad/i.test(ua)) {
    return 'iPad';
  }
  if (/Android/i.test(ua)) {
    const match = ua.match(/Android (\d+)/);
    return match ? `Android ${match[1]}` : 'Android';
  }

  // Desktop browsers
  if (/Mac OS X/i.test(ua)) {
    if (/Chrome/i.test(ua)) return 'Chrome on Mac';
    if (/Firefox/i.test(ua)) return 'Firefox on Mac';
    if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return 'Safari on Mac';
    return 'Mac';
  }
  if (/Windows/i.test(ua)) {
    if (/Chrome/i.test(ua)) return 'Chrome on Windows';
    if (/Firefox/i.test(ua)) return 'Firefox on Windows';
    if (/Edge/i.test(ua)) return 'Edge on Windows';
    return 'Windows';
  }
  if (/Linux/i.test(ua)) {
    if (/Chrome/i.test(ua)) return 'Chrome on Linux';
    if (/Firefox/i.test(ua)) return 'Firefox on Linux';
    return 'Linux';
  }

  return 'Unknown Device';
}
