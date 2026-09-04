/**
 * Tests for core/diff.ts
 * SPEC.md §5: reference DP oracle, Hirschberg equivalence, delete-on-tie
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { diffReference, diffHirschberg, diff } from "../../src/core/diff.js";
import type { Tokens } from "../../src/core/tokens.js";
import type { DiffScript } from "../../src/core/diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scriptSummary(s: DiffScript): string {
  return s
    .map((op) => {
      if (op.type === "retain") return `r${op.count}`;
      if (op.type === "delete") return `d${op.count}`;
      return `i[${op.tokens.join(",")}]`;
    })
    .join(",");
}

function applyScript(base: Tokens, script: DiffScript): string[] {
  const result: string[] = [];
  let pos = 0;
  for (const op of script) {
    if (op.type === "retain") {
      for (let i = 0; i < op.count; i++) result.push(base[pos++]!);
    } else if (op.type === "delete") {
      pos += op.count;
    } else {
      result.push(...op.tokens);
    }
  }
  return result;
}

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

// ---------------------------------------------------------------------------
// Hirschberg ↔ Reference oracle
// ---------------------------------------------------------------------------

void describe("Hirschberg ↔ Reference oracle (differential equivalence)", () => {
  function oracle(A: Tokens, B: Tokens): void {
    const ref = diffReference(A, B);
    const hirsch = diffHirschberg(A, B);
    assert.deepEqual(
      hirsch,
      ref,
      `mismatch for A=${JSON.stringify(A)} B=${JSON.stringify(B)}\n` +
        `  ref:    ${scriptSummary(ref)}\n` +
        `  hirsch: ${scriptSummary(hirsch)}`,
    );
    // Also verify correctness: applying the script to A gives B
    assert.deepEqual(applyScript(A, ref), [...B]);
  }

  void test("empty → empty", () => oracle([], []));
  void test("empty → single", () => oracle([], ["a\n"]));
  void test("single → empty", () => oracle(["a\n"], []));
  void test("single → single equal", () => oracle(["a\n"], ["a\n"]));
  void test("single → single different", () => oracle(["a\n"], ["b\n"]));
  void test("two equal", () => oracle(["a\n", "b\n"], ["a\n", "b\n"]));
  void test("two totally different", () => oracle(["a\n", "b\n"], ["c\n", "d\n"]));
  void test("insert at start", () => oracle(["b\n", "c\n"], ["a\n", "b\n", "c\n"]));
  void test("insert at end", () => oracle(["a\n", "b\n"], ["a\n", "b\n", "c\n"]));
  void test("delete from start", () => oracle(["a\n", "b\n", "c\n"], ["b\n", "c\n"]));
  void test("delete from end", () => oracle(["a\n", "b\n", "c\n"], ["a\n", "b\n"]));

  // Test-05 golden: "a\nb\na\n" → "b\na\na" (no final LF)
  void test("test-05 repeated lines with delete-on-tie", () => {
    const A = tok("a\nb\na\n"); // ["a\n", "b\n", "a\n"]
    const B = tok("b\na\na"); // ["b\n", "a\n", "a"]
    oracle(A, B);
    const script = diffReference(A, B);
    // Expected: delete 1, retain 2, insert ["a"]
    // A[0]="a\n" vs B[0]="b\n": D(1,0)=delete cost, D(0,1)=insert cost
    // D(1,0): A[1..]="b\n","a\n" vs B[0..]="b\n","a\n","a" → D=1 (insert "a")
    // D(0,1): A[0..]="a\n","b\n","a\n" vs B[1..]="a\n","a" → more complex
    assert.equal(scriptSummary(script), "d1,r2,i[a]");
  });

  // Repeated equal lines
  void test("all same tokens", () => oracle(["x\n", "x\n", "x\n"], ["x\n", "x\n", "x\n"]));
  void test("repeated lines with change", () =>
    oracle(["a\n", "a\n", "b\n"], ["a\n", "b\n", "a\n"]));
  void test("all deleted", () => oracle(["a\n", "b\n", "c\n"], []));
  void test("all inserted", () => oracle([], ["a\n", "b\n", "c\n"]));

  // Test-22 OT matrix base: ["0\n","1\n","2\n","3\n","4\n"]
  void test("test-22 dd case: base → alice edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n3\n4\n");
    oracle(A, B);
    // Expected: retain(1), delete(2), retain(2)
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r1,d2,r2");
  });

  void test("test-22 dd case: base → bob edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n2\n3\n4\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r1,d1,r3");
  });

  void test("test-22 split case: base → alice edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("A\n0\n3\n4\nTAIL\n");
    oracle(A, B);
    // Expected: insert["A\n"], retain(1), delete(2), retain(2), insert["TAIL\n"]
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "i[A\n],r1,d2,r2,i[TAIL\n]");
  });

  void test("test-22 split case: base → bob edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n1\nB\n3\n4\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r2,d1,i[B\n],r2");
  });

  void test("test-22 rd case: base → alice edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n1\n2\n3\n4\nA\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r5,i[A\n]");
  });

  void test("test-22 rd case: base → bob edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n2\n3\n4\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r1,d1,r3");
  });

  void test("test-22 survive case: base → alice edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\n2\n3\n4\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r1,d1,r3");
  });

  void test("test-22 survive case: base → bob edit", () => {
    const A = tok("0\n1\n2\n3\n4\n");
    const B = tok("0\nB\n1\n2\n3\n4\n");
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "r1,i[B\n],r4");
  });

  // Large inputs — Hirschberg is used by diff()
  void test("large all-same sequence", () => {
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 100; i++) A.push(`line${i}\n`);
    for (let i = 0; i < 100; i++) B.push(`line${i}\n`);
    oracle(A, B);
  });

  void test("large insert-only", () => {
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 60; i++) B.push(`line${i}\n`);
    oracle(A, B);
  });

  void test("large delete-only", () => {
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 60; i++) A.push(`line${i}\n`);
    oracle(A, B);
  });

  void test("large mixed edits", () => {
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 80; i++) A.push(`line${i}\n`);
    for (let i = 0; i < 80; i++) {
      if (i % 3 === 0) B.push(`modified${i}\n`);
      else B.push(`line${i}\n`);
    }
    oracle(A, B);
  });

  void test("repeated lines — many duplicates", () => {
    const A = ["a\n", "b\n", "a\n", "b\n", "a\n"];
    const B = ["b\n", "a\n", "b\n", "a\n", "b\n"];
    oracle(A, B);
  });

  void test("permutation of distinct lines", () => {
    const A = ["x\n", "y\n", "z\n"];
    const B = ["z\n", "x\n", "y\n"];
    oracle(A, B);
  });

  void test("no-final-LF token", () => {
    const A = ["a\n", "b"];
    const B = ["a\n", "c"];
    oracle(A, B);
  });

  void test("single token no-LF inserted", () => {
    const A: Tokens = [];
    const B = ["hello"];
    oracle(A, B);
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "i[hello]");
  });
});

// ---------------------------------------------------------------------------
// Delete-on-tie
// ---------------------------------------------------------------------------

void describe("delete-on-tie rule (SPEC.md §5)", () => {
  void test("delete is chosen when D(i+1,j) == D(i,j+1)", () => {
    // From test-05: A=["a\n","b\n","a\n"], B=["b\n","a\n","a"]
    // At (0,0): A[0]="a\n" != B[0]="b\n"
    // D(1,0) = cost of turning ["b\n","a\n"] into ["b\n","a\n","a"] = 1 (insert "a")
    // D(0,1) = cost of turning ["a\n","b\n","a\n"] into ["a\n","a"] = ... (need to check)
    // The result has delete first: d1,r2,i[a]
    const A = ["a\n", "b\n", "a\n"] as Tokens;
    const B = ["b\n", "a\n", "a"] as Tokens;
    const s = diffReference(A, B);
    assert.equal(s[0]!.type, "delete", "first op should be delete due to tie");
    assert.equal(scriptSummary(s), "d1,r2,i[a]");
  });

  void test("insert is chosen when D(i,j+1) < D(i+1,j)", () => {
    // A=[] B=["x\n"] — at (0,0) i=n=0, exhausted, so insert
    const A: Tokens = [];
    const B: Tokens = ["x\n"];
    const s = diffReference(A, B);
    assert.equal(s[0]!.type, "insert");
  });
});

// ---------------------------------------------------------------------------
// diff() function (dispatch)
// ---------------------------------------------------------------------------

void describe("diff() dispatch function", () => {
  void test("diff() produces same result as diffReference for small inputs", () => {
    const A = tok("a\nb\na\n");
    const B = tok("b\na\na");
    assert.deepEqual(diff(A, B), diffReference(A, B));
  });

  void test("diff() produces correct result for large inputs", () => {
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 100; i++) A.push(`line${i}\n`);
    for (let i = 10; i < 110; i++) B.push(`line${i}\n`);
    const result = diff(A, B);
    // The result should transform A into B correctly
    assert.deepEqual(applyScript(A, result), [...B]);
  });

  void test("diff(A, A) produces all-retain script", () => {
    const A = tok("a\nb\nc\n");
    const s = diff(A, A);
    assert.equal(s.length, 1);
    assert.equal(s[0]!.type, "retain");
    assert.equal((s[0] as { type: "retain"; count: number }).count, 3);
  });

  void test("diff([], []) produces empty script", () => {
    assert.deepEqual(diff([], []), []);
  });
});

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

void describe("coalescing adjacent operations", () => {
  void test("adjacent retains are coalesced", () => {
    const A = tok("a\nb\nc\n");
    const B = tok("a\nb\nc\n");
    const s = diffReference(A, B);
    // Should be a single retain(3), not three retain(1)s
    assert.equal(s.length, 1);
    assert.equal((s[0] as { type: "retain"; count: number }).count, 3);
  });

  void test("adjacent deletes are coalesced", () => {
    const A = tok("a\nb\nc\n");
    const B: Tokens = [];
    const s = diffReference(A, B);
    assert.equal(s.length, 1);
    assert.equal(s[0]!.type, "delete");
    assert.equal((s[0] as { type: "delete"; count: number }).count, 3);
  });

  void test("adjacent inserts are coalesced", () => {
    const A: Tokens = [];
    const B = tok("a\nb\nc\n");
    const s = diffReference(A, B);
    assert.equal(s.length, 1);
    assert.equal(s[0]!.type, "insert");
    assert.equal((s[0] as { type: "insert"; tokens: readonly string[] }).tokens.length, 3);
  });
});
