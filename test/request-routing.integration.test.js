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
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath), null);
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

    it('allows /connect/trust over HTTP', () => {
      const check = checkHttpsEnforcement(req, '/connect/trust', isPublicPath);
      assert.strictEqual(check, null);
    });

    it('allows cert installation files over HTTP', () => {
      assert.strictEqual(checkHttpsEnforcement(req, '/connect/trust/ca.crt', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/connect/trust/ca.mobileconfig', isPublicPath), null);
    });

    it('redirects protected paths to /connect/trust', () => {
      const check = checkHttpsEnforcement(req, '/api/sessions', isPublicPath);
      assert.deepStrictEqual(check, { redirect: '/connect/trust' });
    });

    it('redirects unauthenticated users to /connect/trust', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/connect/trust');
    });

    it('serves static files from /connect/trust pages', () => {
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
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath), null);
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
      assert.strictEqual(checkHttpsEnforcement(req, '/login', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.html', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.js', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/login.css', isPublicPath), null);
    });

    it('redirects protected paths to /login', () => {
      const check = checkHttpsEnforcement(req, '/api/sessions', isPublicPath);
      assert.deepStrictEqual(check, { redirect: '/login' });
    });

    it('redirects unauthenticated users to /login', () => {
      const redirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(redirect, '/login');
    });

    it('NEVER redirects to /connect/trust (ngrok has valid cert)', () => {
      // Critical: Internet users should NEVER see certificate installation
      // because ngrok/cloudflare provide valid TLS certificates
      const rootCheck = checkHttpsEnforcement(req, '/', isPublicPath);
      const apiCheck = checkHttpsEnforcement(req, '/api/sessions', isPublicPath);
      const settingsCheck = checkHttpsEnforcement(req, '/settings', isPublicPath);

      // All protected paths should redirect to /login, NOT /connect/trust
      assert.strictEqual(rootCheck?.redirect, '/login', 'Root should redirect to /login, not /connect/trust');
      assert.strictEqual(apiCheck?.redirect, '/login', 'API should redirect to /login, not /connect/trust');
      assert.strictEqual(settingsCheck?.redirect, '/login', 'Settings should redirect to /login, not /connect/trust');

      // Unauthenticated redirect should also be /login
      const unauthRedirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(unauthRedirect, '/login', 'Unauth redirect should be /login, not /connect/trust');
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
  });

  describe('complete request flows', () => {
    it('handles first-time LAN user journey', () => {
      // User visits katulong.local:3001/ (HTTP)
      const req1 = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/'
      });

      // Should detect LAN
      assert.strictEqual(getAccessMethod(req1), 'lan');

      // Should redirect to /connect/trust
      const check1 = checkHttpsEnforcement(req1, '/', isPublicPath);
      assert.strictEqual(check1.redirect, '/connect/trust');

      // User follows redirect to /connect/trust
      const req2 = { ...req1, url: '/connect/trust' };
      const check2 = checkHttpsEnforcement(req2, '/connect/trust', isPublicPath);
      assert.strictEqual(check2, null); // Allowed

      // User downloads cert and accesses via HTTPS
      const req3 = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002',
        encrypted: true,
        url: '/login'
      });

      // Should allow HTTPS access
      const check3 = checkHttpsEnforcement(req3, '/login', isPublicPath);
      assert.strictEqual(check3, null);

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
      const check = checkHttpsEnforcement(req, '/login', isPublicPath);
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
      assert.strictEqual(checkHttpsEnforcement(req, '/', isPublicPath), null);
      assert.strictEqual(checkHttpsEnforcement(req, '/api/sessions', isPublicPath), null);

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
