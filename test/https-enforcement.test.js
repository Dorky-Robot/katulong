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
  const publicPrefixes = ["/vendor/"];
  return publicPaths.includes(pathname) || publicPrefixes.some(p => pathname.startsWith(p));
}

function mockValidateSession(req) {
  // Simple mock: check if there's a "valid_session" marker in URL
  return req.url?.includes("?session=valid") || false;
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


describe('https-enforcement', () => {
  describe('HTTP_ALLOWED_PATHS', () => {
    it('is empty (trust flow removed)', () => {
      assert.strictEqual(HTTP_ALLOWED_PATHS.length, 0);
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
        const result = checkHttpsEnforcement(req, '/any/path', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });
    });

    describe('localhost access', () => {
      it('allows all HTTP requests from localhost', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'localhost:3001'
        });
        const result = checkHttpsEnforcement(req, '/any/path', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });

      it('allows protected paths over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'localhost:3001'
        });
        const result = checkHttpsEnforcement(req, '/protected/api', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });
    });

    describe('LAN access', () => {
      it('redirects public paths to HTTPS', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001',
          url: '/login'
        });
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath, mockIsHttpsConnection);
        assert.ok(result?.redirect);
        assert.ok(result.redirect.startsWith('https://'));
        assert.ok(result.redirect.includes('katulong.local'));
      });

      it('redirects protected paths to /login', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: '192.168.1.50:3001',
          url: '/api/sessions'
        });
        const result = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath, mockIsHttpsConnection);
        assert.deepStrictEqual(result, { redirect: '/login' });
      });

      it('strips port from redirect URL', () => {
        const req = mockRequest({
          remoteAddress: '192.168.1.100',
          host: 'katulong.local:3001',
          url: '/login'
        });
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath, mockIsHttpsConnection);
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
        const result = checkHttpsEnforcement(req, '/login', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });

      it('allows static assets over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app'
        });
        const result = checkHttpsEnforcement(req, '/login.js', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });

      it('allows protected paths (ngrok provides HTTPS)', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app',
          url: '/api/sessions'
        });
        const result = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath, mockIsHttpsConnection);
        // ngrok is treated as HTTPS, so no redirect required
        assert.strictEqual(result, null);
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

    it('returns /login for LAN over HTTP', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        encrypted: false
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
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
    it('handles first-time LAN access (redirects to /login)', () => {
      // User visits LAN over HTTP for first time
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3001',
        url: '/'
      });

      // HTTPS enforcement: Should redirect to /login (trust page removed)
      const httpsCheck = checkHttpsEnforcement(req, '/', mockIsPublicPath, mockIsHttpsConnection);
      assert.deepStrictEqual(httpsCheck, { redirect: '/login' });
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
      const httpsCheck = checkHttpsEnforcement(req, '/login', mockIsPublicPath, mockIsHttpsConnection);
      assert.strictEqual(httpsCheck, null);
    });

    it('handles ngrok access to protected path', () => {
      // User tries to access protected path over HTTP via ngrok
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app',
        url: '/api/sessions'
      });

      // HTTPS enforcement: ngrok is treated as HTTPS, so no redirect
      const httpsCheck = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath, mockIsHttpsConnection);
      assert.strictEqual(httpsCheck, null);

      // Auth redirect: Unauthenticated users should still redirect to /login
      const authRedirect = getUnauthenticatedRedirect(req);
      assert.strictEqual(authRedirect, '/login');
    });
  });
});
