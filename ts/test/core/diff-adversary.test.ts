/**
 * Diff Adversary — Phase 2 adversarial audit of tokens.ts, diff.ts, edit.ts, ot.ts
 *
 * Rules:
 *  - Every test is new (not duplicated from existing suites).
 *  - Every test cites the SPEC.md line range it exercises.
 *  - Tests that exercise objections are marked with their ADV-B-NNN id.
 *
 * SPEC refs used throughout:
 *  - §4.4 (254-270): text tokens, edit script rules, canonical token sequence
 *  - §5   (290-317): diff algorithm, delete-on-tie
 *  - §6.3 (376-393): OT transform table
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isText, tokenize, isCanonical } from "../../src/core/tokens.js";
import { diffReference, diffHirschberg } from "../../src/core/diff.js";
import { validateEdit, applyEdit } from "../../src/core/edit.js";
import { transform } from "../../src/core/ot.js";
import { assertOk, assertErr } from "../helpers/result.js";
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

// ---------------------------------------------------------------------------
// tokens.ts — isText
// SPEC.md §4.4:254: "A file is text when its bytes are valid UTF-8 and contain no NUL."
// ---------------------------------------------------------------------------

void describe("ADV tokens.ts — isText", () => {
  // ADV-B-001: empty buffer — valid UTF-8 with no NUL → MUST be true
  void test("ADV-B-001: isText(empty buffer) returns true", () => {
    // SPEC.md §4.4:254-257: empty file is valid UTF-8 with no NUL bytes.
    // The spec §4.4:257 says "The empty file has no tokens." — it is still a text file.
    assert.equal(isText(Buffer.alloc(0)), true);
  });

  // ADV-B-002: invalid UTF-8 start bytes — must be false
  void test("ADV-B-002: isText(0xFF 0xFE — invalid UTF-8) returns false", () => {
    // SPEC.md §4.4:254: "valid UTF-8" is required. 0xFF is not valid in UTF-8.
    assert.equal(isText(Buffer.from([0xff, 0xfe])), false);
  });

  // ADV-B-003: lone continuation byte — invalid UTF-8, must be false
  void test("ADV-B-003: isText(lone continuation byte 0x80) returns false", () => {
    // SPEC.md §4.4:254: 0x80 as a first byte is not valid UTF-8.
    assert.equal(isText(Buffer.from([0x80])), false);
  });

  // ADV-B-004: valid multi-byte UTF-8 (e.g., U+00E9 "é") — must be true
  void test("ADV-B-004: isText(valid multi-byte UTF-8) returns true", () => {
    // SPEC.md §4.4:254: any valid UTF-8 with no NUL is text.
    const buf = Buffer.from("héllo\n", "utf8");
    assert.equal(isText(buf), true);
  });

  // ADV-B-005: buffer with NUL byte — must be false even if otherwise valid UTF-8
  void test("ADV-B-005: isText(buffer with NUL) returns false", () => {
    // SPEC.md §4.4:254: "contain no NUL"
    const buf = Buffer.from([0x68, 0x00, 0x69]); // "h\0i"
    assert.equal(isText(buf), false);
  });

  // ADV-B-006: overlong encoding — rejected by strict UTF-8
  void test("ADV-B-006: isText(overlong NUL encoding 0xC0 0x80) returns false", () => {
    // SPEC.md §4.4:254: "valid UTF-8" — overlong encodings are not valid UTF-8.
    // 0xC0 0x80 is an overlong encoding of U+0000 (modified UTF-8, not standard UTF-8).
    const buf = Buffer.from([0xc0, 0x80]);
    assert.equal(isText(buf), false);
  });

  // ADV-B-007: truncated multi-byte sequence — not valid UTF-8
  void test("ADV-B-007: isText(truncated 3-byte sequence) returns false", () => {
    // SPEC.md §4.4:254: "valid UTF-8" — truncated sequences are invalid.
    // E2 82 is the first two bytes of U+20AC (€) without the third.
    const buf = Buffer.from([0xe2, 0x82]);
    assert.equal(isText(buf), false);
  });
});

// ---------------------------------------------------------------------------
// tokens.ts — tokenize
// SPEC.md §4.4:255-257
// ---------------------------------------------------------------------------

void describe("ADV tokens.ts — tokenize", () => {
  // ADV-B-008: empty string → []
  void test("ADV-B-008: tokenize('') returns []", () => {
    // SPEC.md §4.4:257: "The empty file has no tokens."
    assert.deepEqual(tokenize(""), []);
  });

  // ADV-B-009: single LF → ["\n"]
  void test("ADV-B-009: tokenize('\\n') returns ['\\n']", () => {
    // SPEC.md §4.4:255: "Split it immediately after every LF byte, retaining LF in the token."
    assert.deepEqual(tokenize("\n"), ["\n"]);
  });

  // ADV-B-010: "a\r\nb" — only LF triggers split, \r stays with previous token
  void test("ADV-B-010: tokenize('a\\r\\nb') → ['a\\r\\n', 'b']", () => {
    // SPEC.md §4.4:255: split after LF; \r is not special and stays in the token.
    // The spec example explicitly: '"a\\r\\nb" becomes "a\\r\\n", "b"'
    assert.deepEqual(tokenize("a\r\nb"), ["a\r\n", "b"]);
  });

  // ADV-B-011: trailing LF → last token ends in LF (no empty trailing token)
  void test("ADV-B-011: tokenize('a\\nb\\n') → ['a\\n', 'b\\n'] (no trailing empty token)", () => {
    // SPEC.md §4.4:255: split AFTER each LF, retaining LF. No empty final token.
    assert.deepEqual(tokenize("a\nb\n"), ["a\n", "b\n"]);
  });

  // ADV-B-012: single character, no LF — one token with no LF
  void test("ADV-B-012: tokenize('x') → ['x']", () => {
    // SPEC.md §4.4:257: the final token may not end in LF.
    assert.deepEqual(tokenize("x"), ["x"]);
  });
});

// ---------------------------------------------------------------------------
// tokens.ts — isCanonical
// SPEC.md §4.4:267-269
// ---------------------------------------------------------------------------

void describe("ADV tokens.ts — isCanonical", () => {
  // ADV-B-013: empty array → true
  void test("ADV-B-013: isCanonical([]) returns true", () => {
    // SPEC.md §4.4:267: "every token except possibly the final one ends in LF"
    // Vacuously true for the empty sequence.
    assert.equal(isCanonical([]), true);
  });

  // ADV-B-014: single token without LF → true (it IS the final token)
  void test("ADV-B-014: isCanonical(['a']) returns true (final token, no LF required)", () => {
    // SPEC.md §4.4:267: the FINAL token may omit trailing LF.
    assert.equal(isCanonical(["a"]), true);
  });

  // ADV-B-015: ["a\n", "b"] → true (interior token ends in LF, final needn't)
  void test("ADV-B-015: isCanonical(['a\\n', 'b']) returns true", () => {
    // SPEC.md §4.4:267: every token except the last must end in LF.
    assert.equal(isCanonical(["a\n", "b"]), true);
  });

  // ADV-B-016: ["a", "b\n"] → FALSE — "a" is NOT the final token and doesn't end in LF
  void test("ADV-B-016: isCanonical(['a', 'b\\n']) returns FALSE", () => {
    // SPEC.md §4.4:267: every token except the last must end in LF.
    // "a" is at index 0, not the last, so it must end in LF — it does not → invalid.
    assert.equal(isCanonical(["a", "b\n"]), false);
  });

  // ADV-B-017: token with mid-LF → false (LF before final byte)
  void test("ADV-B-017: isCanonical(['a\\nb']) returns false (mid-token LF)", () => {
    // SPEC.md §4.4:268: "no token contains LF before its final byte"
    assert.equal(isCanonical(["a\nb"]), false);
  });

  // ADV-B-018: empty string token → false (insert tokens must be nonempty)
  void test("ADV-B-018: isCanonical(['']) returns false (empty token)", () => {
    // SPEC.md §4.4:261: insert tokens must be nonempty; an empty token in any sequence is invalid.
    assert.equal(isCanonical([""]), false);
  });

  // ADV-B-019: ["a\n\n"] — LF at position 1 is before final byte at position 2... wait
  // "a\n\n" has length 3: 'a', '\n', '\n'. The LF at index 1 is NOT the final byte (index 2).
  void test("ADV-B-019: isCanonical(['a\\n\\n']) returns false (LF before final byte)", () => {
    // SPEC.md §4.4:268: "no token contains LF before its final byte"
    // "a\n\n": indexOf('\n')=1, token.length-1=2 → 1 !== 2 → false
    assert.equal(isCanonical(["a\n\n"]), false);
  });
});

// ---------------------------------------------------------------------------
// diff.ts — delete-on-tie for ["a\n"] → ["b\n"]
// SPEC.md §5:310-312: "choose delete 1 when D(i+1,j) <= D(i,j+1)"
// ---------------------------------------------------------------------------

void describe("ADV diff.ts — delete-on-tie", () => {
  // ADV-B-020: diff(["a\n"], ["b\n"]) — single-token replacement
  // A[0]≠B[0]. D(1,0)=D(n=1,0)=m-j=1-0=1; D(0,1)=D(0,m=1)=n-i=1-0=1.
  // Tie: D(i+1,j)=1 <= D(i,j+1)=1 → delete first.
  void test("ADV-B-020: diff(['a\\n'],['b\\n']) — tie → delete first", () => {
    // SPEC.md §5:310-312: delete-on-tie rule requires delete when costs are equal.
    const A: Tokens = ["a\n"];
    const B: Tokens = ["b\n"];
    const s = diffReference(A, B);
    assert.equal(
      s[0]!.type,
      "delete",
      `First op must be delete (tie → delete). Got: ${scriptSummary(s)}`,
    );
    assert.equal(scriptSummary(s), "d1,i[b\n]", `Expected d1,i[b\\n], got: ${scriptSummary(s)}`);
  });

  // ADV-B-021: Hirschberg also produces delete-on-tie for single replacement
  void test("ADV-B-021: diffHirschberg(['a\\n'],['b\\n']) matches reference (delete-on-tie)", () => {
    // SPEC.md §5:316-318: Hirschberg MUST produce the same script as reference.
    const A: Tokens = ["a\n"];
    const B: Tokens = ["b\n"];
    const ref = diffReference(A, B);
    const hirsch = diffHirschberg(A, B);
    assert.deepEqual(
      hirsch,
      ref,
      `Hirschberg diverged from reference.\nRef:    ${scriptSummary(ref)}\nHirsch: ${scriptSummary(hirsch)}`,
    );
  });

  // ADV-B-022: PLAN.md §6.1 golden: ["a\n","b\n","a\n"] → ["b\n","a\n","a"]
  // Expected: [delete:1, retain:2, insert:["a"]]
  void test("ADV-B-022: PLAN.md §6.1 golden diff — [d1,r2,i[a]]", () => {
    // SPEC.md §5 & PLAN.md §6.1: confirmed output for this specific input.
    const A: Tokens = ["a\n", "b\n", "a\n"];
    const B: Tokens = ["b\n", "a\n", "a"];
    const s = diffReference(A, B);
    assert.equal(scriptSummary(s), "d1,r2,i[a]", `Got: ${scriptSummary(s)}`);
    // Also verify the script correctly transforms A to B
    assert.deepEqual(applyScript(A, s), [...B]);
  });
});

// ---------------------------------------------------------------------------
// diff.ts — Hirschberg ↔ Reference: adversarially crafted repeated-token inputs
// SPEC.md §5:316-318: "Implementations MAY use Hirschberg only if it produces the same script"
// ---------------------------------------------------------------------------

void describe("ADV diff.ts — Hirschberg ↔ Reference: repeated-token adversarial cases", () => {
  function oracle(label: string, A: Tokens, B: Tokens): void {
    const ref = diffReference(A, B);
    const hirsch = diffHirschberg(A, B);
    // Must produce identical script
    assert.deepEqual(
      hirsch,
      ref,
      `[${label}] Hirschberg diverged from reference.\n  A=${JSON.stringify(A)}\n  B=${JSON.stringify(B)}\n  ref:    ${scriptSummary(ref)}\n  hirsch: ${scriptSummary(hirsch)}`,
    );
    // Both must correctly transform A to B
    assert.deepEqual(
      applyScript(A, ref),
      [...B],
      `[${label}] reference script does not transform A to B`,
    );
    assert.deepEqual(
      applyScript(A, hirsch),
      [...B],
      `[${label}] Hirschberg script does not transform A to B`,
    );
  }

  // ADV-B-023: A=["x\n","x\n","y\n"], B=["y\n","x\n","x\n"]
  // Repeated tokens — hardest case for divide-and-conquer tie-breaking
  void test("ADV-B-023: A=[x,x,y] B=[y,x,x] — repeated tokens rotation", () => {
    // SPEC.md §5:316-318: same script required for all inputs including repeated tokens.
    const A: Tokens = ["x\n", "x\n", "y\n"];
    const B: Tokens = ["y\n", "x\n", "x\n"];
    oracle("x,x,y→y,x,x", A, B);
  });

  // ADV-B-024: A=["a\n","b\n","c\n","a\n","b\n"], B=["b\n","a\n","b\n","c\n"]
  void test("ADV-B-024: A=[a,b,c,a,b] B=[b,a,b,c] — repeated interleaved", () => {
    // SPEC.md §5:316-318: repeated tokens where the LCS is ambiguous — tie-breaking must match.
    const A: Tokens = ["a\n", "b\n", "c\n", "a\n", "b\n"];
    const B: Tokens = ["b\n", "a\n", "b\n", "c\n"];
    oracle("a,b,c,a,b→b,a,b,c", A, B);
  });

  // ADV-B-025: all identical tokens, longer sequences (forces Hirschberg path)
  void test("ADV-B-025: A=[a,a,a,a,a,a] B=[a,a,a,a] — repeated deletions", () => {
    // SPEC.md §5:316-318: identical tokens; tie-breaking must be consistent.
    const A: Tokens = ["a\n", "a\n", "a\n", "a\n", "a\n", "a\n"];
    const B: Tokens = ["a\n", "a\n", "a\n", "a\n"];
    oracle("6×a→4×a", A, B);
  });

  // ADV-B-026: palindrome-like repeated sequence
  void test("ADV-B-026: A=[a,b,a,b,a] B=[b,a,b] — palindrome structure", () => {
    // SPEC.md §5:316-318: tie-breaking on ambiguous sequences.
    const A: Tokens = ["a\n", "b\n", "a\n", "b\n", "a\n"];
    const B: Tokens = ["b\n", "a\n", "b\n"];
    oracle("a,b,a,b,a→b,a,b", A, B);
  });

  // ADV-B-027: insertion into middle of repeated tokens
  void test("ADV-B-027: A=[x,x,x] B=[x,y,x,x] — insert in repeated sequence", () => {
    // SPEC.md §5:316-318: must match reference for this tricky case.
    const A: Tokens = ["x\n", "x\n", "x\n"];
    const B: Tokens = ["x\n", "y\n", "x\n", "x\n"];
    oracle("x,x,x→x,y,x,x", A, B);
  });

  // ADV-B-028: AAABB → BBAAA (complete reversal of character classes)
  void test("ADV-B-028: A=[a,a,a,b,b] B=[b,b,a,a,a] — class reversal", () => {
    // SPEC.md §5:316-318: another hard case for divide-and-conquer.
    const A: Tokens = ["a\n", "a\n", "a\n", "b\n", "b\n"];
    const B: Tokens = ["b\n", "b\n", "a\n", "a\n", "a\n"];
    oracle("a,a,a,b,b→b,b,a,a,a", A, B);
  });

  // ADV-B-029: Hirschberg forced by size (>50 tokens) — repeated tokens
  void test("ADV-B-029: large (>50) repeated-token inputs trigger Hirschberg path", () => {
    // SPEC.md §5:316-318: diff() switches to Hirschberg for large inputs.
    // The threshold in diff.ts is 50. Use 60-token inputs with heavy repetition.
    const A: string[] = [];
    const B: string[] = [];
    for (let i = 0; i < 30; i++) A.push("a\n");
    for (let i = 0; i < 30; i++) A.push("b\n");
    for (let i = 0; i < 20; i++) B.push("b\n");
    for (let i = 0; i < 20; i++) B.push("a\n");
    for (let i = 0; i < 20; i++) B.push("b\n");
    oracle("30a+30b→20b+20a+20b (large)", A, B);
  });

  // ADV-B-030: specific tie case — two tokens, both different, symmetric costs
  void test("ADV-B-030: diff(['p\\n','q\\n'],['q\\n','p\\n']) tie-breaking", () => {
    // SPEC.md §5:310-312: at (0,0), A[0]='p\n' != B[0]='q\n'.
    // D(1,0): transform ['q\n'] → ['q\n','p\n'] = 1 (insert 'p\n')
    // D(0,1): transform ['p\n','q\n'] → ['p\n'] = 1 (delete 'q\n')
    // Tie → delete first.
    const A: Tokens = ["p\n", "q\n"];
    const B: Tokens = ["q\n", "p\n"];
    const ref = diffReference(A, B);
    const hirsch = diffHirschberg(A, B);
    assert.equal(
      ref[0]!.type,
      "delete",
      `Reference: first op should be delete (tie → delete). Got: ${scriptSummary(ref)}`,
    );
    assert.deepEqual(
      hirsch,
      ref,
      `Hirschberg diverged: ref=${scriptSummary(ref)}, hirsch=${scriptSummary(hirsch)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// edit.ts — validateEdit
// SPEC.md §4.4:259-270
// ---------------------------------------------------------------------------

void describe("ADV edit.ts — validateEdit", () => {
  // ADV-B-031: empty base, empty script — valid (consumed=0=base.length)
  void test("ADV-B-031: validateEdit([], []) passes — empty is valid", () => {
    // SPEC.md §4.4:270: "An empty script is valid only when creating an empty text file."
    // Empty base + empty script: consumed=0, baseLen=0 → valid.
    assertOk(validateEdit([], []));
  });

  // ADV-B-032: adjacent retain ops → must throw
  void test("ADV-B-032: validateEdit adjacent retain throws", () => {
    // SPEC.md §4.4:264: "Adjacent operations of the same kind are forbidden."
    const base: Tokens = ["a\n", "b\n"];
    const script: DiffScript = [
      { type: "retain", count: 1 },
      { type: "retain", count: 1 },
    ];
    assertErr(validateEdit(base, script), "adjacent retains must throw");
  });

  // ADV-B-033: adjacent delete ops → must throw
  void test("ADV-B-033: validateEdit adjacent delete throws", () => {
    // SPEC.md §4.4:264: "Adjacent operations of the same kind are forbidden."
    const base: Tokens = ["a\n", "b\n"];
    const script: DiffScript = [
      { type: "delete", count: 1 },
      { type: "delete", count: 1 },
    ];
    assertErr(validateEdit(base, script), "adjacent deletes must throw");
  });

  // ADV-B-034: count = 0 → must throw (not a positive integer)
  void test("ADV-B-034: validateEdit count=0 throws", () => {
    // SPEC.md §4.4:264: "Counts are positive safe integers." Zero is not positive.
    const base: Tokens = ["a\n"];
    const script: DiffScript = [{ type: "retain", count: 0 }];
    assertErr(validateEdit(base, script), "count=0 must throw — not a positive safe integer");
  });

  // ADV-B-035: count = Number.MAX_SAFE_INTEGER + 1 → must throw (exceeds safe integer)
  void test("ADV-B-035: validateEdit count > MAX_SAFE_INTEGER throws", () => {
    // SPEC.md §4.4:264: "Counts are positive safe integers."
    // MAX_SAFE_INTEGER+1 = 9007199254740992, which is NOT a safe integer.
    const base: Tokens = ["a\n"];
    const script: DiffScript = [{ type: "retain", count: Number.MAX_SAFE_INTEGER + 1 }];
    assertErr(validateEdit(base, script), "count > MAX_SAFE_INTEGER must throw");
  });

  // ADV-B-036: insert with empty token [""] → must throw
  void test("ADV-B-036: validateEdit insert:[''] throws", () => {
    // SPEC.md §4.4:261: "inserts one or more nonempty text tokens"
    const base: Tokens = [];
    const script: DiffScript = [{ type: "insert", tokens: [""] }];
    assertErr(validateEdit(base, script), "insert with empty-string token must throw");
  });

  // ADV-B-037: script that under-consumes base → must throw
  void test("ADV-B-037: validateEdit under-consuming script throws", () => {
    // SPEC.md §4.4:265: "The script MUST consume the complete old token sequence"
    const base: Tokens = ["a\n", "b\n"];
    const script: DiffScript = [{ type: "retain", count: 1 }]; // only consumes 1 of 2
    assertErr(validateEdit(base, script), "under-consuming script must throw");
  });

  // ADV-B-038: script that over-consumes base → must throw
  void test("ADV-B-038: validateEdit over-consuming script throws", () => {
    // SPEC.md §4.4:265: "The script MUST consume the complete old token sequence"
    const base: Tokens = ["a\n"];
    const script: DiffScript = [{ type: "retain", count: 2 }]; // tries to consume 2, only 1 exists
    assertErr(validateEdit(base, script), "over-consuming script must throw");
  });

  // ADV-B-039: insert tokens = [] (zero-length array) → must throw
  void test("ADV-B-039: validateEdit insert:[] (empty array) throws", () => {
    // SPEC.md §4.4:261: "inserts one or more nonempty text tokens" — zero tokens is invalid.
    const base: Tokens = [];
    const script: DiffScript = [{ type: "insert", tokens: [] }];
    assertErr(validateEdit(base, script), "insert with zero tokens must throw");
  });

  // ADV-B-040: non-integer count (1.5) → must throw
  void test("ADV-B-040: validateEdit count=1.5 (non-integer) throws", () => {
    // SPEC.md §4.4:264: "positive safe integers" — 1.5 is not an integer.
    const base: Tokens = ["a\n", "b\n"];
    const script: DiffScript = [{ type: "retain", count: 1.5 }];
    assertErr(validateEdit(base, script), "non-integer count must throw");
  });

  // ADV-B-041: negative count → must throw
  void test("ADV-B-041: validateEdit count=-1 (negative) throws", () => {
    // SPEC.md §4.4:264: "positive safe integers" — negative is not positive.
    const base: Tokens = ["a\n"];
    const script: DiffScript = [{ type: "delete", count: -1 }];
    assertErr(validateEdit(base, script), "negative count must throw");
  });
});

// ---------------------------------------------------------------------------
// ot.ts — transform
// SPEC.md §6.3:376-393
// ---------------------------------------------------------------------------

void describe("ADV ot.ts — transform", () => {
  function otIntegration(
    base: Tokens,
    P: DiffScript,
    Q: DiffScript,
    expectedFinal: Tokens,
    label: string,
  ): void {
    const afterQ = assertOk(applyEdit(base, Q));
    const Pprime = transform(P, Q);
    const final = assertOk(applyEdit(afterQ, Pprime));
    assert.deepEqual(
      final,
      [...expectedFinal],
      `[${label}] OT integration failed.\n  P:  ${scriptSummary(P)}\n  Q:  ${scriptSummary(Q)}\n  P': ${scriptSummary(Pprime)}\n  afterQ: ${JSON.stringify(afterQ)}\n  expected: ${JSON.stringify([...expectedFinal])}\n  got: ${JSON.stringify(final)}`,
    );
  }

  // ADV-B-042: PLAN.md §6.1 dd case — verify exact P' structure
  void test("ADV-B-042: dd case P'=[r1,d1,r2] — PLAN.md §6.1 derivation", () => {
    // SPEC.md §6.3:376-393; PLAN.md §6.1: independently derived.
    // P=[r1,d2,r2], Q=[r1,d1,r3] → P'=[r1,d1,r2]
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 2 },
      { type: "retain", count: 2 },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 1 },
      { type: "retain", count: 3 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(
      scriptSummary(Pprime),
      "r1,d1,r2",
      `Expected r1,d1,r2, got: ${scriptSummary(Pprime)}`,
    );
    const base: Tokens = ["0\n", "1\n", "2\n", "3\n", "4\n"];
    otIntegration(base, P, Q, ["0\n", "3\n", "4\n"], "dd case");
  });

  // ADV-B-043: PLAN.md §6.1 survive case — Q-insert priority emits retain
  void test("ADV-B-043: survive case P'=[r2,d1,r3] — Q-insert priority", () => {
    // SPEC.md §6.3:387-389: "The Q insert row has priority. Concurrent inserts at one
    // cursor therefore appear in canonical integration order."
    // P=[r1,d1,r3], Q=[r1,insert["B\n"],r4] → P'=[r2,d1,r3]
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 1 },
      { type: "retain", count: 3 },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["B\n"] },
      { type: "retain", count: 4 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(
      scriptSummary(Pprime),
      "r2,d1,r3",
      `Expected r2,d1,r3, got: ${scriptSummary(Pprime)}`,
    );
    const base: Tokens = ["0\n", "1\n", "2\n", "3\n", "4\n"];
    otIntegration(base, P, Q, ["0\n", "B\n", "2\n", "3\n", "4\n"], "survive case");
  });

  // ADV-B-044: concurrent inserts at one cursor — Q-insert gets priority
  // P=[r2,insert["X\n"],r2], Q=[r2,insert["Y\n"],r2]
  // SPEC.md §6.3:387: Q-insert has priority → retain(1) for Y, then P's insert["X\n"], then retain(2)
  // P' = [r3, insert["X\n"], r2]
  void test("ADV-B-044: concurrent inserts at same cursor — Q-insert has priority", () => {
    // SPEC.md §6.3:387-389: Q-insert priority. Base has 4 tokens.
    // After Q inserts "Y\n" at pos 2: [t0,t1,Y,t2,t3].
    // P' must retain the 3 tokens (t0,t1,Y) then insert "X\n" then retain 2 (t2,t3).
    const base: Tokens = ["t0\n", "t1\n", "t2\n", "t3\n"];
    const P: DiffScript = [
      { type: "retain", count: 2 },
      { type: "insert", tokens: ["X\n"] },
      { type: "retain", count: 2 },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 2 },
      { type: "insert", tokens: ["Y\n"] },
      { type: "retain", count: 2 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(
      scriptSummary(Pprime),
      "r3,i[X\n],r2",
      `Expected r3,i[X\\n],r2, got: ${scriptSummary(Pprime)}`,
    );
    // Verify integration: after Q, base is [t0,t1,Y,t2,t3].
    // Apply P'=[r3,i["X\n"],r2] → [t0,t1,Y,X,t2,t3]
    otIntegration(base, P, Q, ["t0\n", "t1\n", "Y\n", "X\n", "t2\n", "t3\n"], "concurrent inserts");
  });

  // ADV-B-045: partial-overlap delete/delete — the specific case from the task
  // P=[delete:3, retain:2], Q=[delete:2, retain:3]
  // Base: ["a\n","b\n","c\n","d\n","e\n"] (5 tokens)
  // P deletes first 3; Q deletes first 2.
  // After Q: ["c\n","d\n","e\n"]
  // P' trace:
  //   Q.d2(2), P.d3(3): row 6 (P-delete Q-delete) → nothing, consume min(2,3)=2. Q done. P has d1.
  //   Q.r3(3), P.d1(1): row 4 (P-delete Q-retain) → delete(1), consume min(1,3)=1. Q has r2. P done.
  //   Q.r2(2), P.r2(2): row 3 (P-retain Q-retain) → retain(2). Both done.
  // P' = [delete(1), retain(2)]
  void test("ADV-B-045: partial-overlap P.d3+Q.d2 → P'=[d1,r2]", () => {
    // SPEC.md §6.3:376-393: delete/delete row consumes both, P-delete Q-retain outputs delete.
    const base: Tokens = ["a\n", "b\n", "c\n", "d\n", "e\n"];
    const P: DiffScript = [
      { type: "delete", count: 3 },
      { type: "retain", count: 2 },
    ];
    const Q: DiffScript = [
      { type: "delete", count: 2 },
      { type: "retain", count: 3 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "d1,r2", `Expected d1,r2, got: ${scriptSummary(Pprime)}`);
    // After Q: ["c\n","d\n","e\n"]. Apply P'=[d1,r2] → ["d\n","e\n"]
    otIntegration(base, P, Q, ["d\n", "e\n"], "partial-overlap dd");
  });

  // ADV-B-046: three concurrent inserts via two-step transforms at same position
  // Verify that the ordering is deterministic and each step uses Q-insert priority.
  void test("ADV-B-046: three concurrent inserts chain — Q-insert priority applies at each step", () => {
    // SPEC.md §6.3:387-389: concurrent inserts appear in canonical integration order.
    // Base: ["x\n"] (1 token)
    // First concurrent pair: P1=[insert["A\n"],r1], P2=[insert["B\n"],r1]
    // Transform P1 through P2 (P2 = Q): P' = [r1,insert["A\n"],r1]
    // Then apply chain to second pair.
    const base: Tokens = ["x\n"];
    const P1: DiffScript = [
      { type: "insert", tokens: ["A\n"] },
      { type: "retain", count: 1 },
    ];
    const P2: DiffScript = [
      { type: "insert", tokens: ["B\n"] },
      { type: "retain", count: 1 },
    ];
    const P3: DiffScript = [
      { type: "insert", tokens: ["C\n"] },
      { type: "retain", count: 1 },
    ];
    // Step 1: transform P1 through P2 (P2 goes first)
    const P1prime = transform(P1, P2);
    // P2 insert has priority → retain(1) for B, then P1's insert["A\n"], then retain(1)
    assert.equal(scriptSummary(P1prime), "r1,i[A\n],r1");

    // Verify integration: after P2 applied to base = ["B\n","x\n"]
    // Apply P1' = [r1,i["A\n"],r1] → ["B\n","A\n","x\n"]
    otIntegration(base, P1, P2, ["B\n", "A\n", "x\n"], "3-concurrent first pair");

    // Step 2: transform P3 through the already-applied P2 for comparison
    const P3prime = transform(P3, P2);
    assert.equal(scriptSummary(P3prime), "r1,i[C\n],r1");
  });

  // ADV-B-047: Q delete before P insert at same cursor — delete does NOT affect P's insert
  // SPEC.md §6.3:390: "Deletion consumes only base tokens, so concurrent inserted text survives."
  void test("ADV-B-047: Q delete before P insert — inserted text survives", () => {
    // SPEC.md §6.3:390: "Deletion consumes only base tokens"
    // Base: ["a\n","b\n"]
    // P=[r1,insert["NEW\n"],d1]: retains "a\n", inserts "NEW\n", deletes "b\n"
    // Q=[d1,r1]: deletes "a\n", retains "b\n"
    // Transform P through Q:
    //   Q.d1, P.r1: row 5 (P-retain Q-delete) → nothing, consume 1. Both done with first op.
    //   Q.r1, P.insert["NEW\n"]: row 2 (P-insert) → insert["NEW\n"], advance P.
    //   Q.r1(rem=1), P.d1(1): row 4 (P-delete Q-retain) → delete(1), consume 1. Both done.
    //   P' = [insert["NEW\n"], delete(1)]
    // After Q: ["b\n"]. Apply P'=[insert["NEW\n"],d1] → ["NEW\n"]
    const base: Tokens = ["a\n", "b\n"];
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["NEW\n"] },
      { type: "delete", count: 1 },
    ];
    const Q: DiffScript = [
      { type: "delete", count: 1 },
      { type: "retain", count: 1 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(
      scriptSummary(Pprime),
      "i[NEW\n],d1",
      `Expected i[NEW\\n],d1, got: ${scriptSummary(Pprime)}`,
    );
    otIntegration(base, P, Q, ["NEW\n"], "Q-delete before P-insert");
  });

  // ADV-B-048: both delete all tokens — P' must be empty
  void test("ADV-B-048: both P and Q delete all tokens — P' is empty", () => {
    // SPEC.md §6.3 row 6: P-delete Q-delete → nothing. If both delete everything, P'=[].
    const base: Tokens = ["a\n", "b\n", "c\n"];
    const P: DiffScript = [{ type: "delete", count: 3 }];
    const Q: DiffScript = [{ type: "delete", count: 3 }];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "", `Expected empty P', got: ${scriptSummary(Pprime)}`);
    assert.deepEqual(Pprime, []);
    // After Q: []. Apply P'=[] → []. Both converge to empty.
    otIntegration(base, P, Q, [], "both delete all");
  });

  // ADV-B-049: P retains everything, Q deletes everything — P' must also be empty
  void test("ADV-B-049: P retains all, Q deletes all — P' is empty (no retains survive)", () => {
    // SPEC.md §6.3 row 5: P-retain Q-delete → nothing. If Q deletes everything P was retaining,
    // P' has nothing to retain.
    const base: Tokens = ["a\n", "b\n"];
    const P: DiffScript = [{ type: "retain", count: 2 }];
    const Q: DiffScript = [{ type: "delete", count: 2 }];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "", `Expected empty P', got: ${scriptSummary(Pprime)}`);
    // After Q: []. Apply P'=[] → [].
    otIntegration(base, P, Q, [], "P-retain Q-delete-all");
  });

  // ADV-B-050: count-splitting correctness — P has large delete spanning Q boundary
  void test("ADV-B-050: P delete spans Q retain+delete boundary — exact count splitting", () => {
    // SPEC.md §6.3: "splitting counts as needed"
    // Base: ["a\n","b\n","c\n","d\n","e\n"] (5 tokens)
    // P=[delete:5]: delete everything
    // Q=[r2,d1,r2]: retains 2, deletes "c\n", retains 2
    // Transform P through Q:
    //   Q.r2(2), P.d5(5): row 4 (P-delete Q-retain) → delete(2), consume 2. Q done. P has d3.
    //   Q.d1(1), P.d3(3): row 6 (P-delete Q-delete) → nothing, consume min(1,3)=1. Q done. P has d2.
    //   Q.r2(2), P.d2(2): row 4 (P-delete Q-retain) → delete(2), consume 2. Both done.
    //   P' = [delete(2), delete(2)] = coalesced to [delete(4)]
    // After Q: ["a\n","b\n","d\n","e\n"]. Apply P'=[d4] → []
    const base: Tokens = ["a\n", "b\n", "c\n", "d\n", "e\n"];
    const P: DiffScript = [{ type: "delete", count: 5 }];
    const Q: DiffScript = [
      { type: "retain", count: 2 },
      { type: "delete", count: 1 },
      { type: "retain", count: 2 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "d4", `Expected d4, got: ${scriptSummary(Pprime)}`);
    otIntegration(base, P, Q, [], "P-delete-all Q-retain+delete");
  });
});

// ---------------------------------------------------------------------------
// Combined: diff output feeds OT — end-to-end coherence
// SPEC.md §5 + §6.3
// ---------------------------------------------------------------------------

void describe("ADV end-to-end: diff feeds OT — coherence check", () => {
  function e2eOT(
    baseText: string,
    aliceText: string,
    bobText: string,
    expectedText: string,
    label: string,
  ): void {
    function tokText(text: string): Tokens {
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
    const base = tokText(baseText);
    const alice = tokText(aliceText);
    const bob = tokText(bobText);
    const expected = tokText(expectedText);
    const P = diffReference(base, alice);
    const Q = diffReference(base, bob);
    const afterQ = assertOk(applyEdit(base, Q));
    const Pprime = transform(P, Q);
    const final = assertOk(applyEdit(afterQ, Pprime));
    assert.deepEqual(
      final,
      [...expected],
      `[${label}]\n  P:  ${scriptSummary(P)}\n  Q:  ${scriptSummary(Q)}\n  P': ${scriptSummary(Pprime)}\n  afterQ: ${JSON.stringify(afterQ)}\n  expected: ${JSON.stringify([...expected])}\n  got: ${JSON.stringify(final)}`,
    );
  }

  // ADV-B-051: both prepend different lines — Q (bob) appears first, then P (alice)
  void test("ADV-B-051: both prepend — Q-insert appears before P-insert", () => {
    // SPEC.md §6.3:387-389: concurrent inserts at one cursor appear in canonical order (Q first).
    e2eOT("base\n", "alice\nbase\n", "bob\nbase\n", "bob\nalice\nbase\n", "both prepend");
  });

  // ADV-B-052: both append different lines — Q append appears before P append
  void test("ADV-B-052: both append — Q-insert before P-insert at same trailing cursor", () => {
    // SPEC.md §6.3:387-389: at the trailing cursor, Q-insert has priority.
    e2eOT("base\n", "base\nalice\n", "base\nbob\n", "base\nbob\nalice\n", "both append");
  });

  // ADV-B-053: P deletes a line Q also deletes — result has no double deletion
  void test("ADV-B-053: both delete same line — no double deletion", () => {
    // SPEC.md §6.3 row 6: P-delete Q-delete → nothing. Token deleted once is enough.
    e2eOT("a\nb\nc\n", "a\nc\n", "a\nc\n", "a\nc\n", "same deletion");
  });

  // ADV-B-054: interleaved adds and deletes — complex scenario
  void test("ADV-B-054: interleaved adds and deletes", () => {
    // SPEC.md §6.3: full table exercised in one test.
    // base: a, b, c, d
    // alice (P): removes b, adds X after a → a, X, c, d
    //   P = diff(base, alice) = [r1, d1, i["X\n"], r2]
    // bob (Q): removes c, adds Y after b → a, b, Y, d
    //   Q = diff(base, bob) = [r2, d1, i["Y\n"], r1]
    //
    // Transform P through Q:
    //   Q.r2(2), P.r1(1): P-retain Q-retain → retain(1), consume 1. Q has r1. P done.
    //   Q.r1(1), P.d1(1): P-delete Q-retain → delete(1), consume 1. Both done.
    //   Q.d1(1), P.i["X\n"]: Q not insert; P is insert → row 2 → output insert["X\n"]. P advances.
    //   Q.d1(1), P.r2(2): P-retain Q-delete → nothing, consume min(1,2)=1. Q done. P has r1.
    //   Q.i["Y\n"]: row 1 → retain(1). Q done.
    //   Q.r1(1), P.r1(1): retain(1). Both done.
    //   P' = [r1, d1, i["X\n"], r2] (same as P — the edits didn't overlap)
    //
    // After Q: [a, b, Y, d]. Apply P'=[r1,d1,i["X\n"],r2] → [a, X, Y, d]
    e2eOT("a\nb\nc\nd\n", "a\nX\nc\nd\n", "a\nb\nY\nd\n", "a\nX\nY\nd\n", "interleaved");
  });
});
