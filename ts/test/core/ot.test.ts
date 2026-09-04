/**
 * Tests for core/ot.ts
 * SPEC.md §6.3: OT transform (Q-insert priority, 6-row table)
 * Verified against all 4 test-22 OT cases from PLAN.md §6.1
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { transform } from "../../src/core/ot.js";
import { applyEdit } from "../../src/core/edit.js";
import { diffReference } from "../../src/core/diff.js";
import type { DiffScript } from "../../src/core/diff.js";
import type { Tokens } from "../../src/core/tokens.js";

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

function scriptSummary(s: DiffScript): string {
  return s
    .map((op) => {
      if (op.type === "retain") return `r${op.count}`;
      if (op.type === "delete") return `d${op.count}`;
      return `i[${op.tokens.join(",")}]`;
    })
    .join(",");
}

/**
 * Integration test: given base, P (alice's edit), Q (bob's edit context),
 * transform P through Q and apply to Q's result; verify the merged content.
 */
function otIntegrationTest(
  base: Tokens,
  P: DiffScript,
  Q: DiffScript,
  expectedFinal: Tokens,
): void {
  // Q's result = apply Q to base
  const afterQ = applyEdit(base, Q) as Tokens;
  // P' = transform(P, Q)
  const Pprime = transform(P, Q);
  // Final = apply P' to Q's result
  const final = applyEdit(afterQ, Pprime) as Tokens;
  assert.deepEqual(
    final,
    [...expectedFinal],
    `OT integration failed.\n  P: ${scriptSummary(P)}\n  Q: ${scriptSummary(Q)}\n  P': ${scriptSummary(Pprime)}\n  afterQ: ${JSON.stringify(afterQ)}\n  expected: ${JSON.stringify([...expectedFinal])}\n  got: ${JSON.stringify(final)}`,
  );
}

// ---------------------------------------------------------------------------
// Test-22 cases (from PLAN.md §6.1 — all four verified by derivation)
// ---------------------------------------------------------------------------

