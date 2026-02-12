/**
 * Reactive Device List Component
 *
 * Auto-updates when device store changes.
 * Eliminates manual loadDevices() calls.
 */

import { createComponent, escapeHtml } from '/lib/component.js';
import { ListRenderer } from '/lib/list-renderer.js';

/**
 * Format timestamp as relative time
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
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
 * Format timestamp as full date
 */
function formatFullDate(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

/**
 * Device item template
 */
function deviceItemTemplate(device, context) {
  const isCurrent = device.id === context.currentCredentialId;
  const canRemove = !(context.deviceCount === 1 && !context.isLocalhost);

  const addedDate = formatFullDate(device.createdAt);
  const lastUsed = formatRelativeTime(device.lastUsedAt);

  return `
    <div class="device-item" data-device-id="${device.id}" data-is-current="${isCurrent}">
      <div class="device-header">
        <i class="ph ph-monitor"></i>
        <div class="device-name">${escapeHtml(device.name)}</div>
      </div>
      <div class="device-meta">
        Added: ${addedDate} • Last used: ${lastUsed}
        ${isCurrent ? ' • <span class="device-current">(current)</span>' : ''}
      </div>
      <div class="device-actions">
        <button
          class="device-btn"
          data-action="rename"
          data-id="${device.id}"
          aria-label="Rename device"
        >
          Rename
        </button>
        ${canRemove ? `
          <button
            class="device-btn device-btn-danger"
            data-action="remove"
            data-id="${device.id}"
            aria-label="Remove device"
          >
            Remove
          </button>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Create device list component
 */
export function createDeviceListComponent(store, options = {}) {
  const { onRename, onRemove } = options;

  const render = (state) => {
    // Loading state
    if (state.loading && state.devices.length === 0) {
      return '<p class="devices-loading">Loading devices...</p>';
    }

    // Error state
    if (state.error) {
      return '<p class="devices-loading">Failed to load devices</p>';
    }

    // Filter for LAN devices only
    const lanDevices = state.devices.filter(d => d.type === 'paired');

    // Empty state
    if (lanDevices.length === 0) {
      return '<p class="devices-loading">No LAN devices paired yet. Use "Pair Device on LAN" below to add one.</p>';
    }

    // We'll render list via ListRenderer in afterRender
    return '<div class="devices-list-container"></div>';
  };

  const afterRender = (container, state) => {
    const lanDevices = state.devices.filter(d => d.type === 'paired');
    if (lanDevices.length === 0) return;

    // Check if we're on localhost
    const isLocalhost = location.hostname === 'localhost' ||
                       location.hostname === '127.0.0.1' ||
                       location.hostname === '::1';

    const context = {
      currentCredentialId: state.currentCredentialId,
      isLocalhost,
      deviceCount: state.devices.length
    };

    const listContainer = container.querySelector('.devices-list-container');
    if (!listContainer) return;

    // Use ListRenderer for the device items
    const renderer = new ListRenderer(listContainer, {
      itemTemplate: (device) => deviceItemTemplate(device, context),
      onAction: ({ action, id, element }) => {
        if (action === 'rename' && onRename) {
          onRename(id);
        } else if (action === 'remove' && onRemove) {
          const isCurrent = element.dataset.isCurrent === 'true';
          onRemove(id, isCurrent);
        }
      },
      beforeRender: () => {
        // Add header for localhost view
        if (isLocalhost) {
          listContainer.innerHTML = '<div class="device-section-header">LAN DEVICES</div>';
        }
      },
      afterRender: () => {
        // Show warning if last device (remote view only)
        if (!isLocalhost && state.devices.length === 1) {
          listContainer.insertAdjacentHTML('beforeend', `
            <div class="devices-warning">
              <i class="ph ph-warning"></i>
              <span>You cannot remove the last device (would lock you out)</span>
            </div>
          `);
        }
      }
    });

    renderer.render(lanDevices);
  };

  return createComponent(store, render, { afterRender });
}
