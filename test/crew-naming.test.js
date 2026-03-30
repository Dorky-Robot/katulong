import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crewSessionName, parseCrewSession, isCrewSession } from "../lib/cli/commands/crew.js";

describe("crew session naming", () => {
  describe("crewSessionName", () => {
    it("joins project and worker with double-dash", () => {
      assert.equal(crewSessionName("myapp", "frontend"), "myapp--frontend");
    });

    it("handles hyphens in names", () => {
      assert.equal(crewSessionName("my-app", "api-server"), "my-app--api-server");
    });
  });

  describe("parseCrewSession", () => {
    it("splits on first double-dash", () => {
      const result = parseCrewSession("myapp--frontend");
      assert.deepEqual(result, { project: "myapp", worker: "frontend" });
    });

    it("handles worker names with hyphens", () => {
      const result = parseCrewSession("myapp--api-server");
      assert.deepEqual(result, { project: "myapp", worker: "api-server" });
    });

    it("handles double-dash in worker name", () => {
      // First -- is the separator; rest belongs to worker
      const result = parseCrewSession("proj--worker--extra");
      assert.deepEqual(result, { project: "proj", worker: "worker--extra" });
    });

    it("returns null for non-crew sessions", () => {
      assert.equal(parseCrewSession("regular-session"), null);
      assert.equal(parseCrewSession("no_separator"), null);
    });
  });

  describe("isCrewSession", () => {
    it("returns true for crew sessions", () => {
      assert.equal(isCrewSession("myapp--frontend"), true);
    });

    it("returns false for regular sessions", () => {
      assert.equal(isCrewSession("regular-session"), false);
    });
  });

  describe("round-trip", () => {
    it("parseCrewSession inverts crewSessionName", () => {
      const name = crewSessionName("katulong", "test-runner");
      const parsed = parseCrewSession(name);
      assert.deepEqual(parsed, { project: "katulong", worker: "test-runner" });
    });
  });
});
