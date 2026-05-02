/**
 * extractApiKeyCandidate — pure helper that pulls an api-key candidate
 * from an HTTP request, regardless of whether it arrived via the
 * `Authorization: Bearer <key>` header or the `?api_key=<key>` query
 * param.
 *
 * The query-param form exists for cross-instance browser WebSockets:
 * `new WebSocket(url)` cannot set custom headers, so peer-tiles
 * authenticate via URL. This pair of tests pins both forms so we can
 * never quietly lose support for either, and cross-checks the precedence
 * (Bearer wins over query so a non-browser caller can't be fooled by a
 * URL-injected key).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractApiKeyCandidate } from "../lib/auth.js";

function req({ authorization, url, host = "example.test" } = {}) {
  return {
    headers: {
      ...(authorization ? { authorization } : {}),
      host,
    },
    ...(url !== undefined ? { url } : {}),
  };
}

describe("extractApiKeyCandidate — Bearer header", () => {
  it("returns the token from a Bearer Authorization header", () => {
    assert.equal(
      extractApiKeyCandidate(req({ authorization: "Bearer abc123" })),
      "abc123",
    );
  });

  it("ignores leading/trailing whitespace in the Bearer value", () => {
    // A misconfigured proxy could double-pad the header; we should still
    // surface the underlying token rather than reject silently.
    assert.equal(
      extractApiKeyCandidate(req({ authorization: "Bearer   abc123  " })),
      "abc123",
    );
  });

  it("returns null when Bearer value is empty", () => {
    assert.equal(extractApiKeyCandidate(req({ authorization: "Bearer " })), null);
  });

  it("ignores non-Bearer schemes (Basic, Digest)", () => {
    // Basic auth is not how this server takes credentials. If we returned
    // the base64 blob, the auth store lookup would fail noisily — but
    // returning null keeps the rejection path tidy.
    assert.equal(
      extractApiKeyCandidate(req({ authorization: "Basic dXNlcjpwYXNz" })),
      null,
    );
  });
});

describe("extractApiKeyCandidate — query param", () => {
  it("returns ?api_key=<key> from the URL", () => {
    assert.equal(
      extractApiKeyCandidate(req({ url: "/?api_key=xyz789" })),
      "xyz789",
    );
  });

  it("works on the WebSocket upgrade path", () => {
    // The /ws upgrade path is the actual real-world consumer of this
    // form — peer-tiles attach to `wss://peer/?api_key=…`. Pin it
    // directly so an accidental "only accept on /api/*" regression
    // can't slip through.
    assert.equal(
      extractApiKeyCandidate(req({ url: "/?api_key=ws-token-1234" })),
      "ws-token-1234",
    );
  });

  it("URL-decodes the key value", () => {
    // Keys are hex by convention so this rarely matters, but a future
    // base64-with-padding key would land here URL-encoded.
    assert.equal(
      extractApiKeyCandidate(req({ url: "/?api_key=foo%2Bbar%3D" })),
      "foo+bar=",
    );
  });

  it("returns null when api_key param is empty", () => {
    assert.equal(extractApiKeyCandidate(req({ url: "/?api_key=" })), null);
  });

  it("returns null for a URL with no api_key param", () => {
    assert.equal(extractApiKeyCandidate(req({ url: "/?other=value" })), null);
  });

  it("returns null when url is malformed", () => {
    // No-throw guarantee — callers can pass req unchanged from Node's
    // http server without paranoia.
    assert.equal(extractApiKeyCandidate(req({ url: "://not a url" })), null);
  });

  it("works when host header is missing", () => {
    // Some test harnesses build req without a Host header. The helper
    // synthesizes one for URL parsing rather than throwing.
    assert.equal(
      extractApiKeyCandidate({
        headers: { authorization: undefined },
        url: "/?api_key=k",
      }),
      "k",
    );
  });
});

describe("extractApiKeyCandidate — precedence and edges", () => {
  it("Bearer header wins over query param", () => {
    // Mixed form is suspicious — usually a misconfigured client. Returning
    // the Bearer is the safer pick: the URL is more often logged or
    // reflected back than headers, so an attacker who slips a key into
    // the URL of a request that already has a header should not have
    // their key honored.
    assert.equal(
      extractApiKeyCandidate(req({
        authorization: "Bearer header-token",
        url: "/?api_key=query-token",
      })),
      "header-token",
    );
  });

  it("returns null with neither header nor query", () => {
    assert.equal(extractApiKeyCandidate(req({})), null);
  });

  it("returns null when req is null/undefined", () => {
    // Defensive: callers may pass through whatever they got from a
    // partially-constructed http message in tests. No throw.
    assert.equal(extractApiKeyCandidate(null), null);
    assert.equal(extractApiKeyCandidate(undefined), null);
  });
});
