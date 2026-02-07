import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Success,
  Failure,
  success,
  failure,
  isSuccess,
  isFailure,
} from "../lib/result.js";

describe("Success", () => {
  it("creates success result with data", () => {
    const result = new Success({ value: 42 });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, { value: 42 });
  });

  it("isSuccess returns true", () => {
    const result = new Success("data");

    assert.equal(result.isSuccess(), true);
  });

  it("isFailure returns false", () => {
    const result = new Success("data");

    assert.equal(result.isFailure(), false);
  });

  it("unwrap returns data", () => {
    const result = new Success("test-data");

    assert.equal(result.unwrap(), "test-data");
  });

  it("unwrapOr returns data, not default", () => {
    const result = new Success("actual");

    assert.equal(result.unwrapOr("default"), "actual");
  });

  it("map transforms success data", () => {
    const result = new Success(5);
    const mapped = result.map((n) => n * 2);

    assert.ok(mapped instanceof Success);
    assert.equal(mapped.data, 10);
  });

  it("flatMap chains operations", () => {
    const result = new Success(5);
    const chained = result.flatMap((n) => new Success(n * 2));

    assert.ok(chained instanceof Success);
    assert.equal(chained.data, 10);
  });

  it("flatMap can return failure", () => {
    const result = new Success(5);
    const chained = result.flatMap((n) => new Failure("error", "Failed"));

    assert.ok(chained instanceof Failure);
    assert.equal(chained.reason, "error");
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

    assert.deepEqual(result.unwrap(), data);
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

  it("isSuccess returns false", () => {
    const result = new Failure("error", "Message");

    assert.equal(result.isSuccess(), false);
  });

  it("isFailure returns true", () => {
    const result = new Failure("error", "Message");

    assert.equal(result.isFailure(), true);
  });

  it("unwrap throws error", () => {
    const result = new Failure("test-reason", "Test message");

    assert.throws(
      () => result.unwrap(),
      /test-reason: Test message/
    );
  });

  it("unwrapOr returns default value", () => {
    const result = new Failure("error", "Message");

    assert.equal(result.unwrapOr("default"), "default");
  });

  it("map returns self unchanged", () => {
    const result = new Failure("error", "Message");
    const mapped = result.map((x) => x * 2);

    assert.equal(mapped, result);
    assert.equal(mapped.reason, "error");
  });

  it("flatMap returns self unchanged", () => {
    const result = new Failure("error", "Message");
    const chained = result.flatMap((x) => new Success(x * 2));

    assert.equal(chained, result);
    assert.equal(chained.reason, "error");
  });
});

describe("isSuccess", () => {
  it("returns true for Success", () => {
    const result = new Success("data");

    assert.equal(isSuccess(result), true);
  });

  it("returns false for Failure", () => {
    const result = new Failure("error", "Message");

    assert.equal(isSuccess(result), false);
  });
});

describe("isFailure", () => {
  it("returns false for Success", () => {
    const result = new Success("data");

    assert.equal(isFailure(result), false);
  });

  it("returns true for Failure", () => {
    const result = new Failure("error", "Message");

    assert.equal(isFailure(result), true);
  });
});

describe("success helper", () => {
  it("creates Success instance", () => {
    const result = success({ value: 42 });

    assert.ok(result instanceof Success);
    assert.deepEqual(result.data, { value: 42 });
  });
});

describe("failure helper", () => {
  it("creates Failure instance", () => {
    const result = failure("error", "Message");

    assert.ok(result instanceof Failure);
    assert.equal(result.reason, "error");
    assert.equal(result.message, "Message");
  });

  it("accepts custom status code", () => {
    const result = failure("error", "Message", 500);

    assert.equal(result.statusCode, 500);
  });

  it("accepts metadata", () => {
    const metadata = { key: "value" };
    const result = failure("error", "Message", 400, metadata);

    assert.deepEqual(result.metadata, metadata);
  });
});

describe("Result chaining", () => {
  it("chains multiple map operations on Success", () => {
    const result = success(5)
      .map((n) => n * 2)
      .map((n) => n + 1)
      .map((n) => n.toString());

    assert.equal(result.unwrap(), "11");
  });

  it("stops chaining on first Failure", () => {
    const result = success(5)
      .flatMap((n) => success(n * 2))
      .flatMap((n) => failure("error", "Failed"))
      .map((n) => n + 100); // Should not execute

    assert.ok(isFailure(result));
    assert.equal(result.reason, "error");
  });

  it("unwrapOr provides fallback for failures", () => {
    const result = success(5)
      .flatMap((n) => failure("error", "Failed"))
      .unwrapOr(0);

    assert.equal(result, 0);
  });
});

describe("Real-world usage patterns", () => {
  it("handles validation chain", () => {
    function validateAge(age) {
      if (age < 0) return failure("negative-age", "Age cannot be negative");
      if (age > 150) return failure("invalid-age", "Age too high");
      return success(age);
    }

    function validateName(name) {
      if (!name) return failure("missing-name", "Name required");
      if (name.length > 50) return failure("name-too-long", "Name too long");
      return success(name);
    }

    const validResult = validateAge(25)
      .flatMap(() => validateName("John"));

    assert.ok(isSuccess(validResult));

    const invalidResult = validateAge(-1)
      .flatMap(() => validateName("John"));

    assert.ok(isFailure(invalidResult));
    assert.equal(invalidResult.reason, "negative-age");
  });

  it("handles async operation results", async () => {
    async function fetchUser(id) {
      if (id === 0) return failure("not-found", "User not found", 404);
      return success({ id, name: "Test User" });
    }

    const result = await fetchUser(1);
    assert.ok(isSuccess(result));
    assert.equal(result.data.name, "Test User");

    const errorResult = await fetchUser(0);
    assert.ok(isFailure(errorResult));
    assert.equal(errorResult.statusCode, 404);
  });
});