void describe("test-22 OT cases (verified by independent derivation)", () => {
  // Base: "0\n1\n2\n3\n4\n"
  const base = tok("0\n1\n2\n3\n4\n");

  void test("dd case: both delete concurrent base tokens", () => {
    // alice (P): [r1, d2, r2] — deletes tokens 1,2
    // bob (Q): [r1, d1, r3] — deletes token 1
    // Integration: bob first (lower Snap order), then alice
    // Q = diff(base, bob's result)
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
    // Expected P' = [r1, d1, r2]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r1,d1,r2", `P' was: ${scriptSummary(Pprime)}`);
    // After Q's result ["0\n","2\n","3\n","4\n"], apply P' = retain(1),delete(1),retain(2)
    // → ["0\n","3\n","4\n"]
    otIntegrationTest(base, P, Q, tok("0\n3\n4\n"));
  });

  void test("dd case: symmetric merge from other direction", () => {
    // bob merges alice (P_bob=[r1,d1,r3], Q_alice=[r1,d2,r2])
    // This verifies convergence
    const base2 = tok("0\n1\n2\n3\n4\n");
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 1 },
      { type: "retain", count: 3 },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 2 },
      { type: "retain", count: 2 },
    ];
    // Q applied to base = ["0\n","3\n","4\n"] (alice's result)
    // P' = transform(P, Q): Q.r1,P.r1 → r1; Q.d2,P.d1 → min=1,delete → P has d0 left; next Q.d1,P.r3 → nothing; Q.r2,P.r3-1=r2? wait...
    // Actually: P.d1 vs Q.d2: min=1, P-delete Q-delete = nothing, consume 1 each. P exhausted. Q has d1 remaining.
    // Q.d1 remaining, P.r3: P-retain Q-delete → nothing, consume min(1,3)=1. Q exhausted. P has r2 remaining.
    // Q.r2, P.r2: retain(2). Done.
    // P' = [r1, r2] = [r3]? Wait...
    // Hmm: r1 from first step, then r2 from last step = r(1+2) = r3? but base2 was 5 tokens, Q consumed all.
    // Let me trace again:
    // P=[r1,d1,r3], Q=[r1,d2,r2]
    // Step 1: Q.r1(rem=1), P.r1(rem=1) → P-retain Q-retain → retain(1), consume 1 from both. Both done with their first op.
    // Step 2: Q.d2(rem=2), P.d1(rem=1) → P-delete Q-delete → nothing, consume min(1,2)=1. P exhausted (d1 done). Q has d1 remaining.
    // Step 3: Q.d1(rem=1), P.r3(rem=3) → P-retain Q-delete → nothing, consume min(1,3)=1. Q exhausted. P has r2 remaining.
    // Step 4: Q.r2(rem=2), P.r2(rem=2) → P-retain Q-retain → retain(2), consume 2 from both.
    // P' = [retain(1), retain(2)] coalesced = [retain(3)]
    // Apply retain(3) to Q's result ["0\n","3\n","4\n"] → ["0\n","3\n","4\n"] ✓
    otIntegrationTest(base2, P, Q, tok("0\n3\n4\n"));
  });

  void test("split case: P insert + Q insert + unequal splits + trailing P insert", () => {
    // alice (P): [insert["A\n"], r1, d2, r2, insert["TAIL\n"]]
    // bob (Q): [r2, d1, insert["B\n"], r2]
    const P: DiffScript = [
      { type: "insert", tokens: ["A\n"] },
      { type: "retain", count: 1 },
      { type: "delete", count: 2 },
      { type: "retain", count: 2 },
      { type: "insert", tokens: ["TAIL\n"] },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 2 },
      { type: "delete", count: 1 },
      { type: "insert", tokens: ["B\n"] },
      { type: "retain", count: 2 },
    ];
    // Expected result: "A\n0\nB\n3\n4\nTAIL\n"
    otIntegrationTest(base, P, Q, tok("A\n0\nB\n3\n4\nTAIL\n"));

    // Also verify P' structure
    const Pprime = transform(P, Q);
    // Trace:
    // Q.r2(rem=2), P.insert["A\n"]: row 2 (P insert) → output insert["A\n"], P advances
    // Q.r2(rem=2), P.r1(rem=1): row 3 (P retain, Q retain) → retain(1), consume min(1,2)=1. P done. Q has r1.
    // Q.r1(rem=1), P.d2(rem=2): row 4 (P delete, Q retain) → delete(1), consume min(1,2)=1. Q done. P has d1.
    // Q.d1(rem=1), P.d1(rem=1): row 6 (P delete, Q delete) → nothing, consume 1 each. Both done.
    // Q.insert["B\n"]: row 1 (Q insert) → retain(1). Q done.
    // Q.r2(rem=2), P.r2(rem=2): row 3 → retain(2). Both done.
    // P.insert["TAIL\n"]: row 2 (P insert) → insert["TAIL\n"].
    // P' = [insert["A\n"], retain(1), delete(1), retain(3), insert["TAIL\n"]]
    assert.equal(
      scriptSummary(Pprime),
      "i[A\n],r1,d1,r3,i[TAIL\n]",
      `P' was: ${scriptSummary(Pprime)}`,
    );
  });

  void test("rd case: P retains a token that Q deletes", () => {
    // alice (P): [r5, insert["A\n"]] — retains all, appends
    // bob (Q): [r1, d1, r3] — deletes token "1\n"
    const P: DiffScript = [
      { type: "retain", count: 5 },
      { type: "insert", tokens: ["A\n"] },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 1 },
      { type: "retain", count: 3 },
    ];
    // Expected: "0\n2\n3\n4\nA\n"
    otIntegrationTest(base, P, Q, tok("0\n2\n3\n4\nA\n"));

    // P' = [retain(4), insert["A\n"]]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r4,i[A\n]", `P' was: ${scriptSummary(Pprime)}`);
  });

  void test("survive case: Q insert before P deletion survives", () => {
    // alice (P): [r1, d1, r3] — deletes "1\n" (token at index 1)
    // bob (Q): [r1, insert["B\n"], r4] — inserts "B\n" between "0\n" and "1\n"
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
    // Expected: "0\nB\n2\n3\n4\n" — B survives because Q-insert has priority
    otIntegrationTest(base, P, Q, tok("0\nB\n2\n3\n4\n"));

    // P' trace:
    // Q.r1(1), P.r1(1): row 3 → retain(1). Both done with first op.
    // Q.insert["B\n"]: row 1 (priority) → retain(1). Q done.
    // Q.r4(4), P.d1(1): row 4 → delete(1), consume 1. P done. Q has r3.
    // Q.r3(3), P.r3(3): row 3 → retain(3). Both done.
    // P' = [retain(1), retain(1), delete(1), retain(3)] = [retain(2), delete(1), retain(3)]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r2,d1,r3", `P' was: ${scriptSummary(Pprime)}`);
  });
});

