/**
 * Tests for core/edit.ts
 * SPEC.md §4.4: edit-script validation and application
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { validateEdit, applyEdit } from "../../src/core/edit.js";
import type { Tokens } from "../../src/core/tokens.js";
import type { DiffScript } from "../../src/core/diff.js";
import { SnapError } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tok(text: string): Tokens {
  if (text === "") return [];
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      tokens.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) tokens.push(text.slice(start));
  return tokens;
}

function expectSnapError(fn: () => void, substring: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SnapError, `expected SnapError, got: ${String(caught)}`);
  assert.ok(
    caught.message.includes(substring),
    `expected message to include '${substring}', got: '${caught.message}'`,
  );
}

// ---------------------------------------------------------------------------
// Valid application
// ---------------------------------------------------------------------------

void describe("applyEdit — valid cases", () => {
  void test("empty script on empty base", () => {
    const result = applyEdit([], []);
    assert.deepEqual(result, []);
  });

  void test("all-insert script on empty base", () => {
    const script: DiffScript = [{ type: "insert", tokens: ["hello\n"] }];
    assert.deepEqual(applyEdit([], script), ["hello\n"]);
  });

  void test("retain all tokens", () => {
    const base = tok("a\nb\nc\n");
    const script: DiffScript = [{ type: "retain", count: 3 }];
    assert.deepEqual(applyEdit(base, script), [...base]);
  });

  void test("delete all tokens", () => {
    const base = tok("a\nb\nc\n");
    const script: DiffScript = [{ type: "delete", count: 3 }];
    assert.deepEqual(applyEdit(base, script), []);
  });

  void test("retain then insert", () => {
    const base = tok("a\nb\n");
    const script: DiffScript = [
      { type: "retain", count: 2 },
      { type: "insert", tokens: ["c\n"] },
    ];
    assert.deepEqual(applyEdit(base, script), ["a\n", "b\n", "c\n"]);
  });

  void test("delete then insert", () => {
    const base = tok("a\nb\n");
    const script: DiffScript = [
      { type: "delete", count: 2 },
      { type: "insert", tokens: ["x\n", "y\n"] },
    ];
    assert.deepEqual(applyEdit(base, script), ["x\n", "y\n"]);
  });

  void test("test-05 script: delete(1), retain(2), insert(['a'])", () => {
    const base = tok("a\nb\na\n");
    const script: DiffScript = [
      { type: "delete", count: 1 },
      { type: "retain", count: 2 },
      { type: "insert", tokens: ["a"] },
    ];
    assert.deepEqual(applyEdit(base, script), ["b\n", "a\n", "a"]);
  });

  void test("complex mixed script", () => {
    const base = tok("0\n1\n2\n3\n4\n");
    // retain(1), delete(2), retain(2) = "0\n3\n4\n"
    const script: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 2 },
      { type: "retain", count: 2 },
    ];
    assert.deepEqual(applyEdit(base, script), ["0\n", "3\n", "4\n"]);
  });

  void test("insert before retain", () => {
    const base = tok("a\n");
    const script: DiffScript = [
      { type: "insert", tokens: ["X\n"] },
      { type: "retain", count: 1 },
    ];
    assert.deepEqual(applyEdit(base, script), ["X\n", "a\n"]);
  });
});

// ---------------------------------------------------------------------------
// Over-consumption error
// ---------------------------------------------------------------------------

void describe("validateEdit — over-consumption", () => {
  void test("retain beyond end throws 'consumes beyond old content'", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "retain", count: 2 }];
    expectSnapError(() => validateEdit(base, script), "consumes beyond old content");
  });

  void test("delete beyond end throws 'consumes beyond old content'", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "delete", count: 2 }];
    expectSnapError(() => validateEdit(base, script), "consumes beyond old content");
  });

  void test("retain + retain (if valid count each) consumes beyond throws", () => {
    // Two retain(1) would be adjacent (forbidden), so test retain(1) + insert + retain(1)
    // on a base with 1 token: over-consumption at the second retain
    // Actually adjacent retain would fail adjacency first. Use retain+delete.
    const base = tok("a\n");
    const script: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 1 },
    ];
    expectSnapError(() => validateEdit(base, script), "consumes beyond old content");
  });
});

// ---------------------------------------------------------------------------
// Under-consumption error
// ---------------------------------------------------------------------------

void describe("validateEdit — under-consumption", () => {
  void test("empty script on non-empty base throws 'does not consume old content'", () => {
    const base = tok("a\n");
    expectSnapError(() => validateEdit(base, []), "does not consume old content");
  });

  void test("partial script throws 'does not consume old content'", () => {
    const base = tok("a\nb\nc\n");
    const script: DiffScript = [{ type: "retain", count: 2 }];
    expectSnapError(() => validateEdit(base, script), "does not consume old content");
  });

  void test("insert-only script on non-empty base throws 'does not consume old content'", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "insert", tokens: ["b\n"] }];
    expectSnapError(() => validateEdit(base, script), "does not consume old content");
  });
});

// ---------------------------------------------------------------------------
// Adjacent same-kind operations error
// ---------------------------------------------------------------------------

void describe("validateEdit — adjacent same-kind operations", () => {
  void test("adjacent inserts throw 'adjacent insert'", () => {
    const base: Tokens = [];
    const script: DiffScript = [
      { type: "insert", tokens: ["a\n"] },
      { type: "insert", tokens: ["b\n"] },
    ];
    expectSnapError(() => validateEdit(base, script), "adjacent insert");
  });

  void test("adjacent retains throw", () => {
    const base = tok("a\nb\n");
    const script: DiffScript = [
      { type: "retain", count: 1 },
      { type: "retain", count: 1 },
    ];
    // Adjacent retain-retain is forbidden per SPEC §4.4
    let caught: unknown;
    try {
      validateEdit(base, script);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SnapError, "expected SnapError for adjacent retains");
  });

  void test("adjacent deletes throw", () => {
    const base = tok("a\nb\n");
    const script: DiffScript = [
      { type: "delete", count: 1 },
      { type: "delete", count: 1 },
    ];
    let caught: unknown;
    try {
      validateEdit(base, script);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SnapError, "expected SnapError for adjacent deletes");
  });
});

// ---------------------------------------------------------------------------
// Zero/negative count error
// ---------------------------------------------------------------------------

void describe("validateEdit — invalid counts", () => {
  void test("retain count of 0 throws 'positive safe integer'", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "retain", count: 0 }];
    expectSnapError(() => validateEdit(base, script), "positive safe integer");
  });

  void test("delete count of 0 throws 'positive safe integer'", () => {
    const base: Tokens = [];
    const script: DiffScript = [{ type: "delete", count: 0 }];
    expectSnapError(() => validateEdit(base, script), "positive safe integer");
  });

  void test("retain count of -1 throws 'positive safe integer'", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "retain", count: -1 }];
    expectSnapError(() => validateEdit(base, script), "positive safe integer");
  });

  void test("delete count larger than MAX_SAFE_INTEGER throws 'positive safe integer'", () => {
    const base: Tokens = [];
    const script: DiffScript = [{ type: "delete", count: Number.MAX_SAFE_INTEGER + 1 }];
    expectSnapError(() => validateEdit(base, script), "positive safe integer");
  });
});

// ---------------------------------------------------------------------------
// Empty insert token error
// ---------------------------------------------------------------------------

void describe("validateEdit — empty insert tokens", () => {
  void test("empty insert array throws 'insert is empty'", () => {
    const base: Tokens = [];
    const script: DiffScript = [{ type: "insert", tokens: [] }];
    expectSnapError(() => validateEdit(base, script), "insert is empty");
  });

  void test("insert with empty string token throws 'insert is empty'", () => {
    const base: Tokens = [];
    const script: DiffScript = [{ type: "insert", tokens: [""] }];
    expectSnapError(() => validateEdit(base, script), "insert is empty");
  });
});

// ---------------------------------------------------------------------------
// applyEdit propagates errors
// ---------------------------------------------------------------------------

void describe("applyEdit — propagates validateEdit errors", () => {
  void test("applyEdit throws on over-consumption", () => {
    const base = tok("a\n");
    const script: DiffScript = [{ type: "retain", count: 5 }];
    expectSnapError(() => applyEdit(base, script), "consumes beyond old content");
  });

  void test("applyEdit throws on under-consumption", () => {
    const base = tok("a\nb\n");
    const script: DiffScript = [{ type: "retain", count: 1 }];
    expectSnapError(() => applyEdit(base, script), "does not consume old content");
  });
});
