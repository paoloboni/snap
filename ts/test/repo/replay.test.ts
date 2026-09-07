/**
 * Tests for repo/replay.ts
 * SPEC.md §6.1–6.4: replay, OT, conflict rules, namespace rule
 *
 * Each test constructs Repository objects directly and calls replay() or
 * joinRepositories() to verify behavior.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { replay, joinRepositories } from "../../src/repo/replay.js";
import type { Repository, Patch } from "../../src/repo/model.js";
import type { SnapResult } from "../../src/errors.js";
import { assertOk, assertErr } from "../helpers/result.js";
import { emptyTree, treeFromEntries } from "../../src/core/tree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(frontier: [string, number][], patches: Patch[]): Repository {
  return {
    format: 1,
    frontier: new Map(frontier),
    patches,
  };
}

function makePatch(
  author: string,
  revision: number,
  base: [string, number][],
  message: string,
  changes: Patch["changes"],
): Patch {
  return {
    author,
    revision,
    base: new Map(base),
    message,
    changes,
  };
}

function textBuf(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

function b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

function throwsSnapError<T>(result: SnapResult<T>, substring?: string): void {
  const error = assertErr(result);
  if (substring !== undefined) {
    assert.ok(
      error.message.includes(substring),
      `expected error message to contain "${substring}", got "${error.message}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Empty repository
// ---------------------------------------------------------------------------

void describe("replay — empty repository", () => {
  void test("empty repo produces empty tree and no warnings", () => {
    const repo = makeRepo([], []);
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(tree.paths(), []);
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Basic single-patch replay
// ---------------------------------------------------------------------------

void describe("replay — single patch", () => {
  void test("text create", () => {
    const p = makePatch("alice@x", 1, [], "add file", [
      { type: "text", path: "hello.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
    ]);
    const repo = makeRepo([["alice@x", 1]], [p]);
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, []);
    assert.equal(tree.get("hello.txt")?.toString("utf8"), "hello\n");
  });

  void test("put create", () => {
    const content = b64("\x00\x01\x02");
    const p = makePatch("alice@x", 1, [], "add binary", [
      { type: "put", path: "data.bin", content },
    ]);
    const repo = makeRepo([["alice@x", 1]], [p]);
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, []);
    const got = tree.get("data.bin");
    assert.ok(got !== undefined);
    assert.deepEqual(got, Buffer.from("\x00\x01\x02"));
  });

  void test("delete creates absent path", () => {
    const p1 = makePatch("alice@x", 1, [], "create", [
      { type: "put", path: "f.txt", content: b64("hello") },
    ]);
    const p2 = makePatch("alice@x", 2, [["alice@x", 1]], "delete", [
      { type: "delete", path: "f.txt" },
    ]);
    const repo = makeRepo([["alice@x", 2]], [p1, p2]);
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, []);
    assert.equal(tree.has("f.txt"), false);
  });
});

// ---------------------------------------------------------------------------
// Test 10 scenario: concurrent puts/deletes with winner rules
// SPEC §6.4 rules: delete-wins, later-put-wins, put-wins, identical no-op
// ---------------------------------------------------------------------------

void describe("replay — test 10 conflict rules (delete-wins, later-put-wins, put-wins)", () => {
  /**
   * Scenario:
   *   seed: creates delete.txt, incompatible.txt, later-put.txt, identical.txt
   *   alice (concurrent with bob): edits delete.txt (text), makes incompatible.txt text, later-put.txt binary, identical.txt "same"
   *   bob (concurrent with alice): deletes delete.txt, makes incompatible.txt binary, later-put.txt text "right text\n", identical.txt "same"
   *
   * Integration order: seed → bob → alice (bob's result [bob@x->1,seed@x->1] < alice's [alice@x->1,seed@x->1])
   * Wait — alice@x < bob@x in UTF-8, so alice's result [alice@x->1,seed@x->1] < bob's [bob@x->1,seed@x->1]
   * So order is: seed → alice → bob
   *
   * After seed:
   *   delete.txt = "base\n", incompatible.txt = "base\n", later-put.txt = "base\n", identical.txt = "base\n"
   *
   * Apply alice (B=seed tree, C=seed tree since B==C):
   *   delete.txt → text edit "left\n"
   *   incompatible.txt → text edit "left text\n"  
   *   later-put.txt → put binary AAE=
   *   identical.txt → text edit "same\n"
   *
   * C after alice:
   *   delete.txt = "left\n", incompatible.txt = "left text\n", later-put.txt = [0x00, 0x01], identical.txt = "same\n"
   *
   * Apply bob (B=seed tree, C=alice tree):
   *   delete.txt: B="base\n" (text), C="left\n" (text), T=undefined (delete)
   *     → Rule 3: T absent → delete-wins (incoming bob's delete wins), warning: delete-wins
   *   incompatible.txt: B="base\n" (text), C="left text\n" (text), T=0xFF (binary, put)
   *     → change.type = "put", so rule 6 (SPEC §6.4 rule 5): later-put-wins, warning: later-put-wins
   *     Wait: C="left text\n" is text, T=binary. change.type="put"
   *     → The OT check: B, C, T are text AND change.type is text → OT path... no, T is binary
   *     Actually, incompatible test: bob puts binary AP8=, alice puts text "left text\n"
   *     After alice, C has "left text\n" (text). Bob's B is seed "base\n", T = AP8= (binary)
   *     change.type = "put" → rule 5 of §6.4: incoming put wins → later-put-wins
   *     But wait, test 10 expects put-wins (C wins, not incoming). Let me re-read.
   *
   * Test 10 result:
   *   incompatible.txt = AP8= (bob's binary wins) with warning put-wins
   *   later-put.txt = AAE= (alice's binary) with warning later-put-wins
   *
   * The warnings say:
   *   "warning: auto-resolved delete.txt: delete-wins"
   *   "warning: auto-resolved incompatible.txt: put-wins"  <- put-wins means C (current non-text) wins
   *   "warning: auto-resolved later-put.txt: later-put-wins"  <- incoming put wins
   *
   * So for incompatible.txt: alice already put binary (incompatible.txt = "left\n" from alice)
   * Wait, let me re-read test 10:
   *   left/incompatible.txt = "left text\n" (text)
   *   right/incompatible.txt = AP8= (binary, put by bob)
   *
   * When alice is integrated first (B=seed, C=seed, B==C):
   *   alice's incompatible.txt is "left text\n" — text edit → apply directly
   *
   * When bob is integrated second (B=seed, C=after-alice):
   *   bob's change: put, incompatible.txt → AP8= binary
   *   B = "base\n" (seed), C = "left text\n" (alice's text), T = binary
   *   Not B==C. Not C==T.
   *   OT check: B text, C text, T NOT text (binary) → not OT path
   *   Rules:
   *   - T !== undefined (it's binary)
   *   - B present, C present → not rule 4 (B present C absent)
   *   - B present → not rule 5 (B absent)
   *   - change.type = "put" → rule 6 (§6.4 rule 5): later-put-wins, install T
   *
   * But test 10 shows warning "put-wins" for incompatible.txt and the result is AP8= (bob's binary)
   *
   * Let me re-read SPEC §6.4 rules very carefully:
   * 1. C == T → keep, no warning
   * 2. T absent → delete-wins
   * 3. B present, C absent → delete-wins (concurrent delete wins)
   * 4. B absent, C and T present → later-create-wins (incoming wins)
   * 5. incoming change is put → later-put-wins (incoming atomic replacement wins)
   * 6. P is text, C is non-text → put-wins (C wins)
   *
   * For incompatible.txt: B="base\n", C="left text\n", T=binary (bob's put AP8=)
   * Rule 5: incoming is put → later-put-wins. Install T (bob's binary). Emit later-put-wins.
   *
   * But the test expects "put-wins" for incompatible.txt with result AP8=!
   * And "later-put-wins" for later-put.txt with result AAE=.
   *
   * Let me re-examine:
   * For later-put.txt: alice puts binary AAE=, bob puts text "right text\n"
   * Integration order: seed → alice → bob (alice@x < bob@x)
   * After alice: later-put.txt = binary AAE=
   * Bob applies: B="base\n" (text), C=AAE= (binary), T="right text\n" (text)
   * change.type = "text"? No — bob commits "right text\n" as text. Type="text".
   * Rules: B text, C binary, T text
   * Not B==C (base is text, current is binary)
   * Not C==T
   * OT: B text, C NOT text → not OT
   * Rule 2: T not absent
   * Rule 3: B present, C present
   * Rule 4: B absent? No, B present
   * Rule 5: change is put? No, change is text → skip
   * Rule 6: P is text (change.type=text), C is non-text → put-wins (C wins)
   *   → warning "put-wins", C stays (binary AAE=)
   *
   * But test expects later-put.txt = AAE= with warning "later-put-wins"!
   *
   * Hmm. Let me re-examine the order. Maybe bob integrates BEFORE alice?
   * alice@x vs bob@x: 'a' < 'b' in UTF-8. For snap order we compare result vectors.
   * alice's result: {alice@x: 1, seed@x: 1}
   * bob's result: {bob@x: 1, seed@x: 1}
   * Snap order: sorted union [alice@x, bob@x, seed@x]
   * alice's result at alice@x = 1, bob's result at alice@x = 0 → alice WINS (1 > 0)
   * So alice's result is LARGER in snap order → bob integrates FIRST!
   *
   * Wait: snapOrder(a, b) returns -1 if a < b. We pick the LEAST patch.
   * alice's result vector at first key alice@x = 1, bob's result vector at alice@x = 0
   * So alice's result is LARGER (1 > 0). So bob is "less" and integrates FIRST.
   *
   * Integration order: seed → bob → alice
   *
   * After seed: delete.txt="base\n", incompatible.txt="base\n", later-put.txt="base\n", identical.txt="base\n"
   *
   * Apply bob (B=seed, C=seed, B==C for all paths):
   *   delete.txt: bob deleted → resultTree.delete("delete.txt")  
   *   incompatible.txt: bob put AP8= → resultTree.set binary
   *   later-put.txt: bob put text "right text\n" → resultTree.set text
   *   identical.txt: bob put text "same\n" → resultTree.set
   *
   * After bob: delete.txt absent, incompatible.txt=AP8=, later-put.txt="right text\n", identical.txt="same\n"
   *
   * Apply alice (B=seed, C=after-bob):
   *   delete.txt: B="base\n", C=absent, T="left\n" (alice's text edit)
   *     → B present, C absent → Rule 4 (§6.4 rule 3): delete-wins (concurrent delete wins, C stays absent)
   *     → warning: delete-wins
   *   incompatible.txt: B="base\n" text, C=AP8= binary, T="left text\n" text
   *     → change.type = "text" (alice changed to text)
   *     → B text, C NOT text → not OT
   *     → T not absent, B present C present (not rules 3,4 in SPEC terms)
   *     → change is NOT put (it's text)
   *     → Rule 6: P is text and C is non-text → put-wins (C wins, AP8= stays)
   *     → warning: put-wins ✓
   *   later-put.txt: B="base\n" text, C="right text\n" text, T=AAE= binary (alice's put)
   *     → change.type = "put"
   *     → B != C (both text but different content)
   *     → C != T (C is text, T is binary)
   *     → OT: B text, C text, T NOT text → not OT
   *     → T not absent
   *     → B present, C present → not rule 4
   *     → B present → not rule 5
   *     → change is put → Rule 6 (§6.4 rule 5): later-put-wins → install T (AAE=)
   *     → warning: later-put-wins ✓
   *   identical.txt: B="base\n", C="same\n", T="same\n"
   *     → C == T → keep unchanged, no warning ✓
   */

  void test("delete-wins: bob deletes, alice edits same path", () => {
    // seed creates the file
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "delete.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    // bob deletes it (integrates first because snapOrder(bob's result) < snapOrder(alice's result))
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      { type: "delete", path: "delete.txt" },
    ]);
    // alice edits it concurrently
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "delete.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["left\n"] },
        ],
      },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // delete.txt should be absent (bob's delete wins)
    assert.equal(tree.has("delete.txt"), false);
    assert.ok(
      warnings.some((w) => w.path === "delete.txt" && w.reason === "delete-wins"),
      "expected delete-wins warning for delete.txt",
    );
  });

  void test("put-wins: alice puts text, C (bob's binary) wins", () => {
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "incompatible.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    // bob puts binary (integrates first)
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "put",
        path: "incompatible.txt",
        content: Buffer.from([0x00, 0xff]).toString("base64"),
      },
    ]);
    // alice puts text (integrates second)
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "incompatible.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["left text\n"] },
        ],
      },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // incompatible.txt should have bob's binary (C wins = put-wins)
    const got = tree.get("incompatible.txt");
    assert.ok(got !== undefined);
    assert.deepEqual(got, Buffer.from([0x00, 0xff]));
    assert.ok(
      warnings.some((w) => w.path === "incompatible.txt" && w.reason === "put-wins"),
      "expected put-wins warning for incompatible.txt",
    );
  });

  void test("later-put-wins: alice puts binary AAE=, bob puts text", () => {
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "later-put.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    // bob puts text "right text\n" (integrates first)
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "text",
        path: "later-put.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["right text\n"] },
        ],
      },
    ]);
    // alice puts binary AAE= (integrates second)
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "put",
        path: "later-put.txt",
        content: Buffer.from([0x00, 0x01]).toString("base64"),
      },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // later-put.txt should have alice's binary AAE= (incoming put wins = later-put-wins)
    const got = tree.get("later-put.txt");
    assert.ok(got !== undefined);
    assert.deepEqual(got, Buffer.from([0x00, 0x01]));
    assert.ok(
      warnings.some((w) => w.path === "later-put.txt" && w.reason === "later-put-wins"),
      "expected later-put-wins warning for later-put.txt",
    );
  });

  void test("identical concurrent change: no warning", () => {
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "identical.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "text",
        path: "identical.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["same\n"] },
        ],
      },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "identical.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["same\n"] },
        ],
      },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );
    const { tree, warnings } = assertOk(replay(repo));
    const got = tree.get("identical.txt");
    assert.ok(got !== undefined);
    assert.equal(got.toString("utf8"), "same\n");
    // No warning for identical change
    assert.equal(
      warnings.filter((w) => w.path === "identical.txt").length,
      0,
      "expected no warning for identical.txt",
    );
  });

  void test("warnings are sorted by path then reason", () => {
    // Build a scenario with multiple conflicts to verify sort order
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "a.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
      { type: "text", path: "b.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    // bob deletes both (integrates first due to snapOrder)
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      { type: "delete", path: "a.txt" },
      { type: "delete", path: "b.txt" },
    ]);
    // alice edits both concurrently
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "a.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited\n"] },
        ],
      },
      {
        type: "text",
        path: "b.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited\n"] },
        ],
      },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );
    const { warnings } = assertOk(replay(repo));
    // Warnings should be sorted by path
    const paths = warnings.map((w) => w.path);
    const sortedPaths = [...paths].sort();
    assert.deepEqual(paths, sortedPaths, "warnings should be sorted by path");
  });
});