// ---------------------------------------------------------------------------
// Q-insert priority
// ---------------------------------------------------------------------------

void describe("Q-insert priority", () => {
  void test("Q insert fires before P delete at same cursor position", () => {
    // P=[d1], Q=[insert["X\n"],retain(1)]
    // Base: ["a\n"]
    const P: DiffScript = [{ type: "delete", count: 1 }];
    const Q: DiffScript = [
      { type: "insert", tokens: ["X\n"] },
      { type: "retain", count: 1 },
    ];
    // P' should produce retain(1) for Q's insert, then nothing for the delete
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r1,d1", `P' was: ${scriptSummary(Pprime)}`);
    // Apply: Q's result = ["X\n","a\n"]; P'=[r1,d1] → ["X\n"]
    const base: Tokens = ["a\n"];
    otIntegrationTest(base, P, Q, ["X\n"]);
  });

  void test("multiple Q inserts are all retained", () => {
    // P=[d2], Q=[insert["A\n","B\n"], retain(2)]
    const P: DiffScript = [{ type: "delete", count: 2 }];
    const Q: DiffScript = [
      { type: "insert", tokens: ["A\n", "B\n"] },
      { type: "retain", count: 2 },
    ];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r2,d2", `P' was: ${scriptSummary(Pprime)}`);
    const base: Tokens = ["x\n", "y\n"];
    otIntegrationTest(base, P, Q, ["A\n", "B\n"]);
  });

  void test("Q insert between P retain ops uses row 1 correctly", () => {
    // P=[r2], Q=[r1, insert["M\n"], r1]
    // Base: ["a\n","b\n"]
    const P: DiffScript = [{ type: "retain", count: 2 }];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["M\n"] },
      { type: "retain", count: 1 },
    ];
    // P' = [retain(1), retain(1), retain(1)] = [retain(3)]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r3", `P' was: ${scriptSummary(Pprime)}`);
    const base: Tokens = ["a\n", "b\n"];
    otIntegrationTest(base, P, Q, ["a\n", "M\n", "b\n"]);
  });
});

// ---------------------------------------------------------------------------
// Three concurrent inserts at one cursor (PLAN.md §12)
// ---------------------------------------------------------------------------

void describe("three concurrent inserts at one cursor", () => {
  void test("Q inserts before P inserts in final output", () => {
    // Base: ["a\n"]
    // P inserts "X\n" before "a\n", Q inserts "Y\n" before "a\n"
    // P=[insert["X\n"],retain(1)], Q=[insert["Y\n"],retain(1)]
    // Q has priority, so final: Y\nX\na\n or Q first then P's insert
    const base: Tokens = ["a\n"];
    const P: DiffScript = [
      { type: "insert", tokens: ["X\n"] },
      { type: "retain", count: 1 },
    ];
    const Q: DiffScript = [
      { type: "insert", tokens: ["Y\n"] },
      { type: "retain", count: 1 },
    ];
    // P' trace: Q.insert["Y\n"] → row 1 → retain(1). Then P.insert["X\n"] → row 2 → insert["X\n"]. Then Q.r1,P.r1 → retain(1).
    // P' = [retain(1), insert["X\n"], retain(1)]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r1,i[X\n],r1", `P' was: ${scriptSummary(Pprime)}`);
    // After Q: ["Y\n","a\n"]. Apply P'=[r1,i["X\n"],r1] → ["Y\n","X\n","a\n"]
    otIntegrationTest(base, P, Q, ["Y\n", "X\n", "a\n"]);
  });
});

