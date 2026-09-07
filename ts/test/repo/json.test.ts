// Tests for repo/json.ts — duplicate-key detection, valid JSON parsing, canonical serialization
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJSON, serializeRepository } from "../../src/repo/json.js";
import type { Repository } from "../../src/repo/model.js";
import { SnapError } from "../../src/errors.js";
import { assertOk, assertErr } from "../helpers/result.js";

// ---------------------------------------------------------------------------
// parseJSON — valid cases
// ---------------------------------------------------------------------------

void describe("parseJSON — valid cases", () => {
  void it("parses a simple object", () => {
    const result = assertOk(parseJSON('{"a":1}'));
    assert.deepEqual(result, { a: 1 });
  });

  void it("parses an array", () => {
    const result = assertOk(parseJSON("[1, 2, 3]"));
    assert.deepEqual(result, [1, 2, 3]);
  });

  void it("parses null", () => {
    const result = assertOk(parseJSON("null"));
    assert.strictEqual(result, null);
  });

  void it("parses true and false", () => {
    assert.strictEqual(assertOk(parseJSON("true")), true);
    assert.strictEqual(assertOk(parseJSON("false")), false);
  });

  void it("parses nested objects", () => {
    const result = assertOk(parseJSON('{"a":{"b":{"c":42}}}'));
    assert.deepEqual(result, { a: { b: { c: 42 } } });
  });

  void it("parses a well-formed repository JSON (no duplicate keys)", () => {
    const text = JSON.stringify({
      format: 1,
      frontier: [["alice@example.com", 1]],
      patches: [
        {
          author: "alice@example.com",
          revision: 1,
          base: [],
          message: "init",
          changes: [{ type: "text", path: "f.txt", edit: [{ insert: ["hello\n"] }] }],
        },
      ],
    });
    const result = assertOk(parseJSON(text));
    assert.ok(typeof result === "object" && result !== null);
  });

  void it("handles Unicode escape sequences", () => {
    const result = assertOk(parseJSON('"\\u0041"')); // "A"
    assert.strictEqual(result, "A");
  });

  void it("handles escape sequences in strings", () => {
    const result = assertOk(parseJSON('"line1\\nline2"'));
    assert.strictEqual(result, "line1\nline2");
  });

  void it("allows duplicate-valued entries in arrays (arrays have no keys)", () => {
    // Arrays can have repeated values — no error
    const result = assertOk(parseJSON("[[1],[1]]"));
    assert.deepEqual(result, [[1], [1]]);
  });

  void it("handles numbers including floats", () => {
    const result = assertOk(parseJSON("1.5"));
    assert.strictEqual(result, 1.5);
  });

  void it("handles whitespace-heavy JSON", () => {
    const result = assertOk(parseJSON('  {  "a"  :  1  }  '));
    assert.deepEqual(result, { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// parseJSON — duplicate key detection
// ---------------------------------------------------------------------------

void describe("parseJSON — duplicate key detection", () => {
  void it("throws on top-level duplicate key", () => {
    const e = assertErr(parseJSON('{"format":1,"format":1}'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
    assert.ok(e.message.includes("format"));
  });

  void it("throws on duplicate key in nested object", () => {
    const e = assertErr(parseJSON('{"a":{"x":1,"x":2}}'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
    assert.ok(e.message.includes("x"));
  });

  void it("throws on duplicate key inside object in array", () => {
    const e = assertErr(parseJSON('[{"a":1,"a":2}]'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
  });

  void it("allows same key in different objects at same depth", () => {
    // {"a":{"x":1},"b":{"x":2}} — "x" appears in two different objects, not a duplicate
    const result = assertOk(parseJSON('{"a":{"x":1},"b":{"x":2}}'));
    assert.deepEqual(result, { a: { x: 1 }, b: { x: 2 } });
  });

  void it("allows same key in sibling objects in array", () => {
    const result = assertOk(parseJSON('[{"a":1},{"a":2}]'));
    assert.deepEqual(result, [{ a: 1 }, { a: 2 }]);
  });

  void it("throws on test 15 exact input: format key duplicated", () => {
    // From test 15-repository-validation.yaml step 2
    const e = assertErr(parseJSON('{"format":1,"format":1,"frontier":[],"patches":[]}'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
  });

  void it("throws on duplicate key with escaped quotes in key", () => {
    const e = assertErr(parseJSON('{"key\\"x":1,"key\\"x":2}'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
  });

  void it("detects duplicate at deeply nested level", () => {
    const e = assertErr(parseJSON('{"a":{"b":{"c":{"d":1,"d":2}}}}'));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("duplicate JSON key"));
    assert.ok(e.message.includes("d"));
  });
});

// ---------------------------------------------------------------------------
// parseJSON — invalid JSON
// ---------------------------------------------------------------------------

void describe("parseJSON — invalid JSON errors", () => {
  void it("throws on empty string", () => {
    const e = assertErr(parseJSON(""));
    assert.ok(e instanceof SnapError);
    assert.ok(e.message.includes("invalid JSON"));
  });

  void it("throws on malformed JSON", () => {
    const e = assertErr(parseJSON("{bad json}"));
    assert.ok(e instanceof SnapError);
  });

  void it("throws on trailing garbage", () => {
    const e = assertErr(parseJSON('{"a":1}extra'));
    assert.ok(e instanceof SnapError);
  });

  void it("throws on unterminated string", () => {
    const e = assertErr(parseJSON('{"a": "unterminated'));
    assert.ok(e instanceof SnapError);
  });

  void it("throws on unterminated object", () => {
    const e = assertErr(parseJSON('{"a":1'));
    assert.ok(e instanceof SnapError);
  });
});

// ---------------------------------------------------------------------------
// serializeRepository — canonical output
// ---------------------------------------------------------------------------

void describe("serializeRepository — canonical output", () => {
  void it("serializes an empty repository", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map(),
      patches: [],
    };
    const result = serializeRepository(repo);
    const expected = JSON.stringify({ format: 1, frontier: [], patches: [] }, null, 2) + "\n";
    assert.strictEqual(result, expected);
  });

  void it("puts format, frontier, patches in that key order", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([["alice@example.com", 1]]),
      patches: [],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, ["format", "frontier", "patches"]);
  });

  void it("puts patch fields in author,revision,base,message,changes order", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map(),
          message: "init",
          changes: [{ type: "text", path: "f.txt", edit: [] }],
        },
      ],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as { patches: Record<string, unknown>[] };
    const patchKeys = Object.keys(parsed.patches[0]!);
    assert.deepEqual(patchKeys, ["author", "revision", "base", "message", "changes"]);
  });

  void it("puts change fields in type,path,content order for put", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map(),
          message: "add",
          changes: [{ type: "put", path: "f.bin", content: "YQ==" }],
        },
      ],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as {
      patches: [{ changes: Record<string, unknown>[] }];
    };
    const changeKeys = Object.keys(parsed.patches[0]!.changes[0]!);
    assert.deepEqual(changeKeys, ["type", "path", "content"]);
  });

  void it("puts change fields in type,path,edit order for text", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map(),
          message: "init",
          changes: [{ type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["hi\n"] }] }],
        },
      ],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as {
      patches: [{ changes: Record<string, unknown>[] }];
    };
    const changeKeys = Object.keys(parsed.patches[0]!.changes[0]!);
    assert.deepEqual(changeKeys, ["type", "path", "edit"]);
  });

  void it("sorts frontier entries by UTF-8 byte order of ID", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([
        ["z@x", 1],
        ["a@x", 1],
        ["m@x", 1],
      ]),
      patches: [],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as { frontier: [string, number][] };
    const ids = parsed.frontier.map(([id]) => id);
    assert.deepEqual(ids, ["a@x", "m@x", "z@x"]);
  });

  void it("sorts base entries by UTF-8 byte order of ID", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([
        ["a@x", 1],
        ["b@x", 1],
      ]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map(),
          message: "a",
          changes: [{ type: "text", path: "a.txt", edit: [] }],
        },
        {
          author: "b@x",
          revision: 1,
          base: new Map([
            ["z@x", 2],
            ["a@x", 1],
          ]),
          message: "b",
          changes: [{ type: "text", path: "b.txt", edit: [] }],
        },
      ],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as {
      patches: [unknown, { base: [string, number][] }];
    };
    const baseIds = parsed.patches[1]!.base.map(([id]: [string, number]) => id);
    assert.deepEqual(baseIds, ["a@x", "z@x"]);
  });

  void it("serializes edit ops with single keys (retain, delete, insert)", () => {
    const repo: Repository = {
      format: 1,
      frontier: new Map([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map(),
          message: "edit",
          changes: [
            {
              type: "text",
              path: "f.txt",
              edit: [
                { type: "retain", count: 1 },
                { type: "delete", count: 2 },
                { type: "insert", tokens: ["new\n"] },
              ],
            },
          ],
        },
      ],
    };
    const result = serializeRepository(repo);
    const parsed = JSON.parse(result) as {
      patches: [{ changes: [{ edit: unknown[] }] }];
    };
    const edit = parsed.patches[0]!.changes[0]!.edit;
    assert.deepEqual(edit, [{ retain: 1 }, { delete: 2 }, { insert: ["new\n"] }]);
  });

  void it("outputs two-space indentation and trailing LF", () => {
    const repo: Repository = { format: 1, frontier: new Map(), patches: [] };
    const result = serializeRepository(repo);
    assert.ok(result.endsWith("\n"));
    // Check indentation: frontier line should be indented 2 spaces
    const lines = result.split("\n");
    const frontierLine = lines.find((l) => l.includes('"frontier"'));
    assert.ok(frontierLine !== undefined && frontierLine.startsWith("  "));
  });
});
