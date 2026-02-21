/**
 * Integration tests for request routing
 * Tests the complete request flow through access method detection,
 * HTTPS enforcement, auth checks, and static file serving.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { getAccessMethod } from '../lib/access-method.js';
import { checkHttpsEnforcement, getUnauthenticatedRedirect } from '../lib/https-enforcement.js';
import { serveStaticFile } from '../lib/static-files.js';
import { isPublicPath } from '../lib/http-util.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function mockRequest({ remoteAddress, host, origin, encrypted = false, url = "/" }) {
  return {
    socket: { remoteAddress, encrypted },
    headers: { host, origin },
    url,
    method: 'GET'
  };
}

function mockResponse() {
  const headers = {};
  let statusCode = 200;
  let body = null;

  return {
    writeHead(code, hdrs) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    end(data) { body = data; },
    getStatusCode() { return statusCode; },
    getHeader(name) { return headers[name]; },
    getBody() { return body; }
  };
}

function mockIsHttpsConnection(req) {
  // Check if socket is encrypted
  if (req.socket?.encrypted) return true;

  // Check if host indicates HTTPS tunnel
  const hostname = (req.headers.host || 'localhost').split(':')[0];
  return hostname.endsWith('.ngrok.app') ||
         hostname.endsWith('.ngrok.io') ||
         hostname.endsWith('.trycloudflare.com') ||
         hostname.endsWith('.loca.lt');
}


describe('request-routing integration', () => {
  const testDir = join(process.cwd(), '.test-routing');
  const publicDir = join(testDir, 'public');

  // Setup test files
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'login.html'), '<html>login</html>');
  writeFileSync(join(publicDir, 'login.js'), 'console.log("login");');
  writeFileSync(join(publicDir, 'login.css'), 'body { color: red; }');

  const vendorDir = join(publicDir, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  writeFileSync(join(vendorDir, 'lib.js'), 'export const version = "1.0.0";');

  describe('localhost access', () => {
    const req = mockRequest({
      remoteAddress: '127.0.0.1',
      host: 'localhost:3001'
    });

    it('detects access method as localhost', () => {
      assert.strictEqual(getAccessMethod(req), 'localhost');
    });

    it('allows all paths over HTTP (no HTTPS enforcement)', () => {
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath, mockIsHttpsConnection), null);
    });

    it('serves static files correctly', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
      assert.ok(res.getBody().toString().includes('console.log'));
    });

    it('redirects unauthenticated users to /login', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/login');
    });
  });

  describe('LAN access over HTTP', () => {
    const req = mockRequest({
      remoteAddress: '192.168.1.100',
      host: 'katulong.local:3001',
      encrypted: false
    });

    it('detects access method as lan', () => {
      assert.strictEqual(getAccessMethod(req), 'lan');
    });

    it('redirects protected paths to /login', () => {
      const check = checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection);
      assert.deepStrictEqual(check, { redirect: '/login' });
    });

    it('redirects unauthenticated users to /login', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/login');
    });

    it('serves static files correctly', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.css');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'text/css; charset=utf-8');
    });
  });

  describe('LAN access over HTTPS', () => {
    const req = mockRequest({
      remoteAddress: '192.168.1.100',
      host: 'katulong.local:3002',
      encrypted: true
    });

    it('detects access method as lan', () => {
      assert.strictEqual(getAccessMethod(req), 'lan');
    });

    it('allows all paths (HTTPS enforcement satisfied)', () => {
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath, mockIsHttpsConnection), null);
    });

    it('redirects unauthenticated users to /login', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/login');
    });

    it('serves static files correctly', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
    });
  });

  describe('Internet access (ngrok)', () => {
    const req = mockRequest({
      remoteAddress: '127.0.0.1',
      host: 'felix-katulong.ngrok.app',
      encrypted: false
    });

    it('detects access method as internet', () => {
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('allows public paths over HTTP', () => {
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.html', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.js', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.css', isPublicPath, mockIsHttpsConnection), null);
    });

    it('allows protected paths (ngrok provides HTTPS)', () => {
      const check = checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection);
      // ngrok is treated as HTTPS, so no redirect required
      assert.strictEqual(check, null);
    });

    it('redirects unauthenticated users to /login', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/login');
    });

    it('never redirects to /connect/trust (trust flow removed)', () => {
      // Critical: No users should be redirected to the trust page since it no longer exists
      const rootCheck = checkHttpsEnforcement(req, '/', isPublicPath, mockIsHttpsConnection);
      const apiCheck = checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection);
      const settingsCheck = checkHttpsEnforcement(req, '/settings', isPublicPath, mockIsHttpsConnection);

      // ngrok is treated as HTTPS, so no HTTPS redirect required
      assert.strictEqual(rootCheck, null, 'Root should not redirect (ngrok provides HTTPS)');
      assert.strictEqual(apiCheck, null, 'API should not redirect (ngrok provides HTTPS)');
      assert.strictEqual(settingsCheck, null, 'Settings should not redirect (ngrok provides HTTPS)');

      // Unauthenticated redirect should still be /login (auth check, not HTTPS check)
      const unauthRedirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(unauthRedirect, '/login', 'Unauth redirect should be /login');
    });

    it('serves static files correctly (login assets)', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
      assert.ok(res.getBody().toString().includes('console.log'));
    });

    it('serves vendor files correctly', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/vendor/lib.js');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
      assert.ok(res.getHeader('Cache-Control').includes('immutable'));
    });
  });

  describe('public path detection', () => {
    it('correctly identifies login paths as public', () => {
      assert.strictEqual(isPublicPath('/login'), true);
      assert.strictEqual(isPublicPath('/login.html'), true);
      assert.strictEqual(isPublicPath('/login.js'), true);
      assert.strictEqual(isPublicPath('/login.css'), true);
    });

    it('correctly identifies vendor files as public', () => {
      assert.strictEqual(isPublicPath('/vendor/lib.js'), true);
      assert.strictEqual(isPublicPath('/vendor/simplewebauthn/browser.esm.js'), true);
    });

    it('correctly identifies protected paths', () => {
      assert.strictEqual(isPublicPath('/api/sessions'), false);
      assert.strictEqual(isPublicPath('/'), false);
    });

    it('rejects /connect/trust paths (trust page removed)', () => {
      assert.strictEqual(isPublicPath('/connect/trust'), false);
      assert.strictEqual(isPublicPath('/connect/trust/ca.crt'), false);
    });
  });

  describe('complete request flows', () => {
    it('handles first-time LAN user journey (redirects to /login)', () => {
      // User visits katulong.local:3001/ (HTTP)
      const req1 = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/'
      });

      // Should detect LAN
      assert.strictEqual(getAccessMethod(req1), 'lan');

      // Should redirect to /login (trust page removed)
      const check1 = checkHttpsEnforcement(req1, '/', isPublicPath, mockIsHttpsConnection);
      assert.strictEqual(check1.redirect, '/login');

      // User accesses via HTTPS after logging in
      const req2 = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002',
        encrypted: true,
        url: '/login'
      });

      // Should allow HTTPS access
      const check2 = checkHttpsEnforcement(req2, '/login', isPublicPath, mockIsHttpsConnection);
      assert.strictEqual(check2, null);

      // Static files should work
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');
      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
    });

    it('handles ngrok user accessing login page', () => {
      // User visits felix-katulong.ngrok.app/login
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app',
        url: '/login'
      });

      // Should detect internet
      assert.strictEqual(getAccessMethod(req), 'internet');

      // Should allow login page over HTTP (ngrok terminates TLS)
      const check = checkHttpsEnforcement(req, '/login', isPublicPath, mockIsHttpsConnection);
      assert.strictEqual(check, null);

      // Should serve login.js correctly
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');
      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
    });

    it('handles localhost development', () => {
      // Developer accessing localhost:3001
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        url: '/'
      });

      // Should detect localhost
      assert.strictEqual(getAccessMethod(req), 'localhost');

      // Should allow everything
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath, mockIsHttpsConnection), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath, mockIsHttpsConnection), null);

      // Static files should work
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/login.js');
      assert.strictEqual(served, true);
    });
  });

  // Cleanup
  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
});
