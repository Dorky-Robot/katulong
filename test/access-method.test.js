import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isLocalRequest,
  getAccessMethod,
  getAccessDescription
} from '../lib/access-method.js';

function mockRequest({ remoteAddress, host, origin }) {
  return {
    socket: { remoteAddress },
    headers: {
      host: host || undefined,
      origin: origin || undefined
    }
  };
}

describe('access-method', () => {
  describe('isLocalRequest', () => {
    it('returns true for localhost with localhost host header', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns true for localhost without port', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns true for 127.0.0.1 with matching host', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: '127.0.0.1:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns true for IPv6 localhost', () => {
      const req = mockRequest({
        remoteAddress: '::1',
        host: '[::1]:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns true for IPv6-mapped IPv4 localhost', () => {
      const req = mockRequest({
        remoteAddress: '::ffff:127.0.0.1',
        host: 'localhost:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns false for ngrok (loopback socket, external host)', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app'
      });
      assert.strictEqual(isLocalRequest(req), false, 'ngrok should NOT be treated as localhost');
    });

    it('returns false for Cloudflare Tunnel', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'katulong.example.com'
      });
      assert.strictEqual(isLocalRequest(req), false);
    });

    it('returns false for LAN IP address', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: '192.168.1.50:3001'
      });
      assert.strictEqual(isLocalRequest(req), false);
    });

    it('returns false for external origin header (SECURITY)', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: 'https://evil.com'
      });
      assert.strictEqual(isLocalRequest(req), false, 'external origin should prevent localhost detection');
    });

    it('returns true for localhost origin with localhost host', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: 'http://localhost:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('returns true when origin is absent', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: undefined
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('handles missing headers gracefully', () => {
      const req = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {}
      };
      assert.strictEqual(isLocalRequest(req), false, 'missing host header should fail safe');
    });

    it('handles missing socket address gracefully', () => {
      const req = {
        socket: {},
        headers: { host: 'localhost' }
      };
      assert.strictEqual(isLocalRequest(req), false);
    });
  });

  describe('getAccessMethod', () => {
    it('returns "localhost" for localhost requests', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001'
      });
      assert.strictEqual(getAccessMethod(req), 'localhost');
    });

    it('returns "internet" for LAN/private IP (no LAN classification)', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: '192.168.1.50:3001'
      });
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('returns "internet" for ngrok', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app'
      });
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('returns "internet" for Cloudflare Tunnel', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'katulong.example.com'
      });
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('returns "internet" for public domain', () => {
      const req = mockRequest({
        remoteAddress: '8.8.8.8',
        host: 'example.com'
      });
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('returns "localhost" for loopback socket with localhost host header', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: '127.0.0.1:3001'
      });
      assert.strictEqual(getAccessMethod(req), 'localhost');
    });
  });

  describe('getAccessDescription', () => {
    it('returns descriptive string for localhost', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001'
      });
      const desc = getAccessDescription(req);
      assert.ok(desc.includes('localhost'));
      assert.ok(desc.includes('127.0.0.1'));
    });

    it('returns descriptive string for internet (private IP classified as internet)', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: '192.168.1.50:3002'
      });
      const desc = getAccessDescription(req);
      assert.ok(desc.includes('internet'));
    });

    it('returns descriptive string for internet', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'felix-katulong.ngrok.app'
      });
      const desc = getAccessDescription(req);
      assert.ok(desc.includes('internet'));
      assert.ok(desc.includes('ngrok.app'));
    });

    it('handles missing data gracefully', () => {
      const req = { socket: {}, headers: {} };
      const desc = getAccessDescription(req);
      assert.ok(typeof desc === 'string');
      assert.ok(desc.length > 0);
    });
  });

  describe('edge cases', () => {
    it('handles case-insensitive host headers', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'LOCALHOST:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('handles IPv6 format variations', () => {
      const req1 = mockRequest({
        remoteAddress: '::1',
        host: '::1'
      });
      assert.strictEqual(isLocalRequest(req1), false, '::1 without brackets should fail');

      const req2 = mockRequest({
        remoteAddress: '::1',
        host: '[::1]'
      });
      assert.strictEqual(isLocalRequest(req2), true, '[::1] with brackets should work');
    });

    it('treats missing remoteAddress as non-local', () => {
      const req = mockRequest({
        remoteAddress: undefined,
        host: 'localhost'
      });
      assert.strictEqual(isLocalRequest(req), false);
    });

    it('treats empty remoteAddress as non-local', () => {
      const req = mockRequest({
        remoteAddress: '',
        host: 'localhost'
      });
      assert.strictEqual(isLocalRequest(req), false);
    });
  });

  describe('security test cases', () => {
    it('prevents ngrok bypass via localhost host spoofing', () => {
      // Attacker tries to spoof Host header to bypass auth
      const req = mockRequest({
        remoteAddress: '8.8.8.8', // External IP
        host: 'localhost:3001'   // Spoofed header
      });
      assert.strictEqual(isLocalRequest(req), false, 'external IP should prevent localhost detection');
    });

    it('prevents reverse proxy bypass', () => {
      // Real scenario: ngrok forwards to 127.0.0.1 but should not be treated as localhost
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'attacker.ngrok.io'
      });
      assert.strictEqual(isLocalRequest(req), false);
      assert.strictEqual(getAccessMethod(req), 'internet');
    });

    it('prevents origin header bypass', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: 'https://evil.com'
      });
      assert.strictEqual(isLocalRequest(req), false, 'malicious origin should prevent localhost');
    });

    it('allows legitimate localhost requests', () => {
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: 'http://localhost:3001'
      });
      assert.strictEqual(isLocalRequest(req), true);
    });

    it('allows localhost requests without origin header', () => {
      // Most browsers don't send Origin on navigation (only on CORS requests)
      const req = mockRequest({
        remoteAddress: '127.0.0.1',
        host: 'localhost:3001',
        origin: undefined
      });
      assert.strictEqual(isLocalRequest(req), true);
    });
  });
});