// ---------------------------------------------------------------------------
// Delete spanning a concurrent insert (PLAN.md §12)
// ---------------------------------------------------------------------------

void describe("delete spanning a concurrent insert", () => {
  void test("Q insert inside P's delete range survives", () => {
    // Base: ["a\n","b\n","c\n"]
    // P: delete all 3 → [d3]
    // Q: retain(1), insert["M\n"], retain(2)
    // The concurrent Q insert should survive (Q-insert priority means retain for it)
    const base: Tokens = ["a\n", "b\n", "c\n"];
    const P: DiffScript = [{ type: "delete", count: 3 }];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["M\n"] },
      { type: "retain", count: 2 },
    ];
    // P' trace:
    // Q.r1(1), P.d3(3): row 4 (P-delete Q-retain) → delete(1), consume min(1,3)=1. Q done. P has d2.
    // Q.insert["M\n"]: row 1 → retain(1). Q done.
    // Q.r2(2), P.d2(2): row 4 → delete(2). Both done.
    // P' = [delete(1), retain(1), delete(2)] = coalesced as-is (different types, no merge)
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "d1,r1,d2", `P' was: ${scriptSummary(Pprime)}`);
    // After Q: ["a\n","M\n","b\n","c\n"]. Apply P'=[d1,r1,d2] → ["M\n"]
    otIntegrationTest(base, P, Q, ["M\n"]);
  });
});

// ---------------------------------------------------------------------------
// Trailing insert on both sides (PLAN.md §12)
// ---------------------------------------------------------------------------

void describe("trailing insert on both sides", () => {
  void test("P trailing insert appears after Q trailing insert's retain", () => {
    // Base: ["a\n"]
    // P: retain(1), insert["P-end\n"]
    // Q: retain(1), insert["Q-end\n"]
    const base: Tokens = ["a\n"];
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["P-end\n"] },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["Q-end\n"] },
    ];
    // P' trace:
    // Q.r1, P.r1: row 3 → retain(1). Both done.
    // Q.insert["Q-end\n"]: row 1 → retain(1). Q done.
    // P.insert["P-end\n"]: row 2 → insert["P-end\n"]. P done.
    // P' = [retain(1), retain(1), insert["P-end\n"]] = [retain(2), insert["P-end\n"]]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r2,i[P-end\n]", `P' was: ${scriptSummary(Pprime)}`);
    // After Q: ["a\n","Q-end\n"]. Apply P'=[r2,i["P-end\n"]] → ["a\n","Q-end\n","P-end\n"]
    otIntegrationTest(base, P, Q, ["a\n", "Q-end\n", "P-end\n"]);
  });

  void test("Q-only trailing insert emits retain", () => {
    // Base: ["a\n"]
    // P: retain(1)
    // Q: retain(1), insert["Q\n"]
    const base: Tokens = ["a\n"];
    const P: DiffScript = [{ type: "retain", count: 1 }];
    const Q: DiffScript = [
      { type: "retain", count: 1 },
      { type: "insert", tokens: ["Q\n"] },
    ];
    const Pprime = transform(P, Q);
    // P' = [retain(1), retain(1)] = [retain(2)]
    assert.equal(scriptSummary(Pprime), "r2", `P' was: ${scriptSummary(Pprime)}`);
    otIntegrationTest(base, P, Q, ["a\n", "Q\n"]);
  });
});

// ---------------------------------------------------------------------------
// Identity and trivial cases
// ---------------------------------------------------------------------------

