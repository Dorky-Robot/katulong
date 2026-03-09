import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Success, Failure } from "../lib/result.js";

describe("Success", () => {
  it("creates success result with data", () => {
    const result = new Success({ value: 42 });
    assert.equal(result.success, true);
    assert.deepEqual(result.data, { value: 42 });
  });

  it("works with null data", () => {
    const result = new Success(null);
    assert.equal(result.success, true);
    assert.equal(result.data, null);
  });

  it("works with undefined data", () => {
    const result = new Success(undefined);
    assert.equal(result.success, true);
    assert.equal(result.data, undefined);
  });

  it("works with complex objects", () => {
    const data = { session: { token: "abc" }, state: { user: "test" } };
    const result = new Success(data);
    assert.deepEqual(result.data, data);
  });
});

describe("Failure", () => {
  it("creates failure result with reason and message", () => {
    const result = new Failure("test-reason", "Test message");
    assert.equal(result.success, false);
    assert.equal(result.reason, "test-reason");
    assert.equal(result.message, "Test message");
    assert.equal(result.statusCode, 400);
  });

  it("accepts custom status code", () => {
    const result = new Failure("forbidden", "Access denied", 403);
    assert.equal(result.statusCode, 403);
  });

  it("accepts metadata", () => {
    const metadata = { field: "email", value: "invalid" };
    const result = new Failure("validation-error", "Invalid email", 400, metadata);
    assert.deepEqual(result.metadata, metadata);
  });

  it("defaults metadata to empty object", () => {
    const result = new Failure("error", "Message");
    assert.deepEqual(result.metadata, {});
  });
});

describe("Result pattern matching", () => {
  it("distinguishes success from failure via .success", () => {
    const ok = new Success("data");
    const err = new Failure("error", "Message");
    assert.equal(ok.success, true);
    assert.equal(err.success, false);
  });

  it("handles validation results", () => {
    function validate(age) {
      if (age < 0) return new Failure("negative-age", "Age cannot be negative");
      return new Success(age);
    }

    const valid = validate(25);
    assert.equal(valid.success, true);
    assert.equal(valid.data, 25);

    const invalid = validate(-1);
    assert.equal(invalid.success, false);
    assert.equal(invalid.reason, "negative-age");
  });
});