// ---------------------------------------------------------------------------
// Test 11 scenario: namespace conflicts
// SPEC §6.2 namespace-wins rule
// ---------------------------------------------------------------------------

void describe("replay — test 11 namespace conflicts", () => {
  void test("test 11 scenario A: alice@x creates 'a', bob@x creates 'a/b'", () => {
    // bob integrates first (bob@x > alice@x), after bob: C has a/b
    // alice integrates: S = {a}, descendant a/b in C → namespace conflict, alice's a wins, removes a/b
    const alice = makePatch("alice@x", 1, [], "ancestor", [
      { type: "text", path: "a", edit: [{ type: "insert", tokens: ["ancestor\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [], "descendant", [
      { type: "text", path: "a/b", edit: [{ type: "insert", tokens: ["descendant\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    assert.equal(tree.get("a")?.toString("utf8"), "ancestor\n");
    assert.equal(tree.has("a/b"), false);
    assert.ok(warnings.some((w) => w.path === "a/b" && w.reason === "namespace-wins"));
  });

  void test("test 11 scenario B: bob@x creates 'x', alice@x creates 'x/y'", () => {
    // bob integrates first (alice@x result > bob@x result in snapOrder)
    // After bob: C has x = "ancestor\n"
    // alice integrates: S = {x/y}, ancestor "x" exists in C → namespace conflict
    // alice's x/y wins, removes x
    // Warning: namespace-wins for x (the removed current path)
    const bob = makePatch("bob@x", 1, [], "ancestor", [
      { type: "text", path: "x", edit: [{ type: "insert", tokens: ["ancestor\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "descendant", [
      { type: "text", path: "x/y", edit: [{ type: "insert", tokens: ["descendant\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // alice is LATER → alice's x/y wins, bob's x is removed
    assert.equal(tree.has("x"), false, "bob's 'x' should be removed by namespace-wins");
    assert.equal(tree.get("x/y")?.toString("utf8"), "descendant\n");
    assert.ok(warnings.some((w) => w.path === "x" && w.reason === "namespace-wins"));
  });
});

// ---------------------------------------------------------------------------

void describe("replay — test 18 three-way convergence", () => {
  void test("three concurrent text edits converge to B\\nA\\nend\\n", () => {
    /**
     * seed: "start\nend\n"
     * a@x: "start\nA\nend\n" (insert "A\n" after "start\n")
     * b@x: "start\nB\nend\n" (insert "B\n" after "start\n")
     * c@x: "end\n" (delete "start\n")
     *
     * Snap order:
     * a's result: {a@x:1, seed@x:1}
     * b's result: {b@x:1, seed@x:1}
     * c's result: {c@x:1, seed@x:1}
     * snapOrder: sorted IDs = [a@x, b@x, c@x, seed@x]
     * At a@x: a=1, b=0, c=0 → a's result has a@x=1, others 0
     * Order: seed→c→b→a (from PLAN.md §6.1 derivation table)
     *
     * After seed: ["start\n", "end\n"]
     *
     * Apply c (B=seed, C=seed, B==C): delete "start\n" → C = ["end\n"]
     *
     * Apply b (B=seed, C=["end\n"]):
     *   b's edit: [retain 1, insert ["B\n"], retain 1] → inserts "B\n" after "start\n"
     *   B="start\nend\n", C="end\n"
     *   Q = diff(B_tokens, C_tokens) = diff(["start\n","end\n"], ["end\n"]) = [delete 1, retain 1]
     *   P = b's edit = [retain 1, insert ["B\n"], retain 1]
     *   transform(P, Q):
     *   Q has [delete 1, retain 1], P has [retain 1, insert ["B\n"], retain 1]
     *   - Q op: delete 1 (not insert), P op: retain 1
     *     Row 5: P retain, Q delete → nothing, consume 1 from each
     *   - Q op: retain 1, P op: insert ["B\n"]
     *     Row 2: P insert → output insert["B\n"], advance P only
     *   - Q op: retain 1, P op: retain 1
     *     Row 3: P retain, Q retain → retain 1, consume 1 from each
     *   P' = [insert ["B\n"], retain 1]
     *   Apply to C=["end\n"]: ["B\n", "end\n"]
     *
     * Apply a (B=seed, C=["B\n","end\n"]):
     *   a's edit: [retain 1, insert ["A\n"], retain 1] → inserts "A\n" after "start\n"
     *   Q = diff(["start\n","end\n"], ["B\n","end\n"]) = [delete 1, insert ["B\n"], retain 1]
     *   P = [retain 1, insert ["A\n"], retain 1]
     *   transform(P, Q):
     *   - Q op: delete 1 (not insert), P op: retain 1
     *     Row 5: P retain, Q delete → nothing, consume 1 from each
     *   - Q op: insert ["B\n"]
     *     Row 1: Q insert → retain 1, advance Q only
     *   - P op: insert ["A\n"]
     *     Row 2: P insert → insert ["A\n"], advance P only
     *   - Q exhausted, P op: retain 1
     *     Row... both just retain 1
     *     Actually Q is done, P has retain 1 left.
     *     Since Q and P both consume the same base tokens, and Q consumed 1 base
     *     token (the delete 1), P consumed 1 base token (the retain 1 in first step).
     *     After the transforms:
     *     - step 1: P retain 1, Q delete 1 → nothing, both consumed 1 base token
     *     - step 2: Q insert ["B\n"] → retain 1, Q advance
     *     - step 3: P insert ["A\n"] → insert ["A\n"], P advance
     *     - step 4: P retain 1 left, Q exhausted → row 3 with n=1?
     *       Actually after step 1, P and Q have consumed 1 base token each.
     *       Remaining P: [insert ["A\n"], retain 1]
     *       Remaining Q: [insert ["B\n"], retain 1]  (the insert doesn't consume base)
     *       Wait I need to re-trace more carefully...
     *
     * From PLAN.md §6.1 derivation: result is "B\nA\nend\n"
     */

    // seed: "start\nend\n"
    const seed = makePatch("seed@x", 1, [], "seed", [
      {
        type: "text",
        path: "story.txt",
        edit: [{ type: "insert", tokens: ["start\n", "end\n"] }],
      },
    ]);

    // a: insert "A\n" after "start\n" → "start\nA\nend\n"
    const a = makePatch("a@x", 1, [["seed@x", 1]], "a", [
      {
        type: "text",
        path: "story.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["A\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);

    // b: insert "B\n" after "start\n" → "start\nB\nend\n"
    const b = makePatch("b@x", 1, [["seed@x", 1]], "b", [
      {
        type: "text",
        path: "story.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["B\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);

    // c: delete "start\n" → "end\n"
    const c = makePatch("c@x", 1, [["seed@x", 1]], "c", [
      {
        type: "text",
        path: "story.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "retain", count: 1 },
        ],
      },
    ]);

    const repo = makeRepo(
      [
        ["a@x", 1],
        ["b@x", 1],
        ["c@x", 1],
        ["seed@x", 1],
      ],
      [a, b, c, seed],
    );

    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, []);
    const got = tree.get("story.txt");
    assert.ok(got !== undefined, "story.txt should exist");
    assert.equal(got.toString("utf8"), "B\nA\nend\n", "three-way OT should produce B\\nA\\nend\\n");
  });
});

// ---------------------------------------------------------------------------
// Test 09 scenario: OT text merge
// alice inserts "left\n" after "base\n", bob inserts "right\n" after "base\n"
// ---------------------------------------------------------------------------

void describe("replay — test 09 OT text merge", () => {
  void test("concurrent inserts at same position converge", () => {
    /**
     * seed: "base\n"
     * alice@x: "base\nleft\n" (insert "left\n" at end)
     * bob@x: "base\nright\n" (insert "right\n" at end)
     *
     * Integration order: seed → bob → alice (bob@x > alice@x in snapOrder comparison)
     * Actually: snapOrder(alice_result, bob_result):
     *   alice_result = {alice@x:1, seed@x:1}
     *   bob_result = {bob@x:1, seed@x:1}
     *   sorted IDs: [alice@x, bob@x, seed@x]
     *   alice@x: alice=1, bob=0 → alice's result wins (1 > 0) → alice is LATER
     *   So bob integrates first.
     *
     * After seed: C=["base\n"]
     * Apply bob (B=["base\n"], C=["base\n"], B==C): insert "right\n" → C=["base\n","right\n"]
     * Apply alice (B=["base\n"], C=["base\n","right\n"]):
     *   alice's edit: [retain 1, insert ["left\n"]]
     *   Q = diff(["base\n"], ["base\n","right\n"]) = [retain 1, insert ["right\n"]]
     *   transform(P=[retain 1, insert ["left\n"]], Q=[retain 1, insert ["right\n"]]):
     *     - Q op: retain 1, P op: retain 1 → retain 1, consume 1 from each
     *     - Q op: insert ["right\n"] → retain 1, Q advance
     *     - P op: insert ["left\n"] → insert ["left\n"], P advance
     *   P' = [retain 1, retain 1, insert ["left\n"]] = [retain 2, insert ["left\n"]]
     *   Apply to ["base\n","right\n"]: ["base\n","right\n","left\n"]
     *
     * Final: "base\nright\nleft\n" ✓ (matches test 09)
     */

    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "notes.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "notes.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["left\n"] },
        ],
      },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "text",
        path: "notes.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["right\n"] },
        ],
      },
    ]);

    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, seed],
    );

    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, []);
    const got = tree.get("notes.txt");
    assert.ok(got !== undefined);
    assert.equal(got.toString("utf8"), "base\nright\nleft\n");
  });
});

// ---------------------------------------------------------------------------
// Permutation convergence property test
// ---------------------------------------------------------------------------

void describe("replay — permutation convergence", () => {
  void test("same patches in different orders produce the same tree", () => {
    /**
     * Three concurrent patches applied to the same base.
     * Regardless of how we permute the patches in the repo's patches array,
     * the replay should produce the same result (replay uses snap-ordered heap,
     * not the array order).
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      {
        type: "text",
        path: "file.txt",
        edit: [{ type: "insert", tokens: ["line1\n", "line2\n"] }],
      },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["alice\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 2 },
          { type: "insert", tokens: ["bob\n"] },
        ],
      },
    ]);
    const frontier: [string, number][] = [
      ["alice@x", 1],
      ["bob@x", 1],
      ["seed@x", 1],
    ];

    // All 6 permutations of [seed, alice, bob]
    const permutations: Patch[][] = [
      [seed, alice, bob],
      [seed, bob, alice],
      [alice, seed, bob],
      [alice, bob, seed],
      [bob, seed, alice],
      [bob, alice, seed],
    ];

    const results: string[] = [];
    for (const patchOrder of permutations) {
      const repo = makeRepo(frontier, patchOrder);
      const { tree } = assertOk(replay(repo));
      const content = tree.get("file.txt")?.toString("utf8") ?? "";
      results.push(content);
    }

    // All permutations should produce the same result
    const first = results[0]!;
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i], first, `permutation ${i} diverged: ${results[i]} vs ${first}`);
    }
  });

  void test("joinRepositories is commutative: A merge B == B merge A", () => {
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["alice\n"] },
        ],
      },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["bob\n"] },
        ],
      },
    ]);

    const repoA = makeRepo(
      [
        ["alice@x", 1],
        ["seed@x", 1],
      ],
      [alice, seed],
    );
    const repoB = makeRepo(
      [
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      [bob, seed],
    );

    const { repo: merged1 } = assertOk(joinRepositories(repoA, repoB));
    const { repo: merged2 } = assertOk(joinRepositories(repoB, repoA));

    const { tree: tree1 } = assertOk(replay(merged1));
    const { tree: tree2 } = assertOk(replay(merged2));

    const content1 = tree1.get("file.txt")?.toString("utf8");
    const content2 = tree2.get("file.txt")?.toString("utf8");

    assert.equal(content1, content2, "A merge B should equal B merge A");
  });

  void test("joinRepositories is idempotent: A merge A == A", () => {
    const alice = makePatch("alice@x", 1, [], "alice", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
    ]);
    const repo = makeRepo([["alice@x", 1]], [alice]);

    const { repo: merged } = assertOk(joinRepositories(repo, repo));
    const { tree: tree1 } = assertOk(replay(repo));
    const { tree: tree2 } = assertOk(replay(merged));

    assert.equal(tree1.get("file.txt")?.toString("utf8"), tree2.get("file.txt")?.toString("utf8"));
    // Frontier should be the same
    assert.equal(merged.frontier.get("alice@x"), 1);
    // Same number of patches
    assert.equal(merged.patches.length, repo.patches.length);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

void describe("replay — error cases", () => {
  void test("cyclic or incomplete patch history", () => {
    // Create a patch that references a base version that doesn't exist
    const p = makePatch("alice@x", 2, [["alice@x", 1]], "second", [
      { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["x\n"] }] },
    ]);
    // Only include the second patch, not the first — incomplete history
    const repo = makeRepo([["alice@x", 2]], [p]);
    throwsSnapError(replay(repo), "cyclic or incomplete patch history");
  });

  void test("unreachable patch (not in causal closure of frontier)", () => {
    // Create a patch with revision > frontier
    const p1 = makePatch("alice@x", 1, [], "first", [
      { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["x\n"] }] },
    ]);
    const p2 = makePatch("alice@x", 2, [["alice@x", 1]], "second", [
      { type: "put", path: "f.txt", content: b64("y") },
    ]);
    // Frontier says alice@x is only at revision 1, but repo has revision 2
    const repo = makeRepo([["alice@x", 1]], [p1, p2]);
    throwsSnapError(replay(repo), "unreachable patch");
  });

  void test("patch collision: same dot with different values", () => {
    const p1 = makePatch("alice@x", 1, [], "original", [
      { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
    ]);
    const p1different = makePatch("alice@x", 1, [], "different", [
      { type: "put", path: "f.txt", content: b64("world") },
    ]);

    const repoA = makeRepo([["alice@x", 1]], [p1]);
    const repoB = makeRepo([["alice@x", 1]], [p1different]);

    throwsSnapError(joinRepositories(repoA, repoB), "patch collision");
  });

  void test("delete of absent path", () => {
    // A patch that deletes a path not in its base tree
    const p = makePatch("alice@x", 1, [], "bad delete", [
      { type: "delete", path: "nonexistent.txt" },
    ]);
    const repo = makeRepo([["alice@x", 1]], [p]);
    throwsSnapError(replay(repo), "delete of absent path");
  });
});

// ---------------------------------------------------------------------------
// later-create-wins
// ---------------------------------------------------------------------------

void describe("replay — later-create-wins", () => {
  void test("concurrent creates: later patch wins", () => {
    /**
     * alice@x and bob@x each create same.txt from scratch.
     * Integration order: bob first (alice@x < bob@x in snapOrder, so alice is LATER)
     * After bob: same.txt = "bob\n"
     * Apply alice (B=empty, C="bob\n", T="alice\n"):
     *   B absent, C present, T present → later-create-wins (incoming alice wins)
     *   → same.txt = "alice\n", warning: later-create-wins
     */
    const alice = makePatch("alice@x", 1, [], "alice creates same.txt", [
      { type: "text", path: "same.txt", edit: [{ type: "insert", tokens: ["alice\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [], "bob creates same.txt", [
      { type: "text", path: "same.txt", edit: [{ type: "insert", tokens: ["bob\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // alice integrates second (later), so alice's value wins
    const got = tree.get("same.txt")?.toString("utf8");
    assert.equal(got, "alice\n", "later create (alice) should win");
    assert.ok(
      warnings.some((w) => w.path === "same.txt" && w.reason === "later-create-wins"),
      `expected later-create-wins warning, got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// joinRepositories: warnings deduplication
// ---------------------------------------------------------------------------

void describe("joinRepositories — warning semantics", () => {
  void test("joinRepositories returns all replay warnings (not just new ones)", () => {
    /**
     * The merge command is responsible for filtering to only new warnings.
     * joinRepositories returns all warnings from replaying the merged repository.
     * This mirrors SPEC §6.4: "Replay returns the set of unique warning pairs."
     * The merge command then computes the delta with pre-merge local replay.
     */
    const alice = makePatch("alice@x", 1, [], "alice", [
      { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [], "bob", [
      { type: "put", path: "f.txt", content: b64("world") },
    ]);

    const repoA = makeRepo([["alice@x", 1]], [alice]);
    const repoB = makeRepo([["bob@x", 1]], [bob]);

    // First merge: alice + bob creates a later-create-wins conflict
    const { repo: merged1, warnings: w1 } = assertOk(joinRepositories(repoA, repoB));
    assert.equal(w1.length, 1, "first merge should have 1 warning");
    assert.equal(w1[0]?.reason, "later-create-wins");

    // Second merge with same remote: warnings still present in replay
    const { warnings: w2 } = assertOk(joinRepositories(merged1, repoB));
    // merged1 already contains all of repoB's patches, so replay produces same warnings
    assert.equal(w2.length, 1, "re-merging same history produces same replay warnings");
  });

  void test("idempotent merge: frontier and patches unchanged", () => {
    const alice = makePatch("alice@x", 1, [], "alice", [
      { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
    ]);
    const repo = makeRepo([["alice@x", 1]], [alice]);

    const { repo: merged } = assertOk(joinRepositories(repo, repo));
    assert.equal(merged.frontier.get("alice@x"), 1);
    assert.equal(merged.patches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// RA-001 regression: materializeBaseTree with concurrent patches in base
// ---------------------------------------------------------------------------

void describe("replay — RA-001: concurrent patches in base use proper OT", () => {
  /**
   * Bug: materializeBaseTree called applyPatchToTree(p, tree, tree), passing the
   * same accumulating tree as both C and B. Rule 1 (B==C → apply directly) then
   * fired unconditionally, bypassing OT. When the base contained concurrent patches
   * that both edited the same file, the naive sequential apply produced a tree with
   * the wrong number of tokens, causing subsequent edits (like Charlie's) to crash
   * or produce wrong output.
   *
   * Fix: materializeBaseTree now calls replayPatches() — the same heap-based OT
   * kernel used by replay() — restricted to the patches whose resultVec ≤ baseVec.
   */

  void test("RA-001: charlie's base tree after concurrent inserts at same position is OT-merged", () => {
    /**
     * seed: file.txt = "A\nB\nC\n"  (3 tokens)
     *
     * alice (base=seed): inserts "X\n" after "A\n"
     *   edit: [retain 1, insert ["X\n"], retain 2]
     *   authored result: "A\nX\nB\nC\n"
     *
     * bob (base=seed): inserts "Y\n" after "A\n"
     *   edit: [retain 1, insert ["Y\n"], retain 2]
     *   authored result: "A\nY\nB\nC\n"
     *
     * Integration order for alice+bob:
     *   snapOrder: alice result = {alice@x:1,seed@x:1}, bob result = {bob@x:1,seed@x:1}
     *   Sorted IDs: [alice@x, bob@x, seed@x]. At alice@x: alice=1, bob=0 → alice is LARGER.
     *   So bob integrates first → seed → bob → alice.
     *
     * After seed+bob: "A\nY\nB\nC\n"
     * Apply alice (B=seed="A\nB\nC\n", C="A\nY\nB\nC\n"):
     *   Q = diff(["A\n","B\n","C\n"], ["A\n","Y\n","B\n","C\n"])
     *     = [retain 1, insert ["Y\n"], retain 2]
     *   P = [retain 1, insert ["X\n"], retain 2]
     *   transform(P, Q): Q-insert at same position → Q's Y is placed before P's X
     *     → P' = [retain 2, insert ["X\n"], retain 2]
     *   Apply to ["A\n","Y\n","B\n","C\n"]: "A\nY\nX\nB\nC\n"
     *
     * charlie (base = {alice@x:1, bob@x:1, seed@x:1}):
     *   charlie's correct base tree = "A\nY\nX\nB\nC\n" (OT-merged alice+bob result)
     *
     * BUG (before fix): materializeBaseTree applied alice's 3-token edit naively to the
     *   4-token accumulated tree "A\nY\nB\nC\n", failing with "does not consume old content"
     *   OR producing a wrong base tree.
     *
     * CORRECT (after fix): charlie's base tree = "A\nY\nX\nB\nC\n"
     *   Charlie appends "Z\n" → result = "A\nY\nX\nB\nC\nZ\n"
     */

    const seed = makePatch("seed@x", 1, [], "seed", [
      {
        type: "text",
        path: "file.txt",
        edit: [{ type: "insert", tokens: ["A\n", "B\n", "C\n"] }],
      },
    ]);

    // alice inserts "X\n" after "A\n" (at position 1 in the seed tree)
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice inserts X", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["X\n"] },
          { type: "retain", count: 2 },
        ],
      },
    ]);

    // bob inserts "Y\n" after "A\n" (same position, concurrent with alice)
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob inserts Y", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["Y\n"] },
          { type: "retain", count: 2 },
        ],
      },
    ]);

    // charlie has both alice and bob in base — triggers materializeBaseTree with concurrent patches
    const charlie = makePatch(
      "charlie@x",
      1,
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      "charlie appends Z",
      [
        {
          type: "text",
          path: "file.txt",
          // charlie appends "Z\n" after all 5 tokens in the merged base "A\nY\nX\nB\nC\n"
          edit: [
            { type: "retain", count: 5 },
            { type: "insert", tokens: ["Z\n"] },
          ],
        },
      ],
    );

    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["charlie@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, charlie, seed],
    );

    // With the fix: should NOT throw, and result should be "A\nY\nX\nB\nC\nZ\n"
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, [], "no warnings expected for clean OT scenario");
    const got = tree.get("file.txt");
    assert.ok(got !== undefined, "file.txt must exist");
    assert.equal(
      got.toString("utf8"),
      "A\nY\nX\nB\nC\nZ\n",
      "RA-001: charlie's base must be OT-merged (A\\nY\\nX\\nB\\nC\\n), not naively accumulated",
    );
  });

  void test("RA-001: task scenario — seed, alice (B→X), bob (C→Y), charlie base=(alice+bob)", () => {
    /**
     * Exact scenario from the task description:
     *   seed: "A\nB\nC\n"
     *   alice (concurrent with bob, forked from seed): changes it to "A\nX\nC\n"
     *     (replaces "B\n" with "X\n")
     *   bob (concurrent with alice, forked from seed): changes it to "A\nB\nY\n"
     *     (replaces "C\n" with "Y\n")
     *   charlie: base=(alice AND bob). charlie's base tree must be "A\nX\nY\n".
     *
     * Integration order: seed → bob → alice (alice@x < bob@x → alice later)
     * After bob (B=seed, C=seed, B==C): "A\nB\nY\n"
     * Apply alice (B=seed, C="A\nB\nY\n"):
     *   alice's edit: replace "B\n" → "X\n" = [retain 1, delete 1, insert ["X\n"], retain 1]
     *   Q = diff(["A\n","B\n","C\n"], ["A\n","B\n","Y\n"]) = [retain 2, delete 1, insert ["Y\n"]]
     *   P = [retain 1, delete 1, insert ["X\n"], retain 1]
     *   transform(P, Q):
     *     retain 1 vs retain 2: emit retain 1, consume 1 from each
     *     P: delete 1, Q: retain 1 → emit nothing (delete wins), consume 1 from each
     *     P: insert ["X\n"] → emit insert ["X\n"]
     *     P: retain 1, Q: delete 1, insert ["Y\n"] remaining:
     *       Q delete 1 vs P retain 1 → P's retain survives?
     *       Actually per OT rules: P retain vs Q delete → nothing, consume 1 from each
     *       Then Q insert ["Y\n"] → retain 1 (for Q insert, P has nothing)
     *       Wait, P is done. Drain Q: insert ["Y\n"] → retain 1
     *     P' = [retain 1, insert ["X\n"], retain 1, insert ["Y\n"]]...
     *     Hmm actually let me reconsider. This test verifies the OT result directly.
     *
     * The key assertion: charlie's base tree = OT merge of alice+bob applied to seed.
     * We observe it by having charlie make a no-op append after verifying the final tree.
     *
     * Simpler: just verify the three-patch (seed+alice+bob) replay result is "A\nX\nY\n",
     * then verify charlie can be applied on top of it with a correct base.
     */

    const seed = makePatch("seed@x", 1, [], "seed", [
      {
        type: "text",
        path: "file.txt",
        edit: [{ type: "insert", tokens: ["A\n", "B\n", "C\n"] }],
      },
    ]);

    // alice: "A\nB\nC\n" → "A\nX\nC\n" (replace B with X)
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice B→X", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["X\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);

    // bob: "A\nB\nC\n" → "A\nB\nY\n" (replace C with Y)
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob C→Y", [
      {
        type: "text",
        path: "file.txt",
        edit: [
          { type: "retain", count: 2 },
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["Y\n"] },
        ],
      },
    ]);

    // First verify that seed+alice+bob produces "A\nX\nY\n" (standard OT)
    {
      const repo3 = makeRepo(
        [
          ["alice@x", 1],
          ["bob@x", 1],
          ["seed@x", 1],
        ],
        [alice, bob, seed],
      );
      const { tree: tree3, warnings: w3 } = assertOk(replay(repo3));
      assert.deepEqual(w3, [], "no warnings for seed+alice+bob");
      assert.equal(
        tree3.get("file.txt")?.toString("utf8"),
        "A\nX\nY\n",
        "seed+alice+bob should OT-merge to A\\nX\\nY\\n",
      );
    }

    // Now charlie has base=(alice+bob+seed) — charlie's base tree must be "A\nX\nY\n"
    // charlie appends "Z\n" using a 3-token retain (valid for base "A\nX\nY\n")
    const charlie = makePatch(
      "charlie@x",
      1,
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["seed@x", 1],
      ],
      "charlie appends Z",
      [
        {
          type: "text",
          path: "file.txt",
          edit: [
            { type: "retain", count: 3 },
            { type: "insert", tokens: ["Z\n"] },
          ],
        },
      ],
    );

    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
        ["charlie@x", 1],
        ["seed@x", 1],
      ],
      [alice, bob, charlie, seed],
    );

    // With the fix: charlie's base is correctly "A\nX\nY\n" (3 tokens), so his
    // retain-3 + insert-Z edit applies cleanly; result = "A\nX\nY\nZ\n"
    // Without the fix: charlie's base would be "A\nX\nY\n" only if the naive apply
    // happened to work (it might in this case since alice and bob touch different tokens).
    // The primary regression test is the concurrent-inserts-at-same-position test above.
    const { tree, warnings } = assertOk(replay(repo));
    assert.deepEqual(warnings, [], "no warnings for charlie scenario");
    const got = tree.get("file.txt");
    assert.ok(got !== undefined, "file.txt must exist");
    assert.equal(
      got.toString("utf8"),
      "A\nX\nY\nZ\n",
      "RA-001 task scenario: charlie must see OT-merged base A\\nX\\nY\\n",
    );
  });
});

void describe("Tree — immutable operations", () => {
  void test("emptyTree has no paths", () => {
    const t = emptyTree();
    assert.deepEqual(t.paths(), []);
    assert.equal(t.has("x"), false);
    assert.equal(t.get("x"), undefined);
  });

  void test("set and get", () => {
    const t = emptyTree().set("a", textBuf("hello"));
    assert.equal(t.get("a")?.toString(), "hello");
    assert.equal(t.has("a"), true);
  });

  void test("delete removes key", () => {
    const t = emptyTree().set("a", textBuf("x")).delete("a");
    assert.equal(t.has("a"), false);
    assert.deepEqual(t.paths(), []);
  });

  void test("immutability: set returns new tree", () => {
    const t1 = emptyTree();
    const t2 = t1.set("a", textBuf("x"));
    assert.equal(t1.has("a"), false);
    assert.equal(t2.has("a"), true);
  });

  void test("paths are sorted by UTF-8 byte order", () => {
    const t = treeFromEntries([
      ["z/a", textBuf("1")],
      ["a/b", textBuf("2")],
      ["a", textBuf("3")],
    ]);
    const paths = t.paths();
    // UTF-8 byte sort: "a" < "a/b" < "z/a"
    assert.deepEqual([...paths], ["a", "a/b", "z/a"]);
  });

  void test("descendants returns all paths under prefix", () => {
    const t = treeFromEntries([
      ["a", textBuf("1")],
      ["a/b", textBuf("2")],
      ["a/b/c", textBuf("3")],
      ["b", textBuf("4")],
    ]);
    const desc = t.descendants("a");
    assert.deepEqual([...desc].sort(), ["a", "a/b", "a/b/c"]);
    assert.deepEqual([...t.descendants("b")], ["b"]);
  });

  void test("descendants does not include non-descendants with shared prefix string", () => {
    const t = treeFromEntries([
      ["ab", textBuf("1")],
      ["a/b", textBuf("2")],
      ["a", textBuf("3")],
    ]);
    // descendants of "a" should include "a" and "a/b" but NOT "ab"
    const desc = t.descendants("a");
    assert.ok([...desc].includes("a"), "should include exact path 'a'");
    assert.ok([...desc].includes("a/b"), "should include 'a/b' (direct child)");
    assert.ok(![...desc].includes("ab"), "should NOT include 'ab' (different path)");
  });
});
