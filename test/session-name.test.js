import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionName, InvalidSessionNameError } from "../lib/session-name.js";

describe("SessionName", () => {
  describe("constructor", () => {
    it("accepts valid session names", () => {
      const name = new SessionName("my-session_1");
      assert.strictEqual(name.value, "my-session_1");
    });

    it("sanitizes invalid characters", () => {
      const name = new SessionName("hello world!@#$");
      assert.strictEqual(name.value, "helloworld");
    });

    it("truncates to 64 characters", () => {
      const long = "a".repeat(100);
      const name = new SessionName(long);
      assert.strictEqual(name.value.length, 64);
      assert.strictEqual(name.value, "a".repeat(64));
    });

    it("throws InvalidSessionNameError for null", () => {
      assert.throws(
        () => new SessionName(null),
        (err) => {
          assert(err instanceof InvalidSessionNameError);
          assert.strictEqual(err.raw, null);
          return true;
        }
      );
    });

    it("throws InvalidSessionNameError for undefined", () => {
      assert.throws(
        () => new SessionName(undefined),
        InvalidSessionNameError
      );
    });

    it("throws InvalidSessionNameError for empty string", () => {
      assert.throws(
        () => new SessionName(""),
        InvalidSessionNameError
      );
    });

    it("throws InvalidSessionNameError for numbers", () => {
      assert.throws(
        () => new SessionName(42),
        InvalidSessionNameError
      );
    });

    it("throws InvalidSessionNameError when all characters are invalid", () => {
      assert.throws(
        () => new SessionName("!@#$%^&*()"),
        InvalidSessionNameError
      );
    });

    it("preserves alphanumeric, hyphens, and underscores", () => {
      const name = new SessionName("abc123-DEF_456");
      assert.strictEqual(name.value, "abc123-DEF_456");
    });
  });

  describe("tryCreate", () => {
    it("returns SessionName for valid input", () => {
      const name = SessionName.tryCreate("valid-name");
      assert(name instanceof SessionName);
      assert.strictEqual(name.value, "valid-name");
    });

    it("returns null for invalid input", () => {
      assert.strictEqual(SessionName.tryCreate(null), null);
      assert.strictEqual(SessionName.tryCreate(undefined), null);
      assert.strictEqual(SessionName.tryCreate(""), null);
      assert.strictEqual(SessionName.tryCreate("!@#$"), null);
    });

    it("returns null for non-string types", () => {
      assert.strictEqual(SessionName.tryCreate(42), null);
      assert.strictEqual(SessionName.tryCreate({}), null);
      assert.strictEqual(SessionName.tryCreate([]), null);
    });
  });

  describe("toString", () => {
    it("returns the sanitized value", () => {
      const name = new SessionName("test");
      assert.strictEqual(name.toString(), "test");
    });

    it("returns sanitized value with special characters removed", () => {
      const name = new SessionName("hello world!");
      assert.strictEqual(name.toString(), "helloworld");
    });
  });

  describe("equals", () => {
    it("returns true for equal SessionName instances", () => {
      const name1 = new SessionName("test");
      const name2 = new SessionName("test");
      assert.strictEqual(name1.equals(name2), true);
    });

    it("returns false for different SessionName instances", () => {
      const name1 = new SessionName("test1");
      const name2 = new SessionName("test2");
      assert.strictEqual(name1.equals(name2), false);
    });

    it("returns true when comparing with equal string", () => {
      const name = new SessionName("test");
      assert.strictEqual(name.equals("test"), true);
    });

    it("returns false when comparing with different string", () => {
      const name = new SessionName("test");
      assert.strictEqual(name.equals("other"), false);
    });

    it("returns false for non-string, non-SessionName types", () => {
      const name = new SessionName("test");
      assert.strictEqual(name.equals(null), false);
      assert.strictEqual(name.equals(undefined), false);
      assert.strictEqual(name.equals(42), false);
    });
  });

  describe("toJSON", () => {
    it("returns the string value", () => {
      const name = new SessionName("test");
      assert.strictEqual(name.toJSON(), "test");
    });

    it("works with JSON.stringify", () => {
      const name = new SessionName("test");
      const json = JSON.stringify({ name });
      assert.strictEqual(json, '{"name":"test"}');
    });
  });

  describe("edge cases", () => {
    it("handles names with only hyphens", () => {
      const name = new SessionName("---");
      assert.strictEqual(name.value, "---");
    });

    it("handles names with only underscores", () => {
      const name = new SessionName("___");
      assert.strictEqual(name.value, "___");
    });

    it("handles mixed case", () => {
      const name = new SessionName("MySession123");
      assert.strictEqual(name.value, "MySession123");
    });

    it("strips leading and trailing invalid characters", () => {
      const name = new SessionName("!!!test!!!");
      assert.strictEqual(name.value, "test");
    });

    it("handles Unicode characters by removing them", () => {
      const name = new SessionName("test-🚀-session");
      assert.strictEqual(name.value, "test--session"); // Hyphens remain, emoji removed
    });

    it("handles whitespace by removing it", () => {
      const name = new SessionName("  test  session  ");
      assert.strictEqual(name.value, "testsession");
    });
  });

  describe("default session name", () => {
    it("accepts 'default' as a valid name", () => {
      const name = new SessionName("default");
      assert.strictEqual(name.value, "default");
    });
  });

  describe("real-world examples", () => {
    it("handles typical session names", () => {
      const examples = [
        ["main", "main"],
        ["dev-server", "dev-server"],
        ["build_prod", "build_prod"],
        ["test-1", "test-1"],
        ["backend_api_v2", "backend_api_v2"],
      ];

      for (const [input, expected] of examples) {
        const name = new SessionName(input);
        assert.strictEqual(name.value, expected);
      }
    });

    it("sanitizes user input from UI", () => {
      const examples = [
        ["My Project (prod)", "MyProjectprod"],
        ["test #1", "test1"],
        ["server @ port 3000", "serverport3000"],
        ["logs/debug", "logsdebug"],
      ];

      for (const [input, expected] of examples) {
        const name = new SessionName(input);
        assert.strictEqual(name.value, expected);
      }
    });
  });
});

describe("InvalidSessionNameError", () => {
  it("includes the raw value in error message", () => {
    const err = new InvalidSessionNameError("!@#");
    assert.ok(err.message.includes("!@#"));
  });

  it("stores the raw value", () => {
    const err = new InvalidSessionNameError("test");
    assert.strictEqual(err.raw, "test");
  });

  it("has correct error name", () => {
    const err = new InvalidSessionNameError("test");
    assert.strictEqual(err.name, "InvalidSessionNameError");
  });
});
