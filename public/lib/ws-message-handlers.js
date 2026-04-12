/**
 * WebSocket message handlers — pure functions that receive a parsed
 * message and narrow context, returning state updates and effects.
 *
 * Extracted from websocket-connection.js during the connection rewrite.
 * Each handler returns { stateUpdates: {}, effects: [] }.
 */

export const wsMessageHandlers = {
  attached(msg, ctx) {
    return {
      stateUpdates: {
        'session.name': msg.session,
        'scroll.userScrolledUpBeforeDisconnect': false,
      },
      effects: [
        { type: 'seqClear' },
        { type: 'terminalReset' },
        ...(msg.data ? [{ type: 'terminalWrite', data: msg.data, session: msg.session, useOutputTerm: true }] : []),
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: !ctx.scroll?.userScrolledUpBeforeDisconnect },
        { type: 'syncCarouselSubscriptions' },
      ],
    };
  },

  switched(msg, ctx) {
    return {
      stateUpdates: {
        'session.name': msg.session,
      },
      effects: [
        // No terminalReset — the terminal pool keeps each session's xterm
        // intact with its content. No snapshot replay either — the pull
        // mechanism resumes from the last known cursor and fills in any
        // output that arrived while we were away. This eliminates the
        // serialize snapshot (source of garble from mid-frame captures).
        { type: 'invalidateSessions', name: msg.session },
        { type: 'scrollToBottomIfNeeded', condition: true },
        { type: 'syncCarouselSubscriptions' },
      ],
    };
  },

  subscribed(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [
        // Write snapshot only if the terminal is empty (fresh from pool
        // after page refresh). If the terminal already has content (tab
        // switch), skip to avoid mid-frame garble from serializeScreen.
        ...(msg.data ? [{ type: 'subscribeSnapshot', data: msg.data, session: msg.session }] : []),
      ],
    };
  },

  unsubscribed(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [
        { type: 'seqClear', session: msg.session },
      ],
    };
  },

  // Server notifies that new data is available for a session topic
  'data-available'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'dataAvailable', session: msg.session }],
    };
  },

  // Server-pushed output — data sent inline, zero round trips
  output(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'outputReceived', session: msg.session, data: msg.data, cursor: msg.cursor, fromSeq: msg.fromSeq }],
    };
  },

  // Response to a pull request — contains data from cursor to head
  'pull-response'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'pullResponse', session: msg.session, data: msg.data, cursor: msg.cursor }],
    };
  },

  // Cursor was evicted — server sends a pane snapshot to recover
  'pull-snapshot'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'pullSnapshot', session: msg.session, data: msg.data, cursor: msg.cursor }],
    };
  },

  reload(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'reload' }],
    };
  },

  exit(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'terminalWrite', data: '\r\n[shell exited]\r\n', session: msg.session, preserveScroll: true, useOutputTerm: true }],
    };
  },

  'session-removed'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'sessionRemoved', name: msg.session }],
    };
  },

  'session-renamed'(msg, ctx) {
    return {
      stateUpdates: { 'session.name': msg.name },
      effects: [
        { type: 'carouselRename', oldName: ctx.currentSessionName, newName: msg.name },
        { type: 'poolRename', oldName: ctx.currentSessionName, newName: msg.name },
        { type: 'notepadRename', oldName: ctx.currentSessionName, newName: msg.name },
        { type: 'shortcutBarRename', oldName: ctx.currentSessionName, newName: msg.name },
        { type: 'tabRename', oldName: ctx.currentSessionName, newName: msg.name },
        { type: 'invalidateSessions', name: msg.name },
        { type: 'updateSessionUI', name: msg.name },
      ],
    };
  },

  'credential-registered'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'refreshTokensAfterRegistration' }],
    };
  },

  // CLI-driven UI actions
  'open-tab'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'openTab', session: msg.session }],
    };
  },

  notification(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'showNotification', title: msg.title, message: msg.message }],
    };
  },

  'device-auth-request'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'showDeviceAuthRequest', requestId: msg.requestId, code: msg.code, userAgent: msg.userAgent }],
    };
  },

  'paste-complete'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [
        { type: 'pasteComplete', path: msg.path },
      ],
    };
  },

  'resize-sync'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [
        { type: 'resizeSync', cols: msg.cols, rows: msg.rows },
      ],
    };
  },

  // Drift detection: server sends screen fingerprint after output settles.
  // Client compares against its own xterm — on mismatch, request resync.
  // `seq` is the byte position the server's hash describes; the client
  // must wait until its pull cursor reaches that position before comparing.
  'state-check'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'stateCheck', session: msg.session, fingerprint: msg.fingerprint, seq: msg.seq }],
    };
  },

  // seq-init: server tells us where the log head is — initialize pull cursor
  'seq-init'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'pullInit', session: msg.session, seq: msg.seq }],
    };
  },

  'server-draining'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [
        { type: 'log', message: '[WS] Server is draining, reconnecting immediately' },
        { type: 'fastReconnect' },
      ],
    };
  },

  // --- Helm mode events ---

  'helm-mode-changed'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{
        type: 'helmModeChanged', session: msg.session, active: msg.active,
        agent: msg.agent, prompt: msg.prompt, cwd: msg.cwd,
        result: msg.result, error: msg.error,
      }],
    };
  },

  'helm-event'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'helmEvent', session: msg.session, event: msg.event }],
    };
  },

  'helm-turn-complete'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'helmTurnComplete', session: msg.session }],
    };
  },

  'helm-waiting-for-input'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'helmWaitingForInput', session: msg.session }],
    };
  },

  'tab-icon-changed'(msg, ctx) {
    return {
      stateUpdates: {},
      effects: [{ type: 'tabIconChanged', session: msg.session, icon: msg.icon }],
    };
  },
};
