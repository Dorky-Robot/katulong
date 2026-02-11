import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  HTTP_ALLOWED_PATHS,
  checkHttpsEnforcement,
  getUnauthenticatedRedirect,
  checkSessionHttpsRedirect
} from '../lib/https-enforcement.js';

function mockRequest({ remoteAddress, host, origin, encrypted = false, url = "/" }) {
  return {
    socket: { remoteAddress, encrypted },
    headers: {
      host: host || undefined,
      origin: origin || undefined
    },
    url
  };
}

function mockIsPublicPath(pathname) {
  const publicPaths = ["/login", "/login.html", "/login.js", "/login.css"];
  const publicPrefixes = ["/connect/trust", "/vendor/"];
  return publicPaths.includes(pathname) || publicPrefixes.some(p => pathname.startsWith(p));
}

function mockValidateSession(req) {
  // Simple mock: check if there's a "valid_session" marker in URL
  return req.url?.includes("?session=valid") || false;
}

describe('https-enforcement', () => {
  describe('HTTP_ALLOWED_PATHS', () => {
    it('contains certificate installation paths', () => {
      assert.ok(HTTP_ALLOWED_PATHS.includes('/connect/trust'));
      assert.ok(HTTP_ALLOWED_PATHS.includes('/connect/trust/ca.crt'));
      assert.ok(HTTP_ALLOWED_PATHS.includes('/connect/trust/ca.mobileconfig'));
    });

    it('is a minimal set (security)', () => {
      // Should only contain cert installation paths, nothing else
      assert.strictEqual(HTTP_ALLOWED_PATHS.length, 3);
    });
  });

  describe('checkHttpsEnforcement', () => {
    describe('HTTPS requests', () => {
      it('allows all HTTPS requests (no enforcement needed)', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3002',
          encrypted: true
        });
        const result = checkHttpsEnforcement(req, '/any/path', mockIsPublicPath);
        assert.strictEqual(result, null);
      });
    });

    describe('localhost access', () => {
      it('allows all HTTP requests from localhost', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'localhost:3001'
        });
        const result = checkHttpsEnforcement(req, '/any/path', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('allows protected paths over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'localhost:3001'
        });
        const result = checkHttpsEnforcement(req, '/protected/api', mockIsPublicPath);
        assert.strictEqual(result, null);
      });
    });

    describe('certificate installation paths', () => {
      it('allows /connect/trust over HTTP on LAN', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('allows /connect/trust/ca.crt over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: '192.168.1.50:3001'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust/ca.crt', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('allows cert paths over HTTP even on internet access', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust/ca.mobileconfig', mockIsPublicPath);
        assert.strictEqual(result, null);
      });
    });

    describe('LAN access', () => {
      it('allows public paths over HTTP at /connect/trust', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust/index.html', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('redirects public paths to HTTPS (not /connect/trust)', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001',
          url: '/login'
        });
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath);
        assert.ok(result?.redirect);
        assert.ok(result.redirect.startsWith('https://'));
        assert.ok(result.redirect.includes('katulong.local'));
      });

      it('redirects protected paths to /connect/trust', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: '192.168.1.50:3001',
          url: '/api/sessions'
        });
        const result = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath);
        assert.deepStrictEqual(result, { redirect: '/connect/trust' });
      });

      it('strips port from redirect URL', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001',
          url: '/login'
        });
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath);
        assert.ok(result.redirect.includes('katulong.local:3002')); // HTTPS port
        assert.ok(!result.redirect.includes(':3001')); // Not HTTP port
      });
    });

    describe('internet access (ngrok)', () => {
      it('allows public paths over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app'
        });
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('allows static assets over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app'
        });
        const result = checkHttpsEnforcement(req, '/login.js', mockIsPublicPath);
        assert.strictEqual(result, null);
      });

      it('redirects protected paths to /login', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app',
          url: '/api/sessions'
        });
        const result = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath);
        assert.deepStrictEqual(result, { redirect: '/login' });
      });
    });
  });

  describe('getUnauthenticatedRedirect', () => {
    it('returns /login for localhost', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001'
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
    });

    it('returns /connect/trust for LAN over HTTP', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        encrypted: false
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/connect/trust');
    });

    it('returns /login for LAN over HTTPS', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002',
        encrypted: true
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
    });

    it('returns /login for internet access', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app'
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
    });
  });

  describe('checkSessionHttpsRedirect', () => {
    it('returns null for HTTPS requests', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002',
        encrypted: true,
        url: '/api/sessions'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('returns null for localhost', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        url: '/api/sessions'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('returns null for public paths', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/login'
      });
      const result = checkSessionHttpsRedirect(req, '/login', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('returns null for cert installation paths', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/connect/trust'
      });
      const result = checkSessionHttpsRedirect(req, '/connect/trust', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('returns null for users without valid session', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/api/sessions'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('redirects to HTTPS for users with valid session', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/api/sessions?session=valid'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.ok(result?.redirect);
      assert.ok(result.redirect.startsWith('https://'));
      assert.ok(result.redirect.includes('katulong.local:3002'));
      assert.ok(result.redirect.includes('/api/sessions'));
    });

    it('preserves query string in redirect', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/api/sessions?session=valid&foo=bar'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.ok(result.redirect.includes('?session=valid&foo=bar'));
    });
  });

  describe('integration scenarios', () => {
    it('handles first-time LAN access flow', () => {
      // User visits LAN over HTTP for first time
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/'
      });

      // HTTPS enforcement: Should redirect to /connect/trust
      const httpsCheck = checkHttpsEnforcement(req, '/', mockIsPublicPath);
      assert.deepStrictEqual(httpsCheck, { redirect: '/connect/trust' });

      // After redirect, user is on /connect/trust
      const trustReq = { ...req, url: '/connect/trust' };
      const trustCheck = checkHttpsEnforcement(trustReq, '/connect/trust', mockIsPublicPath);
      assert.strictEqual(trustCheck, null); // Allowed
    });

    it('handles returning LAN user with session', () => {
      // User visits LAN over HTTP with valid session (cert already installed)
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/?session=valid'
      });

      // Session-based HTTPS redirect: Should redirect to HTTPS
      const sessionCheck = checkSessionHttpsRedirect(req, '/', mockIsPublicPath, mockValidateSession);
      assert.ok(sessionCheck.redirect.startsWith('https://'));
    });

    it('handles ngrok access to login page', () => {
      // User visits ngrok /login over HTTP (ngrok terminates TLS upstream)
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app',
        url: '/login'
      });

      // HTTPS enforcement: Should allow (public path on internet)
      const httpsCheck = checkHttpsEnforcement(req, '/login', mockIsPublicPath);
      assert.strictEqual(httpsCheck, null);
    });

    it('handles ngrok access to protected path', () => {
      // User tries to access protected path over HTTP via ngrok
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app',
        url: '/api/sessions'
      });

      // HTTPS enforcement: Should redirect to /login
      const httpsCheck = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath);
      assert.deepStrictEqual(httpsCheck, { redirect: '/login' });

      // Auth redirect: Should also go to /login
      const authRedirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(authRedirect, '/login');
    });
  });
});