void describe("OT identity cases", () => {
  void test("transform(P, identity) = P for retain", () => {
    const P: DiffScript = [{ type: "retain", count: 3 }];
    const Q: DiffScript = [{ type: "retain", count: 3 }];
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r3");
  });

  void test("transform(P, Q) where both delete same token", () => {
    const P: DiffScript = [{ type: "delete", count: 1 }];
    const Q: DiffScript = [{ type: "delete", count: 1 }];
    const Pprime = transform(P, Q);
    // P-delete, Q-delete → nothing
    assert.equal(scriptSummary(Pprime), "");
    assert.deepEqual(Pprime, []);
  });

  void test("empty P and empty Q", () => {
    const Pprime = transform([], []);
    assert.deepEqual(Pprime, []);
  });

  void test("P empty, Q has insert", () => {
    // Base: [] (creating a file)
    // P=[insert["a\n"]], Q=[insert["b\n"]]
    const P: DiffScript = [{ type: "insert", tokens: ["a\n"] }];
    const Q: DiffScript = [{ type: "insert", tokens: ["b\n"] }];
    // Q.insert → row 1 → retain(1). Q done.
    // P.insert → row 2 → insert["a\n"].
    // P' = [retain(1), insert["a\n"]]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r1,i[a\n]");
  });
});

// ---------------------------------------------------------------------------
// Partial-overlap delete/delete with count splitting (PLAN.md §12)
// ---------------------------------------------------------------------------

void describe("partial-overlap delete/delete with count splitting", () => {
  void test("P deletes 3, Q deletes 2 (overlapping) with count splitting", () => {
    // Base: ["a\n","b\n","c\n","d\n","e\n"]
    // P: retain(1), delete(3), retain(1)  — deletes b,c,d
    // Q: retain(2), delete(2), retain(1)  — deletes c,d
    const base: Tokens = ["a\n", "b\n", "c\n", "d\n", "e\n"];
    const P: DiffScript = [
      { type: "retain", count: 1 },
      { type: "delete", count: 3 },
      { type: "retain", count: 1 },
    ];
    const Q: DiffScript = [
      { type: "retain", count: 2 },
      { type: "delete", count: 2 },
      { type: "retain", count: 1 },
    ];
    // After Q: ["a\n","b\n","e\n"]
    // P' trace:
    // Q.r2(2), P.r1(1): row 3 → retain(1), consume 1 each. Q has r1. P done.
    // Q.r1(1), P.d3(3): row 4 (P-delete Q-retain) → delete(1), consume 1. Q done (r2 done). P has d2.
    // Q.d2(2), P.d2(2): row 6 → nothing, consume 2. Both done.
    // Q.r1(1), P.r1(1): row 3 → retain(1). Both done.
    // P' = [retain(1), delete(1), retain(1)]
    const Pprime = transform(P, Q);
    assert.equal(scriptSummary(Pprime), "r1,d1,r1", `P' was: ${scriptSummary(Pprime)}`);
    // After Q: ["a\n","b\n","e\n"]. Apply P'=[r1,d1,r1] → ["a\n","e\n"]
    otIntegrationTest(base, P, Q, ["a\n", "e\n"]);
  });
});

// ---------------------------------------------------------------------------
// Differential oracle: transform result always produces correct merged content
// ---------------------------------------------------------------------------

void describe("OT differential oracle", () => {
  /**
   * For any base, P (alice's edit of base), Q (bob's edit of base):
   * applying transform(P, Q) to Q(base) should equal alice's intention merged with bob's
   * where Q-inserts have priority.
   */
  function verifyOTConvergence(
    base: Tokens,
    aliceText: string,
    bobText: string,
    expectedMergedText: string,
  ): void {
    const alice = tok(aliceText);
    const bob = tok(bobText);
    const expected = tok(expectedMergedText);
    const P = diffReference(base, alice);
    const Q = diffReference(base, bob);
    otIntegrationTest(base, P, Q, expected);
  }

  void test("both add lines at different positions", () => {
    // base=["a\n","b\n"], alice appends, bob prepends
    const base = tok("a\nb\n");
    verifyOTConvergence(base, "a\nb\nA\n", "Z\na\nb\n", "Z\na\nb\nA\n");
  });

  void test("both delete different lines", () => {
    const base = tok("a\nb\nc\n");
    verifyOTConvergence(base, "b\nc\n", "a\nc\n", "c\n");
  });

  void test("one adds, one deletes non-overlapping", () => {
    const base = tok("a\nb\nc\n");
    verifyOTConvergence(base, "a\nb\nc\nNEW\n", "b\nc\n", "b\nc\nNEW\n");
  });
});
