/**
 * Tests for the command palette's pure ranking helpers.
 *
 * scoreMatch / rankProviders live in public/lib/command-palette.js.
 * They have zero DOM dependencies so they can be unit-tested directly
 * under Node — same pattern as keyboard-spec.test.js or palette.test.js.
 *
 * The factory itself (createCommandPalette) is DOM-bound and is covered
 * by manual verification + future Playwright e2e. We only pin the
 * matcher contract here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scoreMatch, rankProviders } from "../public/lib/command-palette.js";

const provider = (id, fields = {}) => ({
  id,
  title: id,
  run: () => {},
  ...fields,
});

describe("scoreMatch", () => {
  it("returns >0 for matching prefix", () => {
    const p = provider("toggle-theme", { title: "Toggle theme" });
    assert.ok(scoreMatch("tog", p) > 0);
    assert.ok(scoreMatch("Tog", p) > 0, "case insensitive");
  });

  it("returns 0 for no match", () => {
    const p = provider("toggle-theme", { title: "Toggle theme" });
    assert.equal(scoreMatch("xyz", p), 0);
  });

  it("ranks prefix higher than subsequence", () => {
    const p = provider("toggle-theme", { title: "Toggle theme" });
    const prefixScore = scoreMatch("tog", p);
    const subseqScore = scoreMatch("tge", p);
    assert.ok(prefixScore > subseqScore);
  });

  it("matches against keywords", () => {
    const p = provider("p", { title: "Toggle X", keywords: ["dark", "light"] });
    assert.ok(scoreMatch("dark", p) > 0);
  });

  it("matches against category", () => {
    const p = provider("p", { title: "Foo", category: "Appearance" });
    assert.ok(scoreMatch("appearance", p) > 0);
  });

  it("matches against subtitle", () => {
    const p = provider("p", { title: "Foo", subtitle: "Open the search bar" });
    assert.ok(scoreMatch("search", p) > 0);
  });

  it("title weight > keyword weight (same query)", () => {
    const titleHit = provider("a", { title: "Search" });
    const keywordHit = provider("b", { title: "Foo", keywords: ["search"] });
    assert.ok(scoreMatch("search", titleHit) > scoreMatch("search", keywordHit));
  });

  it("empty query returns a non-zero baseline so all providers match", () => {
    const p = provider("p", { title: "Anything" });
    assert.ok(scoreMatch("", p) > 0);
  });

  it("requires every needle char to appear in order for subsequence match", () => {
    const p = provider("p", { title: "abcdef" });
    assert.ok(scoreMatch("ace", p) > 0, "in-order subsequence matches");
    assert.equal(scoreMatch("eca", p), 0, "out-of-order subsequence does not match");
  });
});

describe("rankProviders", () => {
  const providers = [
    provider("a", { title: "Toggle theme", category: "Appearance" }),
    provider("b", { title: "Toggle vibrancy", category: "Appearance" }),
    provider("c", { title: "Find in terminal", category: "Terminal" }),
  ];

  it("empty query returns providers in insertion order", () => {
    const r = rankProviders("", providers);
    assert.deepEqual(r.map((p) => p.id), ["a", "b", "c"]);
  });

  it("filters out providers with score 0", () => {
    const r = rankProviders("xyz", providers);
    assert.equal(r.length, 0);
  });

  it("ranks more relevant matches higher", () => {
    const r = rankProviders("find", providers);
    assert.equal(r[0].id, "c");
  });

  it("returns prefix matches above subsequence-only matches", () => {
    const r = rankProviders("tog", providers);
    assert.equal(r[0].id, "a"); // "Toggle theme" comes alphabetically first
    assert.equal(r[1].id, "b");
    assert.equal(r.length, 2);  // "c" doesn't match "tog"
  });

  it("ties are broken stably (insertion order)", () => {
    // Both "a" and "b" start with "Toggle " — same prefix score on "toggle"
    const r = rankProviders("toggle", providers);
    assert.deepEqual(r.map((p) => p.id), ["a", "b"]);
  });

  it("category match surfaces relevant providers", () => {
    const r = rankProviders("appearance", providers);
    assert.equal(r.length, 2);
    assert.ok(r.every((p) => p.category === "Appearance"));
  });

  it("does not mutate the input array", () => {
    const arr = providers.slice();
    rankProviders("tog", arr);
    assert.deepEqual(arr.map((p) => p.id), ["a", "b", "c"]);
  });
});
