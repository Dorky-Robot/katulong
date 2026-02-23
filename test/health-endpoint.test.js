import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPublicPath } from "../lib/http-util.js";

describe("health endpoint", () => {
  describe("isPublicPath", () => {
    it("allows /health as a public path", () => {
      assert.equal(isPublicPath("/health"), true);
    });

    it("does not allow /health-check (only exact match)", () => {
      assert.equal(isPublicPath("/health-check"), false);
    });

    it("does not allow /healthz (only exact match)", () => {
      assert.equal(isPublicPath("/healthz"), false);
    });
  });
});
