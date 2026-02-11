import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isLocalRequest,
  isLanRequest,
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

  describe('isLanRequest', () => {
    it('returns true for .local mDNS domain', () => {
      const req = mockRequest({ host: 'katulong.local:3002' });
      assert.strictEqual(isLanRequest(req), true);
    });

    it('returns true for .local without port', () => {
      const req = mockRequest({ host: 'katulong.local' });
      assert.strictEqual(isLanRequest(req), true);
    });

    it('returns true for 192.168.x.x (RFC 1918)', () => {
      const req = mockRequest({ host: '192.168.1.50:3001' });
      assert.strictEqual(isLanRequest(req), true);
    });

    it('returns true for 10.x.x.x (RFC 1918)', () => {
      const req = mockRequest({ host: '10.0.0.5:3001' });
      assert.strictEqual(isLanRequest(req), true);
    });

    it('returns true for 172.16-31.x.x (RFC 1918)', () => {
      assert.strictEqual(isLanRequest(mockRequest({ host: '172.16.0.1' })), true);
      assert.strictEqual(isLanRequest(mockRequest({ host: '172.20.5.10' })), true);
      assert.strictEqual(isLanRequest(mockRequest({ host: '172.31.255.255' })), true);
    });

    it('returns false for 172.15.x.x (not in private range)', () => {
      const req = mockRequest({ host: '172.15.0.1' });
      assert.strictEqual(isLanRequest(req), false);
    });

    it('returns false for 172.32.x.x (not in private range)', () => {
      const req = mockRequest({ host: '172.32.0.1' });
      assert.strictEqual(isLanRequest(req), false);
    });

    it('returns true for 169.254.x.x (link-local)', () => {
      const req = mockRequest({ host: '169.254.100.1' });
      assert.strictEqual(isLanRequest(req), true);
    });

    it('returns false for localhost hosts (should be handled by isLocalRequest)', () => {
      // Localhost hosts without loopback socket should NOT be treated as LAN
      // This prevents bypass where attacker uses "localhost" host header from remote IP
      assert.strictEqual(isLanRequest(mockRequest({ host: 'localhost' })), false);
      assert.strictEqual(isLanRequest(mockRequest({ host: '127.0.0.1' })), false);
      assert.strictEqual(isLanRequest(mockRequest({ host: '[::1]' })), false);
    });

    it('returns false for public domain', () => {
      const req = mockRequest({ host: 'example.com' });
      assert.strictEqual(isLanRequest(req), false);
    });

    it('returns false for ngrok domain', () => {
      const req = mockRequest({ host: 'felix-katulong.ngrok.app' });
      assert.strictEqual(isLanRequest(req), false);
    });

    it('returns false for public IP', () => {
      const req = mockRequest({ host: '8.8.8.8' });
      assert.strictEqual(isLanRequest(req), false);
    });

    it('handles missing host header gracefully', () => {
      const req = { headers: {} };
      assert.strictEqual(isLanRequest(req), false);
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

    it('returns "lan" for .local domain', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002'
      });
      assert.strictEqual(getAccessMethod(req), 'lan');
    });

    it('returns "lan" for private IP', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: '192.168.1.50:3001'
      });
      assert.strictEqual(getAccessMethod(req), 'lan');
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

    it('prioritizes localhost over lan', () => {
      // localhost host should return "localhost" even though it's also considered LAN
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

    it('returns descriptive string for LAN', () => {
      const req = mockRequest({
        remoteAddress: '192.168.1.100',
        host: 'katulong.local:3002'
      });
      const desc = getAccessDescription(req);
      assert.ok(desc.includes('lan'));
      assert.ok(desc.includes('katulong.local'));
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

    it('handles case-insensitive .local domains', () => {
      const req = mockRequest({ host: 'Katulong.LOCAL:3002' });
      assert.strictEqual(isLanRequest(req), true);
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
