import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { isHttpsConnection } from "../lib/http-util.js";
import { isLocalRequest } from "../lib/access-method.js";
import { readBody, json, setSecurityHeaders } from "../lib/request-util.js";

describe("isHttpsConnection (logout cookie Secure flag)", () => {
  it("returns true when socket is directly encrypted (native TLS)", () => {
    const req = { socket: { encrypted: true }, headers: { host: "example.com" } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns false for plain HTTP connection", () => {
    const req = { socket: { encrypted: false }, headers: { host: "localhost" } };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns false when socket.encrypted is absent (tunnel scenario)", () => {
    const req = { socket: {}, headers: { host: "myapp.example.com" } };
    assert.ok(!isHttpsConnection(req));
  });

  it("returns true for ngrok.app tunnel", () => {
    const req = { socket: {}, headers: { host: "abc123.ngrok.app" } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for ngrok.io tunnel", () => {
    const req = { socket: {}, headers: { host: "abc123.ngrok.io" } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for trycloudflare.com tunnel", () => {
    const req = { socket: {}, headers: { host: "random.trycloudflare.com" } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for localtunnel (.loca.lt)", () => {
    const req = { socket: {}, headers: { host: "myapp.loca.lt" } };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for Cloudflare Tunnel (loopback socket + CF-Connecting-IP header)", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "myapp.example.com", "cf-connecting-ip": "203.0.113.1" },
    };
    assert.ok(isHttpsConnection(req));
  });

  it("returns true for Cloudflare Tunnel with IPv6 loopback", () => {
    const req = {
      socket: { remoteAddress: "::1" },
      headers: { host: "myapp.example.com", "cf-connecting-ip": "203.0.113.1" },
    };
    assert.ok(isHttpsConnection(req));
  });

  it("returns false for non-loopback socket with CF-Connecting-IP (forgeable)", () => {
    const req = {
      socket: { remoteAddress: "192.168.1.100" },
      headers: { host: "myapp.example.com", "cf-connecting-ip": "203.0.113.1" },
    };
    assert.ok(!isHttpsConnection(req));
  });

  it("logout cookie includes Secure flag when behind ngrok tunnel", () => {
    const req = { socket: {}, headers: { host: "abc123.ngrok.app" } };
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (isHttpsConnection(req)) clearCookie += "; Secure";
    assert.ok(clearCookie.includes("; Secure"), "Secure flag must be set for tunnel connections");
  });

  it("logout cookie omits Secure flag for plain HTTP localhost", () => {
    const req = { socket: { encrypted: false }, headers: { host: "localhost" } };
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (isHttpsConnection(req)) clearCookie += "; Secure";
    assert.ok(!clearCookie.includes("; Secure"), "Secure flag must not be set for plain HTTP");
  });

  it("logout cookie includes Secure flag for Cloudflare custom domain", () => {
    const req = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: { host: "terminal.example.com", "cf-connecting-ip": "203.0.113.5" },
    };
    let clearCookie = "katulong_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    if (isHttpsConnection(req)) clearCookie += "; Secure";
    assert.ok(clearCookie.includes("; Secure"), "Secure flag must be set for Cloudflare custom domain");
  });
});

describe("isLocalRequest", () => {
  it("returns true for IPv4 localhost", () => {
    const req = { socket: { remoteAddress: "127.0.0.1" }, headers: { host: "localhost" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::1" }, headers: { host: "localhost" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv4-mapped IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: { host: "localhost" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns false for non-localhost IPv4", () => {
    const req = { socket: { remoteAddress: "192.168.1.1" }, headers: { host: "192.168.1.1" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false for non-localhost IPv6", () => {
    const req = { socket: { remoteAddress: "2001:db8::1" }, headers: { host: "[2001:db8::1]" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false when remoteAddress is missing", () => {
    const req = { socket: {}, headers: { host: "localhost" } };
    assert.ok(!isLocalRequest(req));
  });
});

describe("readBody", () => {
  it("accepts bodies under the limit", async () => {
    const req = Readable.from(["hello"]);
    const body = await readBody(req, 1000);
    assert.equal(body, "hello");
  });

  it("rejects bodies over the limit", async () => {
    const req = Readable.from(["a".repeat(2000)]);
    await assert.rejects(
      () => readBody(req, 1000),
      { message: "Request body too large" }
    );
  });

  it("reads multi-chunk bodies", async () => {
    const req = Readable.from(["chunk1", "chunk2", "chunk3"]);
    const body = await readBody(req, 10000);
    assert.equal(body, "chunk1chunk2chunk3");
  });

  it("defaults to 1MB limit", async () => {
    // Just verify it doesn't throw for a small body
    const req = Readable.from(["small"]);
    const body = await readBody(req);
    assert.equal(body, "small");
  });
});

describe("json", () => {
  function mockRes() {
    let statusCode;
    let headers;
    let body;
    return {
      writeHead(code, hdrs) { statusCode = code; headers = hdrs; },
      end(data) { body = data; },
      getStatusCode() { return statusCode; },
      getHeaders() { return headers; },
      getBody() { return body; },
    };
  }

  it("sets Content-Type to application/json", () => {
    const res = mockRes();
    json(res, 200, { ok: true });
    assert.equal(res.getHeaders()["Content-Type"], "application/json");
  });

  it("sets the correct status code", () => {
    const res = mockRes();
    json(res, 404, { error: "not found" });
    assert.equal(res.getStatusCode(), 404);
  });

  it("serializes data as JSON string", () => {
    const res = mockRes();
    const data = { key: "value", num: 42 };
    json(res, 200, data);
    assert.deepEqual(JSON.parse(res.getBody()), data);
  });
});

describe("setSecurityHeaders", () => {
  function mockRes() {
    const headers = {};
    return {
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      headers,
    };
  }

  it("sets X-Frame-Options to DENY", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    assert.equal(res.headers["x-frame-options"], "DENY");
  });

  it("sets X-Content-Type-Options to nosniff", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("sets X-XSS-Protection to 0 (disables legacy filter)", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    assert.equal(res.headers["x-xss-protection"], "0");
  });

  it("sets Referrer-Policy to strict-origin-when-cross-origin", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin");
  });

  it("sets Permissions-Policy to restrict camera, microphone, geolocation", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    assert.equal(res.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  });

  it("sets all five headers in a single call", () => {
    const res = mockRes();
    setSecurityHeaders(res);
    const expected = ["x-frame-options", "x-content-type-options", "x-xss-protection", "referrer-policy", "permissions-policy"];
    for (const header of expected) {
      assert.ok(res.headers[header] !== undefined, `missing header: ${header}`);
    }
  });
});
