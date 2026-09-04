// Tests for repo/json.ts — duplicate-key detection, valid JSON parsing, canonical serialization
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJSON, serializeRepository } from "../../src/repo/json.js";
import type { Repository } from "../../src/repo/model.js";
import { SnapError } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// parseJSON — valid cases
// ---------------------------------------------------------------------------

void describe("parseJSON — valid cases", () => {
  void it("parses a simple object", () => {
    const result = parseJSON('{"a":1}');
    assert.deepEqual(result, { a: 1 });
  });

  void it("parses an array", () => {
    const result = parseJSON("[1, 2, 3]");
    assert.deepEqual(result, [1, 2, 3]);
  });

  void it("parses null", () => {
    const result = parseJSON("null");
    assert.strictEqual(result, null);
  });

  void it("parses true and false", () => {
    assert.strictEqual(parseJSON("true"), true);
    assert.strictEqual(parseJSON("false"), false);
  });

  void it("parses nested objects", () => {
    const result = parseJSON('{"a":{"b":{"c":42}}}');
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
    const result = parseJSON(text);
    assert.ok(typeof result === "object" && result !== null);
  });

  void it("handles Unicode escape sequences", () => {
    const result = parseJSON('"\\u0041"'); // "A"
    assert.strictEqual(result, "A");
  });

  void it("handles escape sequences in strings", () => {
    const result = parseJSON('"line1\\nline2"');
    assert.strictEqual(result, "line1\nline2");
  });

  void it("allows duplicate-valued entries in arrays (arrays have no keys)", () => {
    // Arrays can have repeated values — no error
    const result = parseJSON("[[1],[1]]");
    assert.deepEqual(result, [[1], [1]]);
  });

  void it("handles numbers including floats", () => {
    const result = parseJSON("1.5");
    assert.strictEqual(result, 1.5);
  });

  void it("handles whitespace-heavy JSON", () => {
    const result = parseJSON('  {  "a"  :  1  }  ');
    assert.deepEqual(result, { a: 1 });
  });
});

// ---------------------------------------------------------------------------
// parseJSON — duplicate key detection
// ---------------------------------------------------------------------------

void describe("parseJSON — duplicate key detection", () => {
  void it("throws on top-level duplicate key", () => {
    assert.throws(
      () => parseJSON('{"format":1,"format":1}'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        assert.ok(e.message.includes("format"));
        return true;
      },
    );
  });

  void it("throws on duplicate key in nested object", () => {
    assert.throws(
      () => parseJSON('{"a":{"x":1,"x":2}}'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        assert.ok(e.message.includes("x"));
        return true;
      },
    );
  });

  void it("throws on duplicate key inside object in array", () => {
    assert.throws(
      () => parseJSON('[{"a":1,"a":2}]'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        return true;
      },
    );
  });

  void it("allows same key in different objects at same depth", () => {
    // {"a":{"x":1},"b":{"x":2}} — "x" appears in two different objects, not a duplicate
    const result = parseJSON('{"a":{"x":1},"b":{"x":2}}');
    assert.deepEqual(result, { a: { x: 1 }, b: { x: 2 } });
  });

  void it("allows same key in sibling objects in array", () => {
    const result = parseJSON('[{"a":1},{"a":2}]');
    assert.deepEqual(result, [{ a: 1 }, { a: 2 }]);
  });

  void it("throws on test 15 exact input: format key duplicated", () => {
    // From test 15-repository-validation.yaml step 2
    assert.throws(
      () => parseJSON('{"format":1,"format":1,"frontier":[],"patches":[]}'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        return true;
      },
    );
  });

  void it("throws on duplicate key with escaped quotes in key", () => {
    assert.throws(
      () => parseJSON('{"key\\"x":1,"key\\"x":2}'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        return true;
      },
    );
  });

  void it("detects duplicate at deeply nested level", () => {
    assert.throws(
      () => parseJSON('{"a":{"b":{"c":{"d":1,"d":2}}}}'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        assert.ok(e.message.includes("d"));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// parseJSON — invalid JSON
// ---------------------------------------------------------------------------

void describe("parseJSON — invalid JSON errors", () => {
  void it("throws on empty string", () => {
    assert.throws(
      () => parseJSON(""),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("invalid JSON"));
        return true;
      },
    );
  });

  void it("throws on malformed JSON", () => {
    assert.throws(
      () => parseJSON("{bad json}"),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        return true;
      },
    );
  });

  void it("throws on trailing garbage", () => {
    assert.throws(
      () => parseJSON('{"a":1}extra'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        return true;
      },
    );
  });

  void it("throws on unterminated string", () => {
    assert.throws(
      () => parseJSON('{"a": "unterminated'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        return true;
      },
    );
  });

  void it("throws on unterminated object", () => {
    assert.throws(
      () => parseJSON('{"a":1'),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        return true;
      },
    );
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
