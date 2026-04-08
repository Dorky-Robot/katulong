/**
 * Shared fixtures for tests that exercise lib/session-manager.js with
 * mocked tmux + Session.
 *
 * Three test files (`session-manager.test.js`, `pch2-attach-subscribe.test.js`,
 * `garble-output-coalesce.test.js`) all need the same boilerplate:
 *
 *   1. mock.module() the tmux helpers so no real `tmux` binary is touched
 *   2. mock.module() lib/session.js so a fake Session class is injected
 *   3. mock.module() lib/env-filter.js so getSafeEnv returns an empty object
 *   4. dynamically import createSessionManager AFTER mocks are in place
 *   5. construct a fake bridge that records relayed messages
 *
 * Centralising this here means a future change to the Session contract
 * (a new method, a renamed export) only needs the mock updated in ONE
 * place, not three. It also keeps the test files focused on the behaviour
 * they verify rather than mock plumbing.
 *
 * Usage from a test file:
 *
 *   import { setupSessionManagerMocks, BaseMockSession, makeBridge, tmuxSessions }
 *     from "./helpers/session-manager-fixture.js";
 *
 *   class MockSession extends BaseMockSession {
 *     // file-specific overrides go here
 *   }
 *
 *   const { createSessionManager } = await setupSessionManagerMocks(MockSession);
 *
 *   function makeManager() {
 *     const bridge = makeBridge();
 *     const mgr = createSessionManager({ bridge, shell: "/bin/sh", home: "/tmp" });
 *     return { mgr, bridge };
 *   }
 *
 * IMPORTANT: setupSessionManagerMocks() must be called at module top level
 * (`await setupSessionManagerMocks(...)`) BEFORE any other code imports
 * lib/session-manager.js. node:test's mock.module() does not hoist —
 * once a module has been imported, the mock no longer applies to it.
 */

import { mock } from "node:test";

/**
 * Shared in-memory tmux state. Tests reset this in beforeEach so each
 * test starts with a clean tmux server. Exported so test files can
 * inspect it directly (e.g., `assert.ok(tmuxSessions.has("foo"))`).
 */
export const tmuxSessions = new Map();

/**
 * Minimal Session mock implementing every method session-manager.js
 * calls. Subclass and override only what your test needs.
 *
 * The base implementation:
 *   - tracks lifecycle state via STATE_* constants
 *   - exposes a stub outputBuffer with totalBytes/sliceFrom
 *   - returns the structured screenFingerprint() shape: { hash, seq }
 *   - returns the structured snapshot() shape: { buffer, seq, alive }
 *   - returns the structured pullFrom() shape: { data, cursor }
 *   - removes itself from tmuxSessions on kill so listSessions stays
 *     consistent with the manager's view
 */
export class BaseMockSession {
  static STATE_ATTACHED = "attached";
  static STATE_DETACHED = "detached";
  static STATE_KILLED = "killed";

  constructor(name, tmuxName, options = {}) {
    this.name = name;
    this.tmuxName = tmuxName;
    this.state = BaseMockSession.STATE_ATTACHED;
    this.external = options.external || false;
    this._options = options;
    this._childCount = 0;
    this.outputBuffer = { totalBytes: 0, sliceFrom: () => "" };
  }

  get alive() { return this.state === BaseMockSession.STATE_ATTACHED; }
  get cursor() { return this.outputBuffer.totalBytes; }
  attachControlMode() {}
  async seedScreen() {}
  async serializeScreen() { return ""; }
  async screenFingerprint() { return { hash: 0, seq: this.cursor }; }
  async snapshot() {
    if (!this.alive) {
      return { buffer: "", seq: this.cursor, alive: false };
    }
    return { buffer: await this.serializeScreen(), seq: this.cursor, alive: true };
  }
  pullFrom(fromSeq) {
    return { data: this.outputBuffer.sliceFrom(fromSeq), cursor: this.cursor };
  }
  updateChildCount(count) { this._childCount = count; }
  write() {}
  resize() {}
  setIcon() {}

  detach() {
    if (this.state === BaseMockSession.STATE_ATTACHED) {
      this.state = BaseMockSession.STATE_DETACHED;
    }
  }

  kill() {
    if (this.state === BaseMockSession.STATE_KILLED) return;
    this.state = BaseMockSession.STATE_KILLED;
    tmuxSessions.delete(this.tmuxName);
  }

  toJSON() {
    return { name: this.name, alive: this.alive, external: this.external };
  }
}

/**
 * Wire up mock.module() for tmux + session + env-filter, then dynamically
 * import lib/session-manager.js so callers get the version with mocks
 * applied. Returns the imported module.
 *
 * @param {typeof BaseMockSession} SessionClass
 *   The mock Session class to inject for `lib/session.js` Session export.
 *   Pass BaseMockSession directly, or a subclass with file-specific
 *   overrides.
 */
export async function setupSessionManagerMocks(SessionClass = BaseMockSession) {
  const sessionModuleUrl = new URL("../../lib/session.js", import.meta.url).href;
  const tmuxModuleUrl = new URL("../../lib/tmux.js", import.meta.url).href;
  const envFilterUrl = new URL("../../lib/env-filter.js", import.meta.url).href;

  mock.module(sessionModuleUrl, {
    namedExports: { Session: SessionClass },
  });

  mock.module(tmuxModuleUrl, {
    namedExports: {
      tmuxSessionName: (name) => name.replace(/[.: ]/g, "_"),
      // tmuxExec must support rename-session because session-manager.test.js
      // exercises the rename path; other tests pass through harmlessly.
      tmuxExec: async (args) => {
        if (args[0] === "rename-session") {
          const oldName = args[2];
          const newName = args[3];
          if (tmuxSessions.has(oldName)) {
            tmuxSessions.delete(oldName);
            tmuxSessions.set(newName, true);
            return { code: 0 };
          }
          return { code: 1 };
        }
        return { code: 0 };
      },
      tmuxNewSession: async (tmuxName) => { tmuxSessions.set(tmuxName, true); },
      tmuxHasSession: async (tmuxName) => tmuxSessions.has(tmuxName),
      applyTmuxSessionOptions: async () => {},
      captureVisiblePane: async () => "$ prompt\n",
      getCursorPosition: async () => ({ row: 1, col: 10 }),
      getPaneCwd: async () => "/tmp",
      checkTmux: async () => {},
      cleanTmuxServerEnv: async () => {},
      setTmuxKatulongEnv: async () => {},
      tmuxListSessions: async () => [...tmuxSessions.keys()],
      tmuxKillSession: async (tmuxName) => { tmuxSessions.delete(tmuxName); },
      tmuxListSessionsDetailed: async () => new Map(),
      tmuxSocketArgs: () => [],
    },
  });

  mock.module(envFilterUrl, {
    namedExports: { getSafeEnv: () => ({}) },
  });

  return await import("../../lib/session-manager.js");
}

/**
 * Build a fake bridge that records every relayed message in a mutable
 * `messages` array. Tests assert against this array to check what the
 * session manager broadcast.
 */
export function makeBridge() {
  const messages = [];
  return {
    relay(msg) { messages.push(msg); },
    register() {},
    messages,
  };
}
