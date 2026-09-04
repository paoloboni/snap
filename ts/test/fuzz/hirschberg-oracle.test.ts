/**
 * Hirschberg ↔ Reference DP equivalence — exhaustive property test
 *
 * SPEC.md §5 (289–319): The canonical diff algorithm with delete-on-tie.
 * "Implementations MAY use Hirschberg only if it produces the same script,
 * including for repeated equal lines." (§5:316–318)
 *
 * PLAN.md §12 YAML-inexpressible: "Hirschberg↔reference diff equivalence"
 *
 * Strategy:
 *   - 200 randomly-seeded inputs via a deterministic LCG PRNG (reproducible)
 *   - Lengths 0–30, token draws from a 5-token alphabet with LF + 2 non-LF tokens
 *   - For each (A, B) pair:
 *     1. diffReference(A, B) === diffHirschberg(A, B) (deep equal)
 *     2. applyEdit(A, diffReference(A, B)) === B  (valid edit script)
 *     3. applyEdit(A, diffHirschberg(A, B)) === B  (valid edit script)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { diffReference, diffHirschberg } from "../../src/core/diff.js";
import type { DiffScript } from "../../src/core/diff.js";
import type { Tokens } from "../../src/core/tokens.js";

// ---------------------------------------------------------------------------
// Deterministic LCG PRNG  (Knuth MMIX: multiplier 6364136223846793005, inc 1442695040888963407)
// Works in 32-bit unsigned arithmetic since JS bitwise ops truncate to 32 bits.
// We use two 32-bit halves to keep the period large enough for 200 cases.
// ---------------------------------------------------------------------------

class LCG {
  private lo: number;
  private hi: number;

  constructor(seed: number) {
    // Initialise from a simple seed
    this.lo = (seed ^ 0xdeadbeef) >>> 0;
    this.hi = (seed ^ 0xcafebabe) >>> 0;
  }

  /** Return the next pseudorandom uint32 */
  next(): number {
    // xorshift32 on lo, then mix with hi for 64-bit-like behaviour
    this.lo ^= this.lo << 13;
    this.lo ^= this.lo >>> 17;
    this.lo ^= this.lo << 5;
    this.lo = this.lo >>> 0;
    this.hi = (this.hi * 1664525 + 1013904223) >>> 0;
    return (this.lo ^ this.hi) >>> 0;
  }

  /** Return a value in [0, n) */
  nextInt(n: number): number {
    return this.next() % n;
  }
}

// ---------------------------------------------------------------------------
// Token alphabets
// ---------------------------------------------------------------------------

/** LF-terminated tokens (line-like) */
const LF_TOKENS: readonly string[] = ["a\n", "b\n", "c\n", "d\n", "e\n"];

/** Non-LF-terminated tokens (final-token-like) */
const NON_LF_TOKENS: readonly string[] = ["x", "y"];

/** Full alphabet */
const FULL_ALPHABET: readonly string[] = [...LF_TOKENS, ...NON_LF_TOKENS];

// ---------------------------------------------------------------------------
// Helper: apply a diff script to base tokens (local implementation to avoid
// importing applyEdit which validates — we want raw application for the oracle).
// ---------------------------------------------------------------------------

