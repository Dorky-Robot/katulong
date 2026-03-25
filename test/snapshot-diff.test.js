import { describe, it } from "node:test";
import assert from "node:assert";
import { Session } from "../lib/session.js";

const diff = Session._diffLines;

describe("Session._diffLines", () => {
  it("returns null when lines are identical", () => {
    assert.strictEqual(diff(["a", "b", "c"], ["a", "b", "c"]), null);
  });

  it("returns all rows when prev is null (first frame)", () => {
    const result = diff(null, ["a", "b"]);
    assert.deepStrictEqual(result, [[0, "a"], [1, "b"]]);
  });

  it("returns only changed rows", () => {
    const result = diff(["a", "b", "c"], ["a", "X", "c"]);
    assert.deepStrictEqual(result, [[1, "X"]]);
  });

  it("handles multiple changed rows", () => {
    const result = diff(["a", "b", "c", "d"], ["X", "b", "Y", "d"]);
    assert.deepStrictEqual(result, [[0, "X"], [2, "Y"]]);
  });

  it("handles all rows changed", () => {
    const result = diff(["a", "b"], ["X", "Y"]);
    assert.deepStrictEqual(result, [[0, "X"], [1, "Y"]]);
  });

  it("handles line count increase", () => {
    const result = diff(["a", "b"], ["a", "b", "c"]);
    assert.deepStrictEqual(result, [[2, "c"]]);
  });

  it("handles line count decrease", () => {
    const result = diff(["a", "b", "c"], ["a", "b"]);
    assert.deepStrictEqual(result, [[2, ""]]);
  });

  it("handles ANSI color codes", () => {
    const result = diff(
      ["\x1b[32mgreen\x1b[0m", "plain"],
      ["\x1b[31mred\x1b[0m", "plain"]
    );
    assert.deepStrictEqual(result, [[0, "\x1b[31mred\x1b[0m"]]);
  });

  it("typing a character changes one row", () => {
    const result = diff(["$ ", ""], ["$ h", ""]);
    assert.deepStrictEqual(result, [[0, "$ h"]]);
  });
});
