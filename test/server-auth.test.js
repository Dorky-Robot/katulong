import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirrors the isHttpsConnection() logic from server.js (not exported, so replicated for testing)
function isHttpsConnection(req) {
  if (req.socket?.encrypted) return true;
  const hostname = (req.headers?.host || 'localhost').split(':')[0];
  if (hostname.endsWith('.ngrok.app') ||
      hostname.endsWith('.ngrok.io') ||
      hostname.endsWith('.trycloudflare.com') ||
      hostname.endsWith('.loca.lt')) return true;
  const addr = req.socket?.remoteAddress || "";
  const isLoopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  if (isLoopback && req.headers?.["cf-connecting-ip"]) return true;
  return false;
}

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
    // This is the bug: behind a tunnel socket.encrypted is always falsy
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
    // Simulate the logout cookie-building logic from server.js
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

// Mock the auth functions from server.js
// These would normally be imported, but since server.js doesn't export them,
// we'll test them by extracting the logic into testable units

describe("isLocalRequest", () => {
  function isLocalRequest(req) {
    const addr = req.socket?.remoteAddress;
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  it("returns true for IPv4 localhost", () => {
    const req = { socket: { remoteAddress: "127.0.0.1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns true for IPv4-mapped IPv6 localhost", () => {
    const req = { socket: { remoteAddress: "::ffff:127.0.0.1" } };
    assert.ok(isLocalRequest(req));
  });

  it("returns false for non-localhost IPv4", () => {
    const req = { socket: { remoteAddress: "192.168.1.1" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false for non-localhost IPv6", () => {
    const req = { socket: { remoteAddress: "2001:db8::1" } };
    assert.ok(!isLocalRequest(req));
  });

  it("returns false when socket is missing", () => {
    const req = {};
    assert.ok(!isLocalRequest(req));
  });

  it("returns false when remoteAddress is missing", () => {
    const req = { socket: {} };
    assert.ok(!isLocalRequest(req));
  });
});

describe("readBody size limiting", () => {
  it("should accept bodies under the limit", async () => {
    const { Readable } = await import("node:stream");
    
    function readBody(req, maxSize = 1024 * 1024) {
      return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxSize) {
            req.destroy();
            reject(new Error("Request body too large"));
            return;
          }
          body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });
    }

    const req = Readable.from(["hello"]);
    const body = await readBody(req, 1000);
    assert.equal(body, "hello");
  });

  it("should reject bodies over the limit", async () => {
    const { Readable } = await import("node:stream");
    
    function readBody(req, maxSize = 1024 * 1024) {
      return new Promise((resolve, reject) => {
        let body = "";
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxSize) {
            req.destroy();
            reject(new Error("Request body too large"));
            return;
          }
          body += chunk;
        });
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });
    }

    const req = Readable.from(["a".repeat(2000)]);
    await assert.rejects(
      () => readBody(req, 1000),
      { message: "Request body too large" }
    );
  });
});

describe("setSecurityHeaders", () => {
  function setSecurityHeaders(res) {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }

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
