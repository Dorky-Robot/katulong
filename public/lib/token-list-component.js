/**
 * Reactive Token List Component
 *
 * Auto-updates when token store changes.
 */

import { createComponent } from '/lib/component.js';
import { clearNewToken, invalidateTokens } from '/lib/stores.js';
import { ListRenderer } from '/lib/list-renderer.js';

// Utility functions
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Never';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

/**
 * Creates token item HTML
 */
function tokenItemTemplate(token) {
  const createdDate = token.createdAt ? new Date(token.createdAt).toLocaleDateString() : 'Unknown';

  // Check if token has been used to register a device
  const hasCredential = token.credential !== null && token.credential !== undefined;
  const isOrphaned = token._orphanedCredential === true;
  // For orphaned credentials, use credential ID as the revoke target
  const revokeId = isOrphaned ? token.credential.id : token.id;

  let iconClass, statusText, metaText;
  if (hasCredential) {
    // Token was used - show device info
    iconClass = 'ph-device-mobile';
    const lastAuth = token.credential.lastUsedAt ? formatRelativeTime(token.credential.lastUsedAt) : 'Never';
    statusText = `<span class="token-status-active">Active device</span>`;
    metaText = `Registered: ${createdDate} · Last authenticated: ${lastAuth}`;

    // Add user agent info if available
    if (token.credential.userAgent && token.credential.userAgent !== 'Unknown') {
      metaText += `<br><span class="token-device-info">${escapeHtml(token.credential.userAgent)}</span>`;
    }
  } else {
    // Token not used yet - show as unused
    iconClass = 'ph-key';
    statusText = `<span class="token-status-unused">Unused</span>`;
    metaText = `Created: ${createdDate}`;
  }

  return `
    <div class="token-item ${hasCredential ? 'token-item-used' : ''}" data-token-id="${token.id || ''}" data-has-credential="${hasCredential}" data-orphaned="${isOrphaned}" data-credential-id="${hasCredential ? token.credential.id : ''}">
      <div class="token-header">
        <i class="token-icon ph ${iconClass}"></i>
        <span class="token-name">${escapeHtml(token.name)}</span>
        ${statusText}
      </div>
      <div class="token-meta">
        ${metaText}
      </div>
      <div class="token-actions">
        ${!isOrphaned ? `<button class="token-btn" data-action="rename" data-id="${token.id}">Rename</button>` : ''}
        <button class="token-btn token-btn-danger" data-action="revoke" data-id="${revokeId}">Revoke</button>
      </div>
    </div>
  `;
}

/**
 * Create token list component
 */
export function createTokenListComponent(store, options = {}) {
  const { onRename, onRevoke } = options;

  const render = (state) => {
    if (state.loading && state.tokens.length === 0) {
      return '<p class="tokens-loading">Loading tokens...</p>';
    }

    // Will render in afterRender
    return '';
  };

  const afterRender = (container, state) => {
    container.innerHTML = '';

    // Render new token display at the top (if exists)
    if (state.newToken) {
      const newTokenEl = document.createElement("div");
      newTokenEl.className = "token-item token-item-new";
      newTokenEl.dataset.tokenId = state.newToken.id;
      newTokenEl.innerHTML = `
        <div class="token-header">
          <i class="token-icon ph ph-key"></i>
          <span class="token-name">${escapeHtml(state.newToken.name)}</span>
          <span class="token-new-badge">New</span>
        </div>
        <div class="token-reveal-warning">
          <i class="ph ph-warning"></i> Save this token now - you won't see it again!
        </div>
        <div class="token-value-container">
          <input type="text" class="token-value-field" value="${escapeHtml(state.newToken.token)}" readonly />
          <button class="token-copy-btn">
            <i class="ph ph-copy"></i> Copy
          </button>
        </div>
        <div class="token-actions">
          <button class="token-btn" id="token-done-btn">Done</button>
        </div>
      `;

      // Copy button handler
      const copyBtn = newTokenEl.querySelector(".token-copy-btn");
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(state.newToken.token);
          copyBtn.innerHTML = '<i class="ph ph-check"></i> Copied!';
          copyBtn.style.background = "var(--success)";
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
            copyBtn.style.background = "";
          }, 2000);
        } catch (err) {
          copyBtn.innerHTML = '<i class="ph ph-x"></i> Failed';
          setTimeout(() => {
            copyBtn.innerHTML = '<i class="ph ph-copy"></i> Copy';
          }, 2000);
        }
      });

      // Done button handler
      const doneBtn = newTokenEl.querySelector("#token-done-btn");
      doneBtn.addEventListener("click", () => {
        clearNewToken(store);
      });

      container.appendChild(newTokenEl);
    }

    // Filter out new token from regular list (only while it's being displayed as new)
    const filteredTokens = state.newToken
      ? state.tokens.filter(t => t.id !== state.newToken.id)
      : state.tokens;

    // Render regular token list
    if (filteredTokens.length === 0 && !state.newToken) {
      const emptyEl = document.createElement('p');
      emptyEl.className = 'tokens-empty';
      emptyEl.textContent = 'No setup tokens yet. Generate one to pair remote devices.';
      container.appendChild(emptyEl);
    } else if (filteredTokens.length > 0) {
      const listContainer = document.createElement('div');
      const renderer = new ListRenderer(listContainer, {
        itemTemplate: tokenItemTemplate,
        emptyState: '',
        onAction: ({ action, id, element }) => {
          if (action === 'rename' && onRename) {
            onRename(id);
          } else if (action === 'revoke' && onRevoke) {
            const tokenItem = element.closest('.token-item');
            const hasCredential = tokenItem.dataset.hasCredential === 'true';
            const isOrphaned = tokenItem.dataset.orphaned === 'true';
            onRevoke(id, hasCredential, isOrphaned);
          }
        }
      });
      renderer.render(filteredTokens);
      container.appendChild(listContainer);
    }
  };

  return createComponent(store, render, { afterRender });
}
