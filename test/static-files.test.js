import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIME_TYPES,
  serveStaticFile,
  isStaticFileRequest,
  getMimeType,
  isSafePathname,
  clearFileCache
} from '../lib/static-files.js';

function mockResponse() {
  const headers = {};
  let statusCode = 200;
  let body = null;

  return {
    headers,
    statusCode,
    body,
    writeHead(code, hdrs) {
      statusCode = code;
      Object.assign(headers, hdrs);
    },
    end(data) {
      body = data;
    },
    getStatusCode() {
      return statusCode;
    },
    getHeader(name) {
      return headers[name];
    },
    getBody() {
      return body;
    }
  };
}

describe('static-files', () => {
  const testDir = join(process.cwd(), '.test-static-files');
  let publicDir;

  beforeEach(() => {
    // Create test directory structure
    publicDir = join(testDir, 'public');
    mkdirSync(publicDir, { recursive: true });

    // Create test files
    writeFileSync(join(publicDir, 'test.html'), '<html>test</html>');
    writeFileSync(join(publicDir, 'test.js'), 'console.log("test");');
    writeFileSync(join(publicDir, 'test.css'), 'body { color: red; }');
    writeFileSync(join(publicDir, 'test.json'), '{"test": true}');
    writeFileSync(join(publicDir, 'test.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));

    // Create vendor directory
    const vendorDir = join(publicDir, 'vendor');
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, 'lib.js'), 'export const version = "1.0.0";');

    // Create subdirectory
    const subDir = join(publicDir, 'sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'nested.html'), '<html>nested</html>');
  });

  afterEach(() => {
    clearFileCache();
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('MIME_TYPES', () => {
    it('has correct MIME type for JavaScript files', () => {
      assert.strictEqual(MIME_TYPES['.js'], 'application/javascript; charset=utf-8');
    });

    it('has correct MIME type for HTML files', () => {
      assert.strictEqual(MIME_TYPES['.html'], 'text/html; charset=utf-8');
    });

    it('has correct MIME type for CSS files', () => {
      assert.strictEqual(MIME_TYPES['.css'], 'text/css; charset=utf-8');
    });

    it('includes charset for text files', () => {
      assert.ok(MIME_TYPES['.html'].includes('charset=utf-8'));
      assert.ok(MIME_TYPES['.js'].includes('charset=utf-8'));
      assert.ok(MIME_TYPES['.css'].includes('charset=utf-8'));
    });

    it('does not include charset for binary files', () => {
      assert.ok(!MIME_TYPES['.png'].includes('charset'));
      assert.ok(!MIME_TYPES['.webp'].includes('charset'));
    });
  });

  describe('serveStaticFile', () => {
    it('serves an HTML file with correct MIME type', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.html');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getStatusCode(), 200);
      assert.strictEqual(res.getHeader('Content-Type'), 'text/html; charset=utf-8');
      assert.ok(res.getBody().toString().includes('<html>test</html>'));
    });

    it('serves a JavaScript file with correct MIME type', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.js');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/javascript; charset=utf-8');
      assert.ok(res.getBody().toString().includes('console.log'));
    });

    it('serves a CSS file with correct MIME type', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.css');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'text/css; charset=utf-8');
    });

    it('serves a JSON file with correct MIME type', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.json');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'application/json; charset=utf-8');
    });

    it('serves a PNG file with correct MIME type', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.png');

      assert.strictEqual(served, true);
      assert.strictEqual(res.getHeader('Content-Type'), 'image/png');
    });

    it('serves files from subdirectories', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/sub/nested.html');

      assert.strictEqual(served, true);
      assert.ok(res.getBody().toString().includes('nested'));
    });

    it('returns false for non-existent files', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/nonexistent.html');

      assert.strictEqual(served, false);
    });

    it('prevents path traversal with ..', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/../../../etc/passwd');

      assert.strictEqual(served, false);
    });

    it('prevents directory listing', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/sub');

      assert.strictEqual(served, false);
    });

    it('prevents directory listing with trailing slash', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/sub/');

      assert.strictEqual(served, false);
    });

    it('sets Content-Length header', () => {
      const res = mockResponse();
      serveStaticFile(res, publicDir, '/test.html');

      assert.ok(res.getHeader('Content-Length') > 0);
    });

    describe('caching', () => {
      it('sets immutable cache for vendor files', () => {
        const res = mockResponse();
        serveStaticFile(res, publicDir, '/vendor/lib.js');

        const cacheControl = res.getHeader('Cache-Control');
        assert.ok(cacheControl.includes('immutable'));
        assert.ok(cacheControl.includes('max-age=31536000'));
      });

      it('sets must-revalidate cache for app files', () => {
        const res = mockResponse();
        serveStaticFile(res, publicDir, '/test.js');

        const cacheControl = res.getHeader('Cache-Control');
        assert.ok(cacheControl.includes('must-revalidate'));
        assert.ok(cacheControl.includes('max-age=0'));
      });

      it('can disable caching', () => {
        const res = mockResponse();
        serveStaticFile(res, publicDir, '/test.js', { cacheControl: false });

        assert.strictEqual(res.getHeader('Cache-Control'), undefined);
      });

      it('allows custom max-age', () => {
        const res = mockResponse();
        serveStaticFile(res, publicDir, '/vendor/lib.js', { maxAge: 3600 });

        const cacheControl = res.getHeader('Cache-Control');
        assert.ok(cacheControl.includes('max-age=3600'));
      });
    });

    it('handles pathname with leading slash', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/test.html');

      assert.strictEqual(served, true);
    });

    it('handles pathname without leading slash', () => {
      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, 'test.html');

      assert.strictEqual(served, true);
    });
  });

  describe('isStaticFileRequest', () => {
    it('returns true for paths with file extensions', () => {
      assert.strictEqual(isStaticFileRequest('/test.html'), true);
      assert.strictEqual(isStaticFileRequest('/test.js'), true);
      assert.strictEqual(isStaticFileRequest('/vendor/lib.js'), true);
      assert.strictEqual(isStaticFileRequest('/sub/nested.css'), true);
    });

    it('returns false for paths without file extensions', () => {
      assert.strictEqual(isStaticFileRequest('/'), false);
      assert.strictEqual(isStaticFileRequest('/api/sessions'), false);
      assert.strictEqual(isStaticFileRequest('/login'), false);
    });

    it('returns false for directory paths', () => {
      assert.strictEqual(isStaticFileRequest('/vendor/'), false);
      assert.strictEqual(isStaticFileRequest('/sub/'), false);
    });
  });

  describe('getMimeType', () => {
    it('returns MIME type for extension with dot', () => {
      assert.strictEqual(getMimeType('.js'), 'application/javascript; charset=utf-8');
      assert.strictEqual(getMimeType('.html'), 'text/html; charset=utf-8');
    });

    it('returns MIME type for extension without dot', () => {
      assert.strictEqual(getMimeType('js'), 'application/javascript; charset=utf-8');
      assert.strictEqual(getMimeType('html'), 'text/html; charset=utf-8');
    });

    it('returns default MIME type for unknown extensions', () => {
      assert.strictEqual(getMimeType('.xyz'), 'application/octet-stream');
      assert.strictEqual(getMimeType('abc'), 'application/octet-stream');
    });
  });

  describe('isSafePathname', () => {
    it('allows normal paths', () => {
      assert.strictEqual(isSafePathname('/test.html'), true);
      assert.strictEqual(isSafePathname('/sub/nested.html'), true);
      assert.strictEqual(isSafePathname('/vendor/lib.js'), true);
    });

    it('rejects path traversal with ..', () => {
      assert.strictEqual(isSafePathname('/../etc/passwd'), false);
      assert.strictEqual(isSafePathname('/sub/../etc/passwd'), false);
      assert.strictEqual(isSafePathname('/test..html'), false);
    });

    it('rejects double slashes', () => {
      assert.strictEqual(isSafePathname('//etc/passwd'), false);
      assert.strictEqual(isSafePathname('/sub//file'), false);
    });

    it('rejects hidden files starting with .', () => {
      assert.strictEqual(isSafePathname('/.env'), false);
      assert.strictEqual(isSafePathname('/.git/config'), false);
      assert.strictEqual(isSafePathname('/.hidden'), false);
    });

    it('rejects hidden directories', () => {
      assert.strictEqual(isSafePathname('/sub/.hidden/file'), false);
      assert.strictEqual(isSafePathname('/.config/app/file'), false);
    });

    it('allows files with dots in the middle', () => {
      assert.strictEqual(isSafePathname('/test.min.js'), true);
      assert.strictEqual(isSafePathname('/jquery-3.6.0.js'), true);
    });

    it('allows extensions (dots at end)', () => {
      assert.strictEqual(isSafePathname('/test.html'), true);
      assert.strictEqual(isSafePathname('/sub/file.css'), true);
    });
  });

  describe('in-memory cache', () => {
    afterEach(() => {
      clearFileCache();
    });

    it('serves cached content on repeated requests', () => {
      const res1 = mockResponse();
      serveStaticFile(res1, publicDir, '/test.html');
      const body1 = res1.getBody();

      const res2 = mockResponse();
      serveStaticFile(res2, publicDir, '/test.html');
      const body2 = res2.getBody();

      assert.deepStrictEqual(body1, body2, "Second request should return same content");
    });

    it('invalidates cache when file mtime changes', async () => {
      const res1 = mockResponse();
      serveStaticFile(res1, publicDir, '/test.html');
      const body1 = res1.getBody().toString();

      // Wait to ensure mtime differs, then update file
      await new Promise(resolve => setTimeout(resolve, 50));
      writeFileSync(join(publicDir, 'test.html'), '<html>updated</html>');

      const res2 = mockResponse();
      serveStaticFile(res2, publicDir, '/test.html');
      const body2 = res2.getBody().toString();

      assert.ok(body2.includes('updated'), "Should serve updated content after file change");
      assert.notStrictEqual(body1, body2, "Content should differ after file change");
    });

    it('clearFileCache empties the cache', () => {
      // Populate the cache
      const res1 = mockResponse();
      serveStaticFile(res1, publicDir, '/test.html');

      // Clear it
      clearFileCache();

      // Should still serve the file (re-reads from disk)
      const res2 = mockResponse();
      const served = serveStaticFile(res2, publicDir, '/test.html');
      assert.strictEqual(served, true, "Should still serve after cache clear");
    });
  });

  describe('security tests', () => {
    it('prevents reading files outside publicDir via path traversal', () => {
      const res = mockResponse();

      // Try various path traversal techniques
      const attempts = [
        '../package.json',
        '../../package.json',
        '/../../package.json',
        'sub/../../package.json',
      ];

      for (const attempt of attempts) {
        const served = serveStaticFile(res, publicDir, attempt);
        assert.strictEqual(served, false, `Should block: ${attempt}`);
      }
    });

    it('prevents reading hidden files', () => {
      // Create a hidden file
      writeFileSync(join(publicDir, '.env'), 'SECRET=123');

      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/.env');

      assert.strictEqual(served, false);
    });

    it('prevents reading from hidden directories', () => {
      // Create a hidden directory
      const hiddenDir = join(publicDir, '.hidden');
      mkdirSync(hiddenDir, { recursive: true });
      writeFileSync(join(hiddenDir, 'secret.txt'), 'secret data');

      const res = mockResponse();
      const served = serveStaticFile(res, publicDir, '/.hidden/secret.txt');

      assert.strictEqual(served, false);
    });
  });
});