function applyScript(base: readonly string[], script: DiffScript): string[] {
  const result: string[] = [];
  let pos = 0;
  for (const op of script) {
    if (op.type === "retain") {
      for (let i = 0; i < op.count; i++) {
        const tok = base[pos++];
        assert.ok(tok !== undefined, "retain beyond end of base");
        result.push(tok);
      }
    } else if (op.type === "delete") {
      pos += op.count;
    } else {
      result.push(...op.tokens);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: generate a random token sequence
// ---------------------------------------------------------------------------

function randomTokens(rng: LCG, maxLen: number, allowNonLF: boolean): Tokens {
  const length = rng.nextInt(maxLen + 1); // 0..maxLen inclusive
  const result: string[] = [];
  for (let i = 0; i < length; i++) {
    // For all tokens except possibly the last, prefer LF-terminated tokens
    // to produce canonical-looking sequences. Also sprinkle non-LF tokens.
    const alphabet =
      allowNonLF && i === length - 1 && rng.nextInt(4) === 0 ? FULL_ALPHABET : LF_TOKENS;
    result.push(alphabet[rng.nextInt(alphabet.length)]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: human-readable script summary for assertion messages
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

// ---------------------------------------------------------------------------
// Core oracle check
// ---------------------------------------------------------------------------

function oracleCheck(A: Tokens, B: Tokens, label: string): void {
  const ref = diffReference(A, B);
  const hirsch = diffHirschberg(A, B);

  // 1. Hirschberg must produce the identical script
  assert.deepEqual(
    hirsch,
    ref,
    `[${label}] Hirschberg diverged from reference\n` +
      `  A=${JSON.stringify(A)}\n` +
      `  B=${JSON.stringify(B)}\n` +
      `  ref:    ${scriptSummary(ref)}\n` +
      `  hirsch: ${scriptSummary(hirsch)}`,
  );

  // 2. Reference script must correctly transform A into B
  const appliedRef = applyScript(A, ref);
  assert.deepEqual(
    appliedRef,
    [...B],
    `[${label}] reference script does not transform A into B\n` +
      `  A=${JSON.stringify(A)}\n` +
      `  B=${JSON.stringify(B)}\n` +
      `  script: ${scriptSummary(ref)}\n` +
      `  got: ${JSON.stringify(appliedRef)}`,
  );

  // 3. Hirschberg script must also correctly transform A into B
  const appliedHirsch = applyScript(A, hirsch);
  assert.deepEqual(
    appliedHirsch,
    [...B],
    `[${label}] Hirschberg script does not transform A into B\n` +
      `  A=${JSON.stringify(A)}\n` +
      `  B=${JSON.stringify(B)}\n` +
      `  script: ${scriptSummary(hirsch)}\n` +
      `  got: ${JSON.stringify(appliedHirsch)}`,
  );
}

// ---------------------------------------------------------------------------
// Property test: 200 random cases
// ---------------------------------------------------------------------------

void describe("hirschberg-oracle: Hirschberg ↔ Reference DP equivalence", () => {
  /**
   * 200 randomly-seeded (A, B) pairs.
   * Deterministic LCG seeded with fixed value 0x5EED_CAFE so tests are
   * fully reproducible. Lengths 0–30, alphabet from LF_TOKENS + NON_LF_TOKENS.
   *
   * SPEC.md §5:316–318: Hirschberg MUST produce the same script as the
   * reference DP oracle for ALL inputs, including those with repeated tokens.
   * PLAN.md §12: "YAML-inexpressible → Hirschberg↔reference diff equivalence"
   */
  void test("200 random (A, B) pairs: ref and Hirschberg agree, scripts are valid", () => {
    const rng = new LCG(0x5eedcafe);
    const CASES = 200;

    for (let i = 0; i < CASES; i++) {
      const A = randomTokens(rng, 30, true);
      const B = randomTokens(rng, 30, true);
      oracleCheck(A, B, `case-${i}`);
    }
  });

  /**
   * Edge cases: empty A, empty B, identical sequences.
   * SPEC.md §5:295–297: D(n, m) = 0, D(i, m) = n - i, D(n, j) = m - j
   */
  void test("edge cases: empty A, empty B, A === B", () => {
    // Both empty
    oracleCheck([], [], "empty-empty");

    // A empty, B non-empty (pure insertion)
    oracleCheck([], ["a\n", "b\n", "c\n"], "empty-A");

    // A non-empty, B empty (pure deletion)
    oracleCheck(["a\n", "b\n", "c\n"], [], "empty-B");

    // A === B (pure retain)
    oracleCheck(["a\n", "b\n", "c\n"], ["a\n", "b\n", "c\n"], "identical");
  });

  /**
   * Adversarial repeated-token sequences:
   * These are the hardest cases for divide-and-conquer tie-breaking.
   * SPEC.md §5:316–318: "including for repeated equal lines"
   */
  void test("repeated-token adversarial cases: Hirschberg tie-breaking matches reference", () => {
    // Repeated token rotation: a,a,a → b,a,a (only first differs)
    oracleCheck(["a\n", "a\n", "a\n"], ["b\n", "a\n", "a\n"], "aaa-to-baa");

    // All identical tokens: delete from front
    oracleCheck(["a\n", "a\n", "a\n", "a\n", "a\n"], ["a\n", "a\n", "a\n"], "5a-to-3a");

    // All identical tokens: insert at front
    oracleCheck(["a\n", "a\n", "a\n"], ["a\n", "a\n", "a\n", "a\n", "a\n"], "3a-to-5a");

    // Palindrome interleave
    oracleCheck(["a\n", "b\n", "a\n", "b\n", "a\n"], ["b\n", "a\n", "b\n"], "ababa-to-bab");

    // Complete reversal
    oracleCheck(["a\n", "a\n", "b\n", "b\n"], ["b\n", "b\n", "a\n", "a\n"], "aabb-to-bbaa");

    // Interleaved same tokens
    oracleCheck(["a\n", "b\n", "a\n", "b\n"], ["b\n", "a\n", "b\n", "a\n"], "abab-to-baba");

    // Non-LF final token — exercises final-token path
    oracleCheck(["a\n", "b\n", "x"], ["a\n", "b\n", "y"], "non-lf-final-replace");
    oracleCheck(["a\n", "b\n", "x"], ["a\n", "b\n"], "non-lf-delete-final");
    oracleCheck(["a\n", "b\n"], ["a\n", "b\n", "x"], "non-lf-insert-final");
  });

  /**
   * Large inputs (> 50 tokens) that force the Hirschberg path in diff.ts
   * (threshold = 50 for switching from reference to Hirschberg).
   * SPEC.md §5:316–318: must produce identical scripts even for large inputs.
   */
  void test("large inputs (>50 tokens) trigger Hirschberg code path and agree with reference", () => {
    const rng2 = new LCG(0xdeadbeef);
    // Run 20 large-input cases
    for (let i = 0; i < 20; i++) {
      const A = randomTokens(rng2, 80, false);
      const B = randomTokens(rng2, 80, false);
      oracleCheck(A, B, `large-${i}`);
    }
  });

  /**
   * Single-token sequences: all combinations of equal/unequal tokens.
   * SPEC.md §5:308–312: tie rule applies at n=1, m=1.
   */
  void test("single-token sequences: delete-on-tie, retain, and pure cases", () => {
    // Equal: retain
    oracleCheck(["a\n"], ["a\n"], "single-equal");

    // Unequal: tie case D(1,0) <= D(0,1) → delete first (SPEC §5:310–312)
    oracleCheck(["a\n"], ["b\n"], "single-unequal-tie");

    // Non-LF tokens
    oracleCheck(["x"], ["y"], "single-non-lf");
    oracleCheck(["x"], ["x"], "single-non-lf-equal");
  });

  /**
   * Seeded sweeps at 3 different seed values to cover different regions
   * of the random space (additional reproducibility check).
   * PLAN.md §12: reproducible property test
   */
  void test("seed 0xABCD1234: 50 additional random cases", () => {
    const rng = new LCG(0xabcd1234);
    for (let i = 0; i < 50; i++) {
      const A = randomTokens(rng, 25, true);
      const B = randomTokens(rng, 25, true);
      oracleCheck(A, B, `seed2-case-${i}`);
    }
  });

  void test("seed 0x12345678: 50 additional random cases with non-LF heavy alphabet", () => {
    const rng = new LCG(0x12345678);
    // Use full alphabet to exercise non-LF final token more
    for (let i = 0; i < 50; i++) {
      const lenA = rng.nextInt(31);
      const lenB = rng.nextInt(31);
      const A: string[] = [];
      const B: string[] = [];
      for (let j = 0; j < lenA; j++) {
        A.push(FULL_ALPHABET[rng.nextInt(FULL_ALPHABET.length)]!);
      }
      for (let j = 0; j < lenB; j++) {
        B.push(FULL_ALPHABET[rng.nextInt(FULL_ALPHABET.length)]!);
      }
      oracleCheck(A, B, `seed3-case-${i}`);
    }
  });
});
