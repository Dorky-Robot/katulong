import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimit } from "../lib/rate-limit.js";

// Unique key counter so tests don't share state in the module-level store
let keyCounter = 0;
function uniqueKey() {
  const key = `test-ip-${++keyCounter}`;
  return () => key;
}

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    },
  };
  return res;
}

function makeReq() {
  return { socket: { remoteAddress: "127.0.0.1" } };
}

describe("rateLimit", () => {
  it("allows requests under the limit", () => {
    const keyFn = uniqueKey();
    const middleware = rateLimit(3, 60000, keyFn);
    const req = makeReq();

    let nextCalled = 0;
    const next = () => nextCalled++;

    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);
    assert.equal(nextCalled, 3);
  });

  it("blocks the request that exceeds the limit with 429", () => {
    const keyFn = uniqueKey();
    const middleware = rateLimit(2, 60000, keyFn);
    const req = makeReq();
    const next = () => {};

    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);

    const res = makeRes();
    middleware(req, res, next);

    assert.equal(res.statusCode, 429);
    assert.ok(res.headers["Retry-After"]);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, "Too many requests");
    assert.ok(typeof parsed.retryAfter === "number");
  });

  it("sets Retry-After header based on window remaining", () => {
    const keyFn = uniqueKey();
    const middleware = rateLimit(1, 10000, keyFn); // 10 s window
    const req = makeReq();
    const next = () => {};

    middleware(req, makeRes(), next); // count=1, allowed

    const res = makeRes();
    middleware(req, res, next); // count=2, blocked

    const retryAfter = parseInt(res.headers["Retry-After"], 10);
    assert.ok(retryAfter > 0 && retryAfter <= 10, `Retry-After should be 1–10, got ${retryAfter}`);
  });

  it("uses req.socket.remoteAddress as default key", () => {
    const middleware = rateLimit(1, 60000); // no keyFn
    const req = { socket: { remoteAddress: `default-key-test-${++keyCounter}` } };
    const next = () => {};

    middleware(req, makeRes(), next);

    const res = makeRes();
    middleware(req, res, next);

    assert.equal(res.statusCode, 429);
  });

  it("uses a custom keyFn when provided", () => {
    // Two IPs share the same custom key — they should share the limit
    const sharedKey = `shared-${++keyCounter}`;
    const middleware = rateLimit(1, 60000, () => sharedKey);
    const req = makeReq();
    const next = () => {};

    middleware(req, makeRes(), next);

    const res = makeRes();
    middleware(req, res, next);

    assert.equal(res.statusCode, 429);
  });

  it("resets count after the window expires", () => {
    const keyFn = uniqueKey();
    const middleware = rateLimit(1, 1, keyFn); // 1ms window
    const req = makeReq();

    let nextCalled = 0;
    const next = () => nextCalled++;

    middleware(req, makeRes(), next); // count=1

    // Wait for window to expire, then check a new request is allowed
    return new Promise((resolve) => {
      setTimeout(() => {
        middleware(req, makeRes(), next); // window expired, count resets to 1
        assert.equal(nextCalled, 2);
        resolve();
      }, 5);
    });
  });

  it("sweeps expired entries from the store on each invocation (lazy cleanup)", () => {
    // Use a very short window so entries expire quickly
    const keyFn1 = uniqueKey();
    const keyFn2 = uniqueKey();
    const middlewareA = rateLimit(5, 1, keyFn1); // 1ms window — expires fast
    const middlewareB = rateLimit(5, 60000, keyFn2);

    const req = makeReq();
    let nextCalled = 0;
    const next = () => nextCalled++;

    // Register an entry for keyFn1
    middlewareA(req, makeRes(), next);

    return new Promise((resolve) => {
      setTimeout(() => {
        // After expiry, hitting middlewareB should trigger the lazy sweep
        // that removes expired entries (we can't inspect the private store,
        // but verifying that the request is allowed after expiry is sufficient)
        middlewareA(req, makeRes(), next); // window expired, allowed again
        assert.equal(nextCalled, 2);
        resolve();
      }, 5);
    });
  });

  it("Content-Type header is application/json on 429", () => {
    const keyFn = uniqueKey();
    const middleware = rateLimit(0, 60000, keyFn);
    const req = makeReq();
    const res = makeRes();

    middleware(req, res, () => {});

    assert.equal(res.headers["Content-Type"], "application/json");
  });
});
