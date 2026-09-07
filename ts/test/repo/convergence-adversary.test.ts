/**
 * CONVERGENCE ADVERSARY — Phase 3 adversarial audit of tree.ts and replay.ts
 * SPEC.md §6.1–6.4
 *
 * Rules:
 *  1. Every test must be a new scenario or boundary case not already in replay.test.ts.
 *  2. Every objection cites SPEC.md line range.
 *  3. Permutation convergence verified programmatically.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { replay } from "../../src/repo/replay.js";
import { assertOk } from "../helpers/result.js";
import type { Repository, Patch } from "../../src/repo/model.js";
import { emptyTree, treeFromEntries } from "../../src/core/tree.js";

// ---------------------------------------------------------------------------
// Helpers (mirror replay.test.ts helpers for self-containment)
// ---------------------------------------------------------------------------

function makeRepo(frontier: [string, number][], patches: Patch[]): Repository {
  return { format: 1, frontier: new Map(frontier), patches };
}

function makePatch(
  author: string,
  revision: number,
  base: [string, number][],
  message: string,
  changes: Patch["changes"],
): Patch {
  return { author, revision, base: new Map(base), message, changes };
}

function _b64(s: string): string {
  return Buffer.from(s).toString("base64");
}

function buf(s: string): Buffer {
  return Buffer.from(s, "utf8");
}

// ---------------------------------------------------------------------------
// ADVERSARY TEST 1 — test-18 permutation convergence (all 6 join orderings)
// SPEC §6.5: "The same valid patch set and frontier MUST produce the same bytes"
// SPEC §6.1: ordering by snap order of result versions
// ---------------------------------------------------------------------------

void describe("ADV-D: test-18 three-way permutation convergence (all 6 orderings)", () => {
  /**
   * Scenario from tests/18-three-way-convergence.yaml:
   *   seed: story.txt = "start\nend\n"
   *   a@x: insert "A\n" after "start\n" → "start\nA\nend\n"
   *   b@x: insert "B\n" after "start\n" → "start\nB\nend\n"
   *   c@x: delete "start\n" → "end\n"
   *
   * Expected merged result: "B\nA\nend\n" (from YAML assert)
   *
   * This test verifies all 6 permutations of the patches array produce the
   * same tree and warnings — since replay uses heap ordering, not array order.
   */
  const seed = makePatch("seed@x", 1, [], "seed", [
    {
      type: "text",
      path: "story.txt",
      edit: [{ type: "insert", tokens: ["start\n", "end\n"] }],
    },
  ]);
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

  const frontier: [string, number][] = [
    ["a@x", 1],
    ["b@x", 1],
    ["c@x", 1],
    ["seed@x", 1],
  ];

  const allPatches = [seed, a, b, c];

  // Generate all 4! = 24 permutations of 4 patches
  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      for (const p of permutations(rest)) {
        result.push([arr[i]!, ...p]);
      }
    }
    return result;
  }

  void test("all 24 permutations of 4 patches produce the same tree", () => {
    const perms = permutations(allPatches);
    assert.equal(perms.length, 24, "should have 24 permutations of 4 patches");

    const results: Array<{ content: string; warnings: string }> = [];
    for (const patchOrder of perms) {
      const repo = makeRepo(frontier, patchOrder);
      const { tree, warnings } = assertOk(replay(repo));
      const content = tree.get("story.txt")?.toString("utf8") ?? "(absent)";
      const warnStr = JSON.stringify(warnings);
      results.push({ content, warnings: warnStr });
    }

    const first = results[0]!;
    for (let i = 1; i < results.length; i++) {
      assert.equal(
        results[i]!.content,
        first.content,
        `permutation ${i} tree diverged:\n  got:      ${results[i]!.content}\n  expected: ${first.content}`,
      );
      assert.equal(
        results[i]!.warnings,
        first.warnings,
        `permutation ${i} warnings diverged:\n  got:      ${results[i]!.warnings}\n  expected: ${first.warnings}`,
      );
    }
  });

  void test("three-way convergence produces B\\nA\\nend\\n (YAML acceptance value)", () => {
    const repo = makeRepo(frontier, allPatches);
    const { tree, warnings } = assertOk(replay(repo));
    const content = tree.get("story.txt")?.toString("utf8");
    assert.equal(
      content,
      "B\nA\nend\n",
      `three-way OT must produce "B\\nA\\nend\\n", got: ${JSON.stringify(content)}`,
    );
    assert.deepEqual(warnings, [], "three-way text OT should produce no warnings");
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 2 — SPEC §6.2 item 2 / §6.4 rule 1: C == T for binary content
// No warning should be emitted when C and T are identical binary bytes.
// SPEC §6.4:398-401: "If C and T are identical, keep C and emit no warning."
// ---------------------------------------------------------------------------

void describe("ADV-D: SPEC §6.4 rule 1 — C==T for binary put, no warning", () => {
  void test("two concurrent puts with same binary content: no warning emitted", () => {
    /**
     * seed: data.bin = binary [0xDE, 0xAD]
     * alice@x: replace data.bin with [0xBE, 0xEF] (put, integrates second — alice@x < bob@x)
     * bob@x:   replace data.bin with [0xBE, 0xEF] (put, same content, integrates first)
     *
     * Integration order: seed → bob → alice
     * After bob: data.bin = [0xBE, 0xEF]
     * Apply alice: B=[0xDE,0xAD], C=[0xBE,0xEF], T=[0xBE,0xEF]
     *   C == T (both [0xBE,0xEF]) → SPEC §6.4 rule 1: keep C, no warning
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "put", path: "data.bin", content: Buffer.from([0xde, 0xad]).toString("base64") },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      { type: "put", path: "data.bin", content: Buffer.from([0xbe, 0xef]).toString("base64") },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      { type: "put", path: "data.bin", content: Buffer.from([0xbe, 0xef]).toString("base64") },
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
    const got = tree.get("data.bin");
    assert.ok(got !== undefined, "data.bin should exist");
    assert.deepEqual(got, Buffer.from([0xbe, 0xef]), "data.bin should have the agreed content");
    assert.deepEqual(
      warnings,
      [],
      `SPEC §6.4 rule 1: C==T binary → no warning; got: ${JSON.stringify(warnings)}`,
    );
  });

  void test("concurrent text-creates with same content: no warning emitted", () => {
    /**
     * alice@x and bob@x both create readme.txt from scratch with identical text.
     * B is absent for both. C==T after the earlier one applies.
     */
    const sharedContent = "hello world\n";
    const bob = makePatch("bob@x", 1, [], "bob creates readme", [
      {
        type: "text",
        path: "readme.txt",
        edit: [{ type: "insert", tokens: [sharedContent] }],
      },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice creates readme", [
      {
        type: "text",
        path: "readme.txt",
        edit: [{ type: "insert", tokens: [sharedContent] }],
      },
    ]);
    // Integration order: bob@x > alice@x in snapOrder → alice is later
    // After bob: C = "hello world\n"
    // Apply alice: B=absent, C="hello world\n", T="hello world\n"
    // C == T → SPEC §6.4 rule 1: no warning
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    assert.equal(tree.get("readme.txt")?.toString("utf8"), sharedContent);
    assert.deepEqual(
      warnings,
      [],
      `SPEC §6.4 rule 1: C==T text creates → no warning; got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 3 — SPEC §6.4 rule 3: B present, C absent (concurrent delete)
// "If B is present and C is absent, the earlier concurrent delete wins (delete-wins)"
// SPEC §6.4 lines 403-405
// ---------------------------------------------------------------------------

void describe("ADV-D: SPEC §6.4 rule 3 — B present, C absent (concurrent delete)", () => {
  void test("B present, C absent, T present (text edit): delete-wins emitted", () => {
    /**
     * seed: file.txt = "base\n"
     * bob@x (integrates FIRST — bob@x > alice@x in snap order):
     *   deletes file.txt
     * alice@x (integrates SECOND):
     *   edits file.txt to "edited\n" (text change)
     *
     * After bob: C has file.txt absent.
     * Apply alice: B="base\n", C=absent, T="edited\n"
     *   B present, C absent → SPEC §6.4 rule 3: delete-wins (C stays absent)
     *   Warning: (file.txt, delete-wins)
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob deletes", [
      { type: "delete", path: "file.txt" },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice edits", [
      {
        type: "text",
        path: "file.txt",
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
    const { tree, warnings } = assertOk(replay(repo));
    // Concurrent delete (bob) wins over incoming text edit (alice)
    assert.equal(
      tree.has("file.txt"),
      false,
      "SPEC §6.4 rule 3: concurrent delete wins, file.txt must be absent",
    );
    const w = warnings.find((x) => x.path === "file.txt");
    assert.ok(
      w !== undefined,
      `SPEC §6.4 rule 3: expected delete-wins warning for file.txt; got: ${JSON.stringify(warnings)}`,
    );
    assert.equal(
      w.reason,
      "delete-wins",
      `expected reason 'delete-wins' for file.txt, got '${w.reason}'`,
    );
  });

  void test("B present, C absent, T present (put): delete-wins emitted", () => {
    /**
     * Same scenario but alice's change is a put (atomic replacement).
     * Rule 3 (B present, C absent) fires BEFORE rule 5 (incoming put).
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      {
        type: "put",
        path: "data.bin",
        content: Buffer.from([0x01]).toString("base64"),
      },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob deletes", [
      { type: "delete", path: "data.bin" },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice puts", [
      {
        type: "put",
        path: "data.bin",
        content: Buffer.from([0x02]).toString("base64"),
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
    // SPEC §6.4 rule 3 fires: B present, C absent → delete-wins
    // NOT rule 5 (later-put-wins) which would require B absent or special
    assert.equal(
      tree.has("data.bin"),
      false,
      "SPEC §6.4 rule 3: concurrent delete wins over incoming put; data.bin must be absent",
    );
    assert.ok(
      warnings.some((w) => w.path === "data.bin" && w.reason === "delete-wins"),
      `SPEC §6.4 rule 3: expected delete-wins for data.bin; got: ${JSON.stringify(warnings)}`,
    );
    // Must NOT emit later-put-wins
    assert.ok(
      !warnings.some((w) => w.path === "data.bin" && w.reason === "later-put-wins"),
      `SPEC §6.4 rule 3 fires before rule 5; must not emit later-put-wins; got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 4 — Single patch triggering different winner rules on different paths
// SPEC §6.4 lines 399-415
// ---------------------------------------------------------------------------

void describe("ADV-D: single patch triggers delete-wins + put-wins on different paths", () => {
  void test("one patch produces delete-wins on one path and put-wins on another", () => {
    /**
     * seed: del.txt = "base\n", incompat.txt = "base\n"
     *
     * bob@x (integrates FIRST — bob > alice in snap order):
     *   - deletes del.txt           → after bob: del.txt absent
     *   - puts incompat.txt binary  → after bob: incompat.txt = binary
     *
     * alice@x (integrates SECOND, single patch with two changes):
     *   - text edits del.txt (B="base\n", C=absent, T="edited\n")
     *     → SPEC §6.4 rule 3: B present, C absent → delete-wins
     *   - text edits incompat.txt (B="base\n", C=binary, T=text)
     *     → SPEC §6.4 rule 6: P text, C non-text → put-wins (C stays)
     *
     * Verify: del.txt absent (delete-wins), incompat.txt=binary (put-wins)
     * Verify: exactly one warning for each path, correct reason
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "del.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
      { type: "text", path: "incompat.txt", edit: [{ type: "insert", tokens: ["base\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      { type: "delete", path: "del.txt" },
      { type: "put", path: "incompat.txt", content: Buffer.from([0xca, 0xfe]).toString("base64") },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "del.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited\n"] },
        ],
      },
      {
        type: "text",
        path: "incompat.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["text content\n"] },
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

    // del.txt: delete-wins (concurrent delete by bob wins)
    assert.equal(
      tree.has("del.txt"),
      false,
      "SPEC §6.4 rule 3: del.txt must be absent (delete-wins)",
    );
    // incompat.txt: put-wins (bob's binary C stays)
    const got = tree.get("incompat.txt");
    assert.ok(got !== undefined, "incompat.txt should exist (put-wins keeps binary)");
    assert.deepEqual(
      got,
      Buffer.from([0xca, 0xfe]),
      "SPEC §6.4 rule 6: put-wins keeps existing binary content",
    );

    const delWarn = warnings.find((w) => w.path === "del.txt");
    assert.ok(
      delWarn !== undefined && delWarn.reason === "delete-wins",
      `expected delete-wins for del.txt; got: ${JSON.stringify(warnings)}`,
    );
    const putWarn = warnings.find((w) => w.path === "incompat.txt");
    assert.ok(
      putWarn !== undefined && putWarn.reason === "put-wins",
      `expected put-wins for incompat.txt; got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 5 — Three-level namespace collision: "a" vs "a/b/c"
// SPEC §6.2 lines 347–355: namespace conflict resolution
// PLAN.md §12: "three-level collision: a vs a/b/c"
// ---------------------------------------------------------------------------

void describe("ADV-D: three-level namespace collision (a vs a/b/c)", () => {
  void test("incoming 'a/b/c' conflicts with existing 'a' — namespace-wins removes 'a'", () => {
    /**
     * alice@x (integrates FIRST — alice@x < bob@x in snap order, so bob > alice → alice later)
     * Wait: snap order compares result vectors.
     * alice result: {alice@x:1}, bob result: {bob@x:1}
     * sorted IDs: [alice@x, bob@x]
     * at alice@x: alice=1, bob=0 → alice's result is LARGER → alice integrates LATER
     * So bob integrates first.
     *
     * bob@x: creates "a" (file)
     * alice@x: creates "a/b/c" (file — 3 levels deep, ancestor conflict)
     *
     * After bob: C has "a"
     * Apply alice: S = {"a/b/c"}, ancestor "a" in C → namespace conflict
     * alice's "a/b/c" wins (namespace-wins), bob's "a" is removed.
     * Warning: (a, namespace-wins)
     */
    const bob = makePatch("bob@x", 1, [], "bob creates a", [
      { type: "text", path: "a", edit: [{ type: "insert", tokens: ["ancestor\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice creates a/b/c", [
      { type: "text", path: "a/b/c", edit: [{ type: "insert", tokens: ["deep descendant\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    // alice's a/b/c should win, bob's a should be removed
    assert.equal(
      tree.has("a"),
      false,
      "SPEC §6.2: three-level namespace conflict — existing 'a' must be removed",
    );
    assert.equal(
      tree.get("a/b/c")?.toString("utf8"),
      "deep descendant\n",
      "alice's 'a/b/c' must win namespace conflict",
    );
    assert.ok(
      warnings.some((w) => w.path === "a" && w.reason === "namespace-wins"),
      `expected namespace-wins warning for 'a'; got: ${JSON.stringify(warnings)}`,
    );
  });

  void test("incoming 'a' conflicts with existing 'a/b/c' — namespace-wins removes 'a/b/c'", () => {
    /**
     * bob@x integrates first:
     *   creates "a/b/c"
     * alice@x integrates second:
     *   creates "a" (ancestor conflict with "a/b/c")
     *
     * alice's S = {"a"}, descendants of "a" in C = {"a/b/c"}
     * namespace-wins: alice's "a" wins, "a/b/c" removed
     * Warning: (a/b/c, namespace-wins)
     */
    const bob = makePatch("bob@x", 1, [], "bob creates a/b/c", [
      { type: "text", path: "a/b/c", edit: [{ type: "insert", tokens: ["deep\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice creates a", [
      { type: "text", path: "a", edit: [{ type: "insert", tokens: ["ancestor\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    assert.equal(
      tree.has("a/b/c"),
      false,
      "SPEC §6.2: three-level namespace conflict — existing 'a/b/c' must be removed",
    );
    assert.equal(
      tree.get("a")?.toString("utf8"),
      "ancestor\n",
      "alice's 'a' must win namespace conflict",
    );
    assert.ok(
      warnings.some((w) => w.path === "a/b/c" && w.reason === "namespace-wins"),
      `expected namespace-wins warning for 'a/b/c'; got: ${JSON.stringify(warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 6 — Warning sort order: sorted by path then reason
// SPEC §6.4 lines 421–423: "Replay returns the set of unique warning pairs
// sorted by path, then reason."
// ---------------------------------------------------------------------------

void describe("ADV-D: warning sort order — by path then reason", () => {
  void test("multiple warnings sorted by path then by reason within same path", () => {
    /**
     * Scenario: 4 concurrent files, 2 different warning reasons.
     * seed: z.txt, a.txt, m.txt (all text)
     * bob (integrates FIRST): deletes a.txt and m.txt, puts z.txt binary
     * alice (integrates SECOND): edits a.txt (→ delete-wins), edits m.txt (→ delete-wins),
     *                             text-edits z.txt (C=binary → put-wins)
     *
     * Expected warnings sorted by path:
     *   (a.txt, delete-wins)
     *   (m.txt, delete-wins)
     *   (z.txt, put-wins)
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "a.txt", edit: [{ type: "insert", tokens: ["a\n"] }] },
      { type: "text", path: "m.txt", edit: [{ type: "insert", tokens: ["m\n"] }] },
      { type: "text", path: "z.txt", edit: [{ type: "insert", tokens: ["z\n"] }] },
    ]);
    const bob = makePatch("bob@x", 1, [["seed@x", 1]], "bob", [
      { type: "delete", path: "a.txt" },
      { type: "delete", path: "m.txt" },
      { type: "put", path: "z.txt", content: Buffer.from([0xff]).toString("base64") },
    ]);
    const alice = makePatch("alice@x", 1, [["seed@x", 1]], "alice", [
      {
        type: "text",
        path: "a.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited a\n"] },
        ],
      },
      {
        type: "text",
        path: "m.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited m\n"] },
        ],
      },
      {
        type: "text",
        path: "z.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["edited z\n"] },
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
    const paths = warnings.map((w) => w.path);
    // Verify sorted by path
    const expected = ["a.txt", "m.txt", "z.txt"];
    assert.deepEqual(
      paths,
      expected,
      `SPEC §6.4: warnings must be sorted by path; got: ${JSON.stringify(paths)}`,
    );
    assert.equal(warnings[0]?.reason, "delete-wins");
    assert.equal(warnings[1]?.reason, "delete-wins");
    assert.equal(warnings[2]?.reason, "put-wins");
  });

  void test("warnings with same path sorted by reason alphabetically", () => {
    /**
     * Adversarial test: ensure that two warnings for the SAME path but different reasons
     * are not deduplicated and are sorted by reason.
     *
     * This is hard to achieve with a single replay because one path can only have
     * one winner rule per conflict. But we can test deduplication behavior:
     * if two patches independently trigger the same (path, reason), only one warning
     * should appear in the output.
     *
     * Scenario: 3 patches all concurrently from empty base, each creating "file.txt"
     * seed patches: p1 (first), p2 (second), p3 (third) in snap order
     * After p1: file.txt = "one\n"
     * Apply p2: B=absent, C="one\n", T="two\n" → later-create-wins, file.txt = "two\n"
     * Apply p3: B=absent, C="two\n", T="three\n" → later-create-wins, file.txt = "three\n"
     * Warning (file.txt, later-create-wins) should appear only ONCE (deduplicated)
     */
    const p1 = makePatch("a@x", 1, [], "p1", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["one\n"] }] },
    ]);
    const p2 = makePatch("b@x", 1, [], "p2", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["two\n"] }] },
    ]);
    const p3 = makePatch("c@x", 1, [], "p3", [
      { type: "text", path: "file.txt", edit: [{ type: "insert", tokens: ["three\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["a@x", 1],
        ["b@x", 1],
        ["c@x", 1],
      ],
      [p1, p2, p3],
    );
    const { warnings } = assertOk(replay(repo));
    const fileTxtWarnings = warnings.filter((w) => w.path === "file.txt");
    assert.equal(
      fileTxtWarnings.length,
      1,
      `SPEC §6.4: duplicate (path, reason) pairs must be collapsed; got: ${JSON.stringify(fileTxtWarnings)}`,
    );
    assert.equal(fileTxtWarnings[0]?.reason, "later-create-wins");
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 7 — Tree.descendants() edge cases
// SPEC §2: prefix-free by path segment
// tree.ts: descendants(prefix) must include the exact path itself if present
// ---------------------------------------------------------------------------

void describe("ADV-D: Tree.descendants() edge cases", () => {
  void test("descendants('a') includes 'a' when both 'a' and 'a/b' exist", () => {
    /**
     * SPEC §2: "a" is a file, "a/b" is a file — but this violates prefix-free.
     * However, in namespace conflict resolution (§6.2), C' may temporarily
     * contain such paths before resolution. The tree abstraction must handle it.
     *
     * Test that descendants("a") returns ["a", "a/b"] when both exist.
     */
    const t = treeFromEntries([
      ["a", buf("1")],
      ["a/b", buf("2")],
      ["a/b/c", buf("3")],
      ["ab", buf("4")], // NOT a descendant of "a" — different path
      ["b", buf("5")],
    ]);
    const desc = [...t.descendants("a")].sort();
    // "a", "a/b", "a/b/c" are descendants; "ab" and "b" are NOT
    assert.ok(desc.includes("a"), "descendants('a') must include 'a' itself");
    assert.ok(desc.includes("a/b"), "descendants('a') must include 'a/b'");
    assert.ok(desc.includes("a/b/c"), "descendants('a') must include 'a/b/c'");
    assert.ok(!desc.includes("ab"), "descendants('a') must NOT include 'ab'");
    assert.ok(!desc.includes("b"), "descendants('a') must NOT include 'b'");
    assert.equal(
      desc.length,
      3,
      `descendants('a') should return exactly 3 paths; got: ${JSON.stringify(desc)}`,
    );
  });

  void test("descendants on empty tree returns empty array", () => {
    const t = emptyTree();
    assert.deepEqual([...t.descendants("a")], []);
    assert.deepEqual([...t.descendants("x/y/z")], []);
  });

  void test("descendants of non-existent prefix returns empty array", () => {
    const t = treeFromEntries([
      ["a/b", buf("1")],
      ["c/d", buf("2")],
    ]);
    assert.deepEqual([...t.descendants("z")], []);
    assert.deepEqual([...t.descendants("a/x")], []);
  });

  void test("descendants does not confuse 'prefix' with 'prefixX' (no slash)", () => {
    /**
     * Adversarial: "foo" and "foobar" — "foobar" must NOT be a descendant of "foo"
     * because it doesn't have "foo/" as a prefix.
     */
    const t = treeFromEntries([
      ["foo", buf("1")],
      ["foo/bar", buf("2")],
      ["foobar", buf("3")],
      ["foobar/baz", buf("4")],
    ]);
    const desc = [...t.descendants("foo")].sort();
    assert.ok(desc.includes("foo"), "must include 'foo' itself");
    assert.ok(desc.includes("foo/bar"), "must include 'foo/bar'");
    assert.ok(!desc.includes("foobar"), "must NOT include 'foobar'");
    assert.ok(!desc.includes("foobar/baz"), "must NOT include 'foobar/baz'");
    assert.equal(desc.length, 2);
  });

  void test("descendants returns only the exact path when no children exist", () => {
    const t = treeFromEntries([["alone", buf("1")]]);
    const desc = [...t.descendants("alone")];
    assert.deepEqual(desc, ["alone"]);
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 8 — Duplicate-warning collapse for namespace conflicts
// SPEC §6.2 lines 353–355: "duplicate removals and warnings collapse"
// ---------------------------------------------------------------------------

void describe("ADV-D: namespace-wins duplicate warning collapse", () => {
  void test("multiple paths in S conflicting with same parent emit one warning per removed path", () => {
    /**
     * bob@x (integrates first): creates "a/x" and "a/y" (two files under "a/")
     * alice@x (integrates second): creates "a" (ancestor of both "a/x" and "a/y")
     *
     * S = {"a"}, descendants of "a" in C = {"a/x", "a/y"}
     * Both "a/x" and "a/y" are removed.
     * Warnings: one per removed path: (a/x, namespace-wins), (a/y, namespace-wins)
     * NOT one warning per pair (only 2 warnings, not 4).
     */
    const bob = makePatch("bob@x", 1, [], "bob creates a/x and a/y", [
      { type: "text", path: "a/x", edit: [{ type: "insert", tokens: ["x\n"] }] },
      { type: "text", path: "a/y", edit: [{ type: "insert", tokens: ["y\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice creates a", [
      { type: "text", path: "a", edit: [{ type: "insert", tokens: ["parent\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));

    // alice's "a" must be present, bob's "a/x" and "a/y" must be absent
    assert.equal(tree.get("a")?.toString("utf8"), "parent\n");
    assert.equal(tree.has("a/x"), false, "a/x must be removed by namespace-wins");
    assert.equal(tree.has("a/y"), false, "a/y must be removed by namespace-wins");

    const nsWarnings = warnings.filter((w) => w.reason === "namespace-wins");
    // SPEC §6.2: one warning per removed path
    assert.equal(
      nsWarnings.length,
      2,
      `expected exactly 2 namespace-wins warnings (one per removed path); got: ${JSON.stringify(nsWarnings)}`,
    );
    assert.ok(
      nsWarnings.some((w) => w.path === "a/x"),
      "expected namespace-wins for a/x",
    );
    assert.ok(
      nsWarnings.some((w) => w.path === "a/y"),
      "expected namespace-wins for a/y",
    );
  });

  void test("same removal triggered by multiple S paths: one warning (collapse)", () => {
    /**
     * This tests SPEC §6.2: "duplicate removals and warnings collapse"
     * bob@x (integrates first): creates "a" (file)
     * alice@x (integrates second): creates "a/x" AND "a/y" in same patch
     *   S = {"a/x", "a/y"}, both have ancestor "a" in C
     *   Both would try to remove "a" → duplicate removals collapse to one removal
     *   Warning: one (a, namespace-wins), not two
     */
    const bob = makePatch("bob@x", 1, [], "bob creates a", [
      { type: "text", path: "a", edit: [{ type: "insert", tokens: ["ancestor\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice creates a/x and a/y", [
      { type: "text", path: "a/x", edit: [{ type: "insert", tokens: ["x\n"] }] },
      { type: "text", path: "a/y", edit: [{ type: "insert", tokens: ["y\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));

    assert.equal(tree.has("a"), false, "bob's 'a' must be removed");
    assert.equal(tree.get("a/x")?.toString("utf8"), "x\n", "alice's 'a/x' must be installed");
    assert.equal(tree.get("a/y")?.toString("utf8"), "y\n", "alice's 'a/y' must be installed");

    const nsWarnings = warnings.filter((w) => w.reason === "namespace-wins");
    // SPEC §6.2: duplicate removals collapse → only 1 warning for "a"
    assert.equal(
      nsWarnings.length,
      1,
      `SPEC §6.2: duplicate removals must collapse to one warning; got: ${JSON.stringify(nsWarnings)}`,
    );
    assert.equal(nsWarnings[0]?.path, "a", "the single namespace-wins warning must be for 'a'");
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 9 — SPEC §6.4 rule 4 (later-create-wins) direction check
// "If B is absent and C and T are present, the incoming (canonically later)
// create wins (later-create-wins)" — SPEC §6.4 lines 407-408
// The INCOMING patch's value always wins (not C's value).
// ---------------------------------------------------------------------------

void describe("ADV-D: SPEC §6.4 rule 4 — later-create-wins installs T not C", () => {
  void test("later-create-wins: incoming T value is installed (not C)", () => {
    /**
     * bob@x creates new.txt = "bob\n"   (integrates first)
     * alice@x creates new.txt = "alice\n" (integrates second, canonically later)
     *
     * B = absent (both from empty base), C = "bob\n", T = "alice\n"
     * SPEC §6.4 rule 4: incoming (later = alice) wins → install T = "alice\n"
     * Warning: (new.txt, later-create-wins)
     */
    const bob = makePatch("bob@x", 1, [], "bob", [
      { type: "text", path: "new.txt", edit: [{ type: "insert", tokens: ["bob\n"] }] },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice", [
      { type: "text", path: "new.txt", edit: [{ type: "insert", tokens: ["alice\n"] }] },
    ]);
    const repo = makeRepo(
      [
        ["alice@x", 1],
        ["bob@x", 1],
      ],
      [alice, bob],
    );
    const { tree, warnings } = assertOk(replay(repo));
    const content = tree.get("new.txt")?.toString("utf8");
    assert.equal(
      content,
      "alice\n",
      `SPEC §6.4 rule 4: later create (alice) must win; got: ${JSON.stringify(content)}`,
    );
    assert.ok(
      warnings.some((w) => w.path === "new.txt" && w.reason === "later-create-wins"),
      `expected later-create-wins for new.txt; got: ${JSON.stringify(warnings)}`,
    );
  });

  void test("later-create-wins is directional: bob-then-alice != alice-then-bob outcome", () => {
    /**
     * Verify that the LATER patch's value wins, and this produces a consistent
     * result regardless of which repo is the "local" vs "remote" in a merge.
     * Both orders must produce the same final tree (alice's value).
     */
    const bob = makePatch("bob@x", 1, [], "bob", [
      { type: "put", path: "f.bin", content: Buffer.from([0x01]).toString("base64") },
    ]);
    const alice = makePatch("alice@x", 1, [], "alice", [
      { type: "put", path: "f.bin", content: Buffer.from([0x02]).toString("base64") },
    ]);

    // All permutations of the 2 patches
    const frontier: [string, number][] = [
      ["alice@x", 1],
      ["bob@x", 1],
    ];

    const repo1 = makeRepo(frontier, [alice, bob]);
    const repo2 = makeRepo(frontier, [bob, alice]);

    const { tree: t1 } = assertOk(replay(repo1));
    const { tree: t2 } = assertOk(replay(repo2));

    // Both must produce the same result (alice is later, alice wins)
    const r1 = t1.get("f.bin");
    const r2 = t2.get("f.bin");
    assert.ok(r1 !== undefined && r2 !== undefined);
    assert.deepEqual(r1, r2, "later-create-wins must be independent of patches array order");
    // Alice (alice@x < bob@x → alice is LATER in snap order) wins
    assert.deepEqual(r1, Buffer.from([0x02]), "alice's put must win (she is canonically later)");
  });
});

// ---------------------------------------------------------------------------
// ADVERSARY TEST 10 — Convergence with mixed file types across 3 contributors
// Tests interplay of multiple rules in a single replay.
// SPEC §6.1–6.4
// ---------------------------------------------------------------------------

void describe("ADV-D: multi-contributor mixed-type convergence", () => {
  void test("3-way merge: text OT + delete-wins + later-create-wins all fire correctly", () => {
    /**
     * seed: shared.txt = "L1\nL2\n", mortal.txt = "x\n"
     * a@x: text edit shared.txt insert "A\n" after L1; also edits mortal.txt
     * b@x: text edit shared.txt insert "B\n" after L1; also deletes mortal.txt
     * c@x: creates brand-new.txt = "new\n"
     *
     * Integration order (snap order of result vectors):
     * a result = {a@x:1, seed@x:1}
     * b result = {b@x:1, seed@x:1}
     * c result = {c@x:1, seed@x:1}
     * Sorted IDs: [a@x, b@x, c@x, seed@x]
     * at a@x: a=1, b=0, c=0 → a is largest at first component
     * so c is smallest, then b, then a.
     * Order: seed → c → b → a
     *
     * After seed: shared.txt="L1\nL2\n", mortal.txt="x\n"
     *
     * Apply c (B=seed, C=seed, B==C for seed paths; brand-new.txt not in B):
     *   brand-new.txt: B absent, C absent → B==C → apply directly → install "new\n"
     *   (c doesn't touch seed's files)
     *   After c: shared.txt="L1\nL2\n", mortal.txt="x\n", brand-new.txt="new\n"
     *
     * Apply b (B=seed, C=after-c):
     *   shared.txt: B="L1\nL2\n"(same as C) → B==C → apply directly
     *     b inserts "B\n" after L1 → shared.txt = "L1\nB\nL2\n"
     *   mortal.txt: B="x\n" == C="x\n" → B==C → apply delete → mortal.txt absent
     *   After b: shared.txt="L1\nB\nL2\n", mortal.txt=absent, brand-new.txt="new\n"
     *
     * Apply a (B=seed, C=after-b):
     *   shared.txt: B="L1\nL2\n", C="L1\nB\nL2\n", T="L1\nA\nL2\n"
     *     B,C,T all text, type=text → OT
     *     Q = diff(B,C) = diff(["L1\n","L2\n"], ["L1\n","B\n","L2\n"])
     *       = [retain 1, insert ["B\n"], retain 1]
     *     P = a's edit = [retain 1, insert ["A\n"], retain 1]
     *     transform(P, Q):
     *       - Q op: retain 1, P op: retain 1 → retain 1, both advance
     *       - Q op: insert ["B\n"] → retain 1, Q advances (P insert priority)
     *       - P op: insert ["A\n"] → insert ["A\n"], P advances
     *       - P op: retain 1, Q op: retain 1 → retain 1, both advance
     *     P' = [retain 1, retain 1, insert ["A\n"], retain 1] = [retain 2, insert ["A\n"], retain 1]
     *     Apply to C=["L1\n","B\n","L2\n"]: ["L1\n","B\n","A\n","L2\n"]
     *     → shared.txt = "L1\nB\nA\nL2\n"
     *   mortal.txt: B="x\n", C=absent, T=? (a edits mortal.txt)
     *     B present, C absent → SPEC §6.4 rule 3: delete-wins
     *     Warning: (mortal.txt, delete-wins)
     */
    const seed = makePatch("seed@x", 1, [], "seed", [
      { type: "text", path: "mortal.txt", edit: [{ type: "insert", tokens: ["x\n"] }] },
      { type: "text", path: "shared.txt", edit: [{ type: "insert", tokens: ["L1\n", "L2\n"] }] },
    ]);
    const a = makePatch("a@x", 1, [["seed@x", 1]], "a", [
      {
        type: "text",
        path: "mortal.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["a-edit\n"] },
        ],
      },
      {
        type: "text",
        path: "shared.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["A\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);
    const b = makePatch("b@x", 1, [["seed@x", 1]], "b", [
      { type: "delete", path: "mortal.txt" },
      {
        type: "text",
        path: "shared.txt",
        edit: [
          { type: "retain", count: 1 },
          { type: "insert", tokens: ["B\n"] },
          { type: "retain", count: 1 },
        ],
      },
    ]);
    const c = makePatch("c@x", 1, [["seed@x", 1]], "c", [
      { type: "text", path: "brand-new.txt", edit: [{ type: "insert", tokens: ["new\n"] }] },
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

    // shared.txt: OT merge of two inserts after L1
    assert.equal(
      tree.get("shared.txt")?.toString("utf8"),
      "L1\nB\nA\nL2\n",
      "OT merge of two concurrent inserts",
    );
    // mortal.txt: concurrent delete by b wins
    assert.equal(tree.has("mortal.txt"), false, "SPEC §6.4 rule 3: delete-wins");
    // brand-new.txt: uncontested create by c
    assert.equal(tree.get("brand-new.txt")?.toString("utf8"), "new\n");

    // Warning for mortal.txt
    assert.ok(
      warnings.some((w) => w.path === "mortal.txt" && w.reason === "delete-wins"),
      `expected delete-wins for mortal.txt; got: ${JSON.stringify(warnings)}`,
    );
    // No warning for shared.txt (OT path)
    assert.ok(
      !warnings.some((w) => w.path === "shared.txt"),
      `must be no warning for shared.txt (OT merge); got: ${JSON.stringify(warnings)}`,
    );
    // No warning for brand-new.txt (uncontested)
    assert.ok(
      !warnings.some((w) => w.path === "brand-new.txt"),
      `must be no warning for brand-new.txt; got: ${JSON.stringify(warnings)}`,
    );

    // Verify convergence: same result regardless of patches array order
    const allPatches = [seed, a, b, c];
    function perms2<T>(arr: T[]): T[][] {
      if (arr.length <= 1) return [arr];
      const result: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const p of perms2(rest)) {
          result.push([arr[i]!, ...p]);
        }
      }
      return result;
    }
    const allPerms = perms2(allPatches);
    for (const patchOrder of allPerms) {
      const r = makeRepo(
        [
          ["a@x", 1],
          ["b@x", 1],
          ["c@x", 1],
          ["seed@x", 1],
        ],
        patchOrder,
      );
      const { tree: t2 } = assertOk(replay(r));
      assert.equal(
        t2.get("shared.txt")?.toString("utf8"),
        "L1\nB\nA\nL2\n",
        "convergence: shared.txt must equal L1\\nB\\nA\\nL2\\n for all permutations",
      );
      assert.equal(t2.has("mortal.txt"), false, "convergence: mortal.txt must be absent");
    }
  });
});
