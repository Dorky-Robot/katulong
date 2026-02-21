import { describe, it } from 'node:test';
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
          host: 'katulong.example.com',
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

    describe('certificate installation paths', () => {
      it('allows /connect/trust over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'my-tunnel.trycloudflare.com'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });

      it('allows /connect/trust/ca.crt over HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'my-tunnel.trycloudflare.com'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust/ca.crt', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
      });

      it('allows cert paths over HTTP on internet access', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'felix-katulong.ngrok.app'
        });
        const result = checkHttpsEnforcement(req, '/connect/trust/ca.mobileconfig', mockIsPublicPath, mockIsHttpsConnection);
        assert.strictEqual(result, null);
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

      it('redirects protected paths to /login over plain HTTP', () => {
        const req = mockRequest({
          remoteAddress: '127.0.0.1',
          host: 'katulong.example.com',
          url: '/api/sessions'
        });
        const result = checkHttpsEnforcement(req, '/api/sessions', mockIsPublicPath, mockIsHttpsConnection);
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

    it('returns /login for internet access', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app'
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
    });

    it('returns /login for any non-localhost request', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.example.com'
      });
      assert.strictEqual(getUnauthenticatedRedirect(req), '/login');
    });
  });

  describe('checkSessionHttpsRedirect', () => {
    it('returns null for HTTPS requests', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'katulong.example.com',
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

    it('returns null for internet access (tunnel handles HTTPS at edge)', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app',
        url: '/api/sessions'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });

    it('returns null regardless of session validity', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'katulong.example.com',
        url: '/api/sessions?session=valid'
      });
      const result = checkSessionHttpsRedirect(req, '/api/sessions', mockIsPublicPath, mockValidateSession);
      assert.strictEqual(result, null);
    });
  });

  describe('integration scenarios', () => {
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
