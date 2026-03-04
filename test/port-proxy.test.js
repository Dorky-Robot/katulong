import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validatePort, stripKatulongCookies, rewriteProxiedHtml, rewriteLocation } from "../lib/port-proxy.js";

describe("validatePort", () => {
  it("accepts valid ports", () => {
    assert.equal(validatePort("80", 3001), 80);
    assert.equal(validatePort("7070", 3001), 7070);
    assert.equal(validatePort("65535", 3001), 65535);
    assert.equal(validatePort("1", 3001), 1);
  });

  it("rejects port 0", () => {
    assert.equal(validatePort("0", 3001), null);
  });

  it("rejects ports above 65535", () => {
    assert.equal(validatePort("65536", 3001), null);
    assert.equal(validatePort("99999", 3001), null);
  });

  it("rejects non-numeric strings", () => {
    assert.equal(validatePort("abc", 3001), null);
    assert.equal(validatePort("", 3001), null);
    assert.equal(validatePort("12ab", 3001), null);
  });

  it("rejects leading zeros", () => {
    assert.equal(validatePort("07070", 3001), null);
  });

  it("rejects decimal numbers", () => {
    assert.equal(validatePort("3.14", 3001), null);
  });

  it("rejects Katulong's own port", () => {
    assert.equal(validatePort("3001", 3001), null);
  });

  it("allows port that is not Katulong's own", () => {
    assert.equal(validatePort("3001", 3002), 3001);
  });

  it("rejects negative ports", () => {
    assert.equal(validatePort("-1", 3001), null);
  });
});

describe("stripKatulongCookies", () => {
  it("removes katulong_session from cookies", () => {
    const input = "katulong_session=abc123; other=value";
    assert.equal(stripKatulongCookies(input), "other=value");
  });

  it("preserves other cookies", () => {
    const input = "foo=bar; baz=qux";
    assert.equal(stripKatulongCookies(input), "foo=bar; baz=qux");
  });

  it("handles cookie header with only katulong_session", () => {
    assert.equal(stripKatulongCookies("katulong_session=abc123"), "");
  });

  it("handles empty string", () => {
    assert.equal(stripKatulongCookies(""), "");
  });

  it("handles undefined/null", () => {
    assert.equal(stripKatulongCookies(undefined), "");
    assert.equal(stripKatulongCookies(null), "");
  });

  it("handles multiple cookies with katulong_session in the middle", () => {
    const input = "a=1; katulong_session=secret; b=2";
    assert.equal(stripKatulongCookies(input), "a=1; b=2");
  });
});

describe("rewriteLocation", () => {
  const prefix = "/_proxy/7070/";

  it("rewrites root-relative paths", () => {
    assert.equal(rewriteLocation("/login", 7070, prefix), "/_proxy/7070/login");
  });

  it("rewrites root-relative path with query string", () => {
    assert.equal(rewriteLocation("/search?q=test", 7070, prefix), "/_proxy/7070/search?q=test");
  });

  it("rewrites absolute URL pointing at target", () => {
    assert.equal(
      rewriteLocation("http://127.0.0.1:7070/login", 7070, prefix),
      "/_proxy/7070/login"
    );
  });

  it("rewrites absolute URL with path, query, and hash", () => {
    assert.equal(
      rewriteLocation("http://127.0.0.1:7070/app?foo=bar#section", 7070, prefix),
      "/_proxy/7070/app?foo=bar#section"
    );
  });

  it("rewrites https absolute URL pointing at target", () => {
    assert.equal(
      rewriteLocation("https://127.0.0.1:7070/login", 7070, prefix),
      "/_proxy/7070/login"
    );
  });

  it("does not rewrite absolute URL pointing at a different host", () => {
    assert.equal(
      rewriteLocation("http://example.com/login", 7070, prefix),
      "http://example.com/login"
    );
  });

  it("does not rewrite absolute URL pointing at a different port", () => {
    assert.equal(
      rewriteLocation("http://127.0.0.1:9090/login", 7070, prefix),
      "http://127.0.0.1:9090/login"
    );
  });

  it("handles bare root redirect", () => {
    assert.equal(rewriteLocation("/", 7070, prefix), "/_proxy/7070/");
  });

  it("passes through relative paths unchanged", () => {
    assert.equal(rewriteLocation("next-page", 7070, prefix), "next-page");
  });

  it("passes through garbage strings unchanged", () => {
    assert.equal(rewriteLocation("not a url at all", 7070, prefix), "not a url at all");
  });
});

describe("rewriteProxiedHtml", () => {
  const prefix = "/_proxy/7070/";

  it("injects <base> tag and navigation script after <head>", () => {
    const html = "<html><head><title>Test</title></head><body></body></html>";
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes(`<head><base href="/_proxy/7070/"><script>`));
    assert.ok(result.includes(`</script><title>Test</title>`));
  });

  it("injects <base> tag after <head> with attributes", () => {
    const html = '<html><head lang="en"><title>Test</title></head></html>';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes(`<head lang="en"><base href="/_proxy/7070/">`));
  });

  it("injects at start if no <head>", () => {
    const html = "<div>Hello</div>";
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.startsWith(`<base href="/_proxy/7070/">`));
  });

  it("rewrites root-relative src attributes", () => {
    const html = '<head></head><img src="/images/logo.png">';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('src="/_proxy/7070/images/logo.png"'));
  });

  it("rewrites root-relative href attributes", () => {
    const html = '<head></head><a href="/about">';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('href="/_proxy/7070/about"'));
  });

  it("rewrites root-relative action attributes", () => {
    const html = '<head></head><form action="/submit">';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('action="/_proxy/7070/submit"'));
  });

  it("skips protocol-relative URLs (//)", () => {
    const html = '<head></head><script src="//cdn.example.com/lib.js"></script>';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('src="//cdn.example.com/lib.js"'));
  });

  it("skips absolute URLs (http/https)", () => {
    const html = '<head></head><a href="https://example.com">';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('href="https://example.com"'));
  });

  it("rewrites single-quoted attributes", () => {
    const html = "<head></head><img src='/images/logo.png'>";
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes("src='/_proxy/7070/images/logo.png'"));
  });

  it("handles multiple attributes in one document", () => {
    const html = '<head></head><link href="/style.css"><script src="/app.js"></script>';
    const result = rewriteProxiedHtml(html, prefix);
    assert.ok(result.includes('href="/_proxy/7070/style.css"'));
    assert.ok(result.includes('src="/_proxy/7070/app.js"'));
  });
});
