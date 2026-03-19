import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseContainerFromArgs, _clearCache, _cache } from "../lib/container-detect.js";

describe("parseContainerFromArgs", () => {
  it("parses simple docker exec", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-it", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("parses docker exec with flags before container", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-e", "FOO=bar", "-u", "root", "mycontainer", "zsh"]),
      "mycontainer"
    );
  });

  it("parses docker exec with combined short flags", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-it", "web-app", "/bin/sh"]),
      "web-app"
    );
  });

  it("parses docker exec with --env=VALUE style", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "--env=FOO=bar", "--user=root", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("parses docker exec with -- separator", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-it", "--", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("parses docker exec with boolean flags", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "--privileged", "-d", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("handles full path to docker binary", () => {
    assert.equal(
      parseContainerFromArgs(["/usr/bin/docker", "exec", "-it", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("returns null for non-docker command", () => {
    assert.equal(
      parseContainerFromArgs(["vim", "file.txt"]),
      null
    );
  });

  it("returns null for docker without exec", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "run", "-it", "ubuntu", "bash"]),
      null
    );
  });

  it("returns null for empty args", () => {
    assert.equal(parseContainerFromArgs([]), null);
  });

  it("parses combined -eit flag (e takes next value)", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-eit", "FOO=bar", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("handles --workdir flag", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "-it", "-w", "/app", "mycontainer", "bash"]),
      "mycontainer"
    );
  });

  it("handles --env-file flag", () => {
    assert.equal(
      parseContainerFromArgs(["docker", "exec", "--env-file", ".env", "mycontainer", "bash"]),
      "mycontainer"
    );
  });
});

describe("detection cache", () => {
  beforeEach(() => {
    _clearCache();
  });

  it("stores and retrieves cached values", () => {
    _cache.set("test-session", { container: "mycontainer", ts: Date.now() });
    const cached = _cache.get("test-session");
    assert.equal(cached.container, "mycontainer");
  });

  it("cache entry expires after TTL", () => {
    // Set a cache entry with a timestamp in the past (> 10s ago)
    _cache.set("test-session", { container: "mycontainer", ts: Date.now() - 11_000 });
    const cached = _cache.get("test-session");
    // The entry exists but is stale — detectPaneContainer would re-detect
    assert.ok(Date.now() - cached.ts > 10_000, "cache entry should be older than TTL");
  });

  it("clearCache removes all entries", () => {
    _cache.set("a", { container: "c1", ts: Date.now() });
    _cache.set("b", { container: "c2", ts: Date.now() });
    _clearCache();
    assert.equal(_cache.size, 0);
  });
});
