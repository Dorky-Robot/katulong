/**
 * Tests for public/lib/notify.js — notification dispatch logic.
 *
 * The key behavioral difference tested here: on Android Chrome,
 * `new Notification()` throws TypeError — the only way to show
 * a notification is via `ServiceWorkerRegistration.showNotification()`.
 * The dispatcher must use `navigator.serviceWorker.ready` (not
 * `.controller`) so it works even before `clients.claim()` propagates.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// Register resolver for /lib/ paths → public/lib/
const projectRoot = new URL("..", import.meta.url).href;
const resolverCode = `
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/lib/") || specifier.startsWith("/vendor/")) {
    return nextResolve("${projectRoot}public" + specifier, context);
  }
  return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

const { dispatchNotification } = await import("../public/lib/notify.js");

describe("dispatchNotification", () => {
  describe("with ServiceWorker available (Android Chrome path)", () => {
    it("returns 'sw' and calls reg.showNotification via SW ready", async () => {
      let showCalled = null;
      const mockReg = {
        showNotification(title, opts) { showCalled = { title, opts }; },
      };
      const env = {
        window: { Notification: { permission: "granted" } },
        navigator: {
          serviceWorker: {
            ready: Promise.resolve(mockReg),
          },
        },
      };

      const result = dispatchNotification("Build done", "Tests passed", env);
      assert.strictEqual(result, "sw");

      // Let the microtask (ready.then) resolve
      await new Promise(r => setTimeout(r, 0));
      assert.deepStrictEqual(showCalled, {
        title: "Build done",
        opts: { body: "Tests passed", icon: "/icon-192.png" },
      });
    });

    it("works even when .controller is null (the Android first-load case)", async () => {
      let showCalled = false;
      const mockReg = { showNotification() { showCalled = true; } };
      const env = {
        window: { Notification: { permission: "granted" } },
        navigator: {
          serviceWorker: {
            controller: null, // <-- this was the old gate that broke Android
            ready: Promise.resolve(mockReg),
          },
        },
      };

      const result = dispatchNotification("Title", "Body", env);
      assert.strictEqual(result, "sw");
      await new Promise(r => setTimeout(r, 0));
      assert.ok(showCalled, "showNotification should be called even with controller=null");
    });

    it("does not throw when SW ready rejects", async () => {
      const env = {
        window: { Notification: { permission: "granted" } },
        navigator: {
          serviceWorker: {
            ready: Promise.reject(new Error("SW failed")),
          },
        },
      };

      const result = dispatchNotification("Title", "Body", env);
      assert.strictEqual(result, "sw");
      // The .catch() in dispatchNotification should swallow the error
      await new Promise(r => setTimeout(r, 0));
    });
  });

  describe("without ServiceWorker (desktop fallback)", () => {
    it("returns 'constructor' and calls new Notification()", () => {
      let ctorCalled = null;
      function MockNotification(title, opts) {
        ctorCalled = { title, opts };
      }
      MockNotification.permission = "granted";

      const env = {
        window: { Notification: MockNotification },
        navigator: {}, // no serviceWorker property
      };

      const result = dispatchNotification("Alert", "msg", env);
      assert.strictEqual(result, "constructor");
      assert.deepStrictEqual(ctorCalled, {
        title: "Alert",
        opts: { body: "msg", icon: "/icon-192.png" },
      });
    });

    it("catches TypeError from Notification constructor (Android without SW)", () => {
      function MockNotification() {
        throw new TypeError("Illegal constructor");
      }
      MockNotification.permission = "granted";

      const env = {
        window: { Notification: MockNotification },
        navigator: {},
      };

      // Should not throw
      const result = dispatchNotification("Title", "Body", env);
      assert.strictEqual(result, "constructor");
    });
  });

  describe("when notifications are unavailable", () => {
    it("returns 'unavailable' when Notification API is missing", () => {
      const env = {
        window: {}, // no Notification
        navigator: {},
      };
      assert.strictEqual(dispatchNotification("T", "M", env), "unavailable");
    });

    it("returns 'unavailable' when permission is denied", () => {
      const env = {
        window: { Notification: { permission: "denied" } },
        navigator: {},
      };
      assert.strictEqual(dispatchNotification("T", "M", env), "unavailable");
    });

    it("returns 'unavailable' when permission is default (not yet requested)", () => {
      const env = {
        window: { Notification: { permission: "default" } },
        navigator: {},
      };
      assert.strictEqual(dispatchNotification("T", "M", env), "unavailable");
    });
  });
});
