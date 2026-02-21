/**
 * Device Actions
 *
 * Generic composable device management actions.
 * Follows composition pattern with callbacks.
 */

import { addCsrfHeader } from "/lib/csrf.js";

/**
 * Create device actions manager
 */
export function createDeviceActions(options = {}) {
  const {
    onRename,
    onRemove,
    onError = (err) => alert(err)
  } = options;

  /**
   * Rename a device
   */
  async function renameDevice(deviceId) {
    const newName = prompt("Enter new device name:");
    if (!newName || newName.trim().length === 0) return;

    try {
      const res = await fetch(`/auth/devices/${deviceId}/name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });

      if (!res.ok) throw new Error("Failed to rename device");

      // Notify parent via callback
      if (onRename) onRename(deviceId, newName.trim());

    } catch (err) {
      if (onError) onError("Failed to rename device: " + err.message);
    }
  }

  /**
   * End session for a device (permanently removes credential and sessions)
   */
  async function removeDevice(deviceId, isCurrent) {
    // Different warning messages based on whether it's the current device
    const message = isCurrent
      ? "WARNING: You are about to END YOUR SESSION on THIS DEVICE (the one you're using right now).\n\nThis will PERMANENTLY REMOVE this device and you will need to re-register to access Katulong again.\n\nAre you sure you want to continue?"
      : "Are you sure you want to end this session? This will permanently remove this device and it will need to re-register to access Katulong again.";

    if (!confirm(message)) return;

    try {
      const res = await fetch(`/auth/devices/${deviceId}`, {
        method: "DELETE",
        headers: addCsrfHeader()
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to end session");
      }

      // If we removed the current device, we'll be logged out - redirect to login
      if (isCurrent) {
        window.location.href = "/login";
      } else {
        // Notify parent via callback
        if (onRemove) onRemove(deviceId);
      }

    } catch (err) {
      if (onError) onError("Failed to end session: " + err.message);
    }
  }

  return {
    renameDevice,
    removeDevice
  };
}
