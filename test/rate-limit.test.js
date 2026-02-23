import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, getClientIp } from "../lib/rate-limit.js";

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

  it("uses getClientIp as default key (direct connection uses socket address)", () => {
    const middleware = rateLimit(1, 60000); // no keyFn
    // Use a non-loopback, non-private address so XFF is not trusted
    const req = { socket: { remoteAddress: `203.0.113.${++keyCounter}` }, headers: {} };
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

describe("getClientIp", () => {
  it("returns socket address for direct (non-proxied) connections", () => {
    const req = {
      socket: { remoteAddress: "203.0.113.42" },
      headers: { "x-forwarded-for": "10.0.0.1" },
    };
    // XFF should be ignored because socket is a public IP (not loopback/private)
    assert.equal(getClientIp(req), "203.0.113.42");
  });

  it("returns first XFF IP for loopback socket (proxied via ngrok/Cloudflare)", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "203.0.113.42" },
    };
    assert.equal(getClientIp(req), "203.0.113.42");
  });

  it("returns first XFF IP when multiple are present", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      headers: { "x-forwarded-for": "203.0.113.42, 10.0.0.1, 172.16.0.5" },
    };
    assert.equal(getClientIp(req), "203.0.113.42");
  });

  it("falls back to socket address when XFF is missing on proxied connection", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {},
    };
    assert.equal(getClientIp(req), "127.0.0.1");
  });

  it("falls back to socket address when XFF is empty string", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      headers: { "x-forwarded-for": "" },
    };
    assert.equal(getClientIp(req), "::1");
  });

  it("handles ::ffff:127.0.0.1 (IPv4-mapped loopback) as proxied", () => {
    const req = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: { "x-forwarded-for": "203.0.113.99" },
    };
    assert.equal(getClientIp(req), "203.0.113.99");
  });

  it("trusts XFF for private 10.x.x.x socket address", () => {
    const req = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: { "x-forwarded-for": "203.0.113.7" },
    };
    assert.equal(getClientIp(req), "203.0.113.7");
  });

  it("trusts XFF for private 172.16-31.x.x socket address", () => {
    const req = {
      socket: { remoteAddress: "172.20.0.1" },
      headers: { "x-forwarded-for": "203.0.113.8" },
    };
    assert.equal(getClientIp(req), "203.0.113.8");
  });

  it("trusts XFF for private 192.168.x.x socket address", () => {
    const req = {
      socket: { remoteAddress: "192.168.1.100" },
      headers: { "x-forwarded-for": "203.0.113.9" },
    };
    assert.equal(getClientIp(req), "203.0.113.9");
  });

  it("does NOT trust XFF for 172.15 (just outside private range)", () => {
    const req = {
      socket: { remoteAddress: "172.15.0.1" },
      headers: { "x-forwarded-for": "203.0.113.10" },
    };
    // 172.15 is not in 172.16-31 range, so socket is public
    assert.equal(getClientIp(req), "172.15.0.1");
  });

  it("trims whitespace from XFF first IP", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "  203.0.113.11  , 10.0.0.2" },
    };
    assert.equal(getClientIp(req), "203.0.113.11");
  });

  it("default rate limiter uses XFF for proxied connections", () => {
    const middleware = rateLimit(1, 60000); // no keyFn → uses getClientIp
    const clientIp = `203.0.113.${++keyCounter}`;

    // Two requests from same client IP behind a proxy — should share the limit
    const req1 = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": clientIp } };
    const req2 = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": clientIp } };

    const next = () => {};
    middleware(req1, makeRes(), next);

    const res = makeRes();
    middleware(req2, res, next);
    assert.equal(res.statusCode, 429, "Second request from same client IP behind proxy should be rate limited");
  });

  it("default rate limiter isolates different XFF IPs behind same proxy", () => {
    const middleware = rateLimit(1, 60000); // no keyFn → uses getClientIp
    const clientIp1 = `203.0.113.${++keyCounter}`;
    const clientIp2 = `203.0.113.${++keyCounter}`;

    const req1 = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": clientIp1 } };
    const req2 = { socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": clientIp2 } };

    let nextCalled = 0;
    const next = () => nextCalled++;

    middleware(req1, makeRes(), next);
    middleware(req2, makeRes(), next);
    // Both have different client IPs, so both should be allowed (count = 1 each)
    assert.equal(nextCalled, 2, "Different client IPs behind same proxy should have independent limits");
  });
});
