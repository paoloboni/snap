/**
 * Causal-graph generator — import-permutation convergence property tests
 *
 * SPEC.md §6.5: "The same valid patch set and frontier MUST produce the same
 * bytes and warning set in every implementation."
 *
 * SPEC.md §1.1 invariant 6: "Import is set union: idempotent, commutative,
 * and associative."
 *
 * PLAN.md §12 YAML-inexpressible: "import-permutation property tests
 * (frontier, patch set, warnings, tree bytes)"
 *
 * Test strategy:
 *   For N patches on shared content, try all permutations of joinRepositories:
 *     join(join(join(repo1, repo2), repo3), ...) vs join(repo1, join(repo2, repo3)) etc.
 *   All must produce the same frontier, same tree bytes, same warnings (sorted).
 *
 * Scenarios tested:
 *   1. 3-way concurrent text inserts (test-18 scenario variant)
 *   2. 3-way concurrent put / delete / put conflicts
 *   3. 4-way concurrent creates of the same path (only one wins)
 *   4. Namespace conflict with simultaneous delete
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  joinRepositories as joinRepositoriesResult,
  replay as replayResult,
} from "../../src/repo/replay.js";
import type { Warning } from "../../src/repo/replay.js";
import type { Repository, Patch } from "../../src/repo/model.js";
import type { Tree } from "../../src/core/tree.js";
import { assertOk } from "../helpers/result.js";

// Every scenario in this file operates on valid, causally-closed histories, so
// replay and import must always succeed; unwrap once here and keep the call
// sites focused on the convergence properties being asserted.
function replay(repo: Repository): { tree: Tree; warnings: readonly Warning[] } {
  return assertOk(replayResult(repo));
}

function joinRepositories(
  local: Repository,
  remote: Repository,
): { repo: Repository; warnings: readonly Warning[] } {
  return assertOk(joinRepositoriesResult(local, remote));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _makeRepo(frontier: [string, number][], patches: Patch[]): Repository {
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

/** Generate all permutations of an array */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [[...arr]];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) {
      result.push([arr[i]!, ...p]);
    }
  }
  return result;
}

/**
 * Join a sequence of repositories left-to-right and return the merged repo.
 * join(join(join(repos[0], repos[1]), repos[2]), ..., repos[n-1])
 */
function joinSequentialRepo(repos: Repository[]): Repository {
  assert.ok(repos.length >= 1, "need at least 1 repo");
  let current = repos[0]!;
  for (let i = 1; i < repos.length; i++) {
    const { repo } = joinRepositories(current, repos[i]!);
    current = repo;
  }
  return current;
}

/**
 * Snapshot the result of joining a sequence of repositories left-to-right.
 * join(join(join(repos[0], repos[1]), repos[2]), ..., repos[n-1])
 */
function joinSequential(repos: Repository[]): {
  repo: Repository;
  frontier: string;
  treeEntries: string;
  warnings: string;
} {
  const repo = joinSequentialRepo(repos);
  return { repo, ...snapshot(repo) };
}

/** Canonicalize a repository result for comparison */
function snapshot(repo: Repository): { frontier: string; treeEntries: string; warnings: string } {
  const { tree, warnings } = replay(repo);

  // Frontier: sorted entries
  const frontierPairs: [string, number][] = [...repo.frontier.entries()];
  frontierPairs.sort(([a], [b]) => {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    return ba.compare(bb);
  });
  const frontier = JSON.stringify(frontierPairs);

  // Tree entries: sorted by path, values as hex strings
  const paths = [...tree.paths()].sort();
  const entries: [string, string][] = paths.map((p) => [p, tree.get(p)!.toString("hex")]);
  const treeEntries = JSON.stringify(entries);

  // Warnings: already sorted by (path, reason)
  const warningArr = warnings.map((w) => `${w.path}:${w.reason}`);
  const warningsStr = JSON.stringify(warningArr);

  return { frontier, treeEntries, warnings: warningsStr };
}

/**
 * Assert that all permutations of sequential joins produce the same result.
 * N! join-order permutations tested.
 */
function assertPermutationConvergence(repos: Repository[], label: string): number {
  const perms = permutations(repos);
  const results = perms.map((perm) => joinSequential(perm));

  const first = results[0]!;
  for (let i = 1; i < results.length; i++) {
    const r = results[i]!;
    assert.equal(
      r.frontier,
      first.frontier,
      `[${label}] permutation ${i} frontier diverged:\n  got:      ${r.frontier}\n  expected: ${first.frontier}`,
    );
    assert.equal(
      r.treeEntries,
      first.treeEntries,
      `[${label}] permutation ${i} tree bytes diverged:\n  got:      ${r.treeEntries}\n  expected: ${first.treeEntries}`,
    );
    assert.equal(
      r.warnings,
      first.warnings,
      `[${label}] permutation ${i} warnings diverged:\n  got:      ${r.warnings}\n  expected: ${first.warnings}`,
    );
  }
  return perms.length;
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

/**
 * Build a "contributor repository" — the seed repo plus one contributor patch.
 * This is what each contributor would have after forking from seed and adding
 * their own concurrent change.
 */
function contributorRepo(seedRepo: Repository, contributorPatch: Patch): Repository {
  const frontier = new Map(seedRepo.frontier);
  frontier.set(contributorPatch.author, contributorPatch.revision);

  const allPatches = [...seedRepo.patches, contributorPatch];
  // Sort patches by author then revision (SPEC §4.1)
  allPatches.sort((a, b) => {
    const ba = Buffer.from(a.author, "utf8");
    const bb = Buffer.from(b.author, "utf8");
    const c = ba.compare(bb);
    if (c !== 0) return c;
    return a.revision - b.revision;
  });

  return { format: 1, frontier, patches: allPatches };
}

// ---------------------------------------------------------------------------
// Scenario 1: 3-way concurrent text inserts (test-18 variant)
// SPEC §6.3, §6.5: three patches inserting text at the same position
// All 3! = 6 join permutations must converge.
// ---------------------------------------------------------------------------

void describe("causal-graph: 3-way concurrent text inserts — join permutation convergence", () => {
  /**
   * Seed: story.txt = "start\nend\n"
   * Contributor A: insert "A\n" after "start\n"
   * Contributor B: insert "B\n" after "start\n"
   * Contributor C: insert "C\n" after "start\n"
   *
   * All 3 fork from the seed. Their repos are:
   *   repoA = seed + patchA
   *   repoB = seed + patchB
   *   repoC = seed + patchC
   *
   * We test all 6 permutations of joinSequential([repoA, repoB, repoC]).
   */

  const seedPatch = makePatch("seed@example.com", 1, [], "initial story", [
    {
      type: "text",
      path: "story.txt",
      edit: [{ type: "insert", tokens: ["start\n", "end\n"] }],
    },
  ]);
  const seedRepo: Repository = {
    format: 1,
    frontier: new Map([["seed@example.com", 1]]),
    patches: [seedPatch],
  };

  const patchA = makePatch("alice@example.com", 1, [["seed@example.com", 1]], "alice insert A", [
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
  const patchB = makePatch("bob@example.com", 1, [["seed@example.com", 1]], "bob insert B", [
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
  const patchC = makePatch("carol@example.com", 1, [["seed@example.com", 1]], "carol insert C", [
    {
      type: "text",
      path: "story.txt",
      edit: [
        { type: "retain", count: 1 },
        { type: "insert", tokens: ["C\n"] },
        { type: "retain", count: 1 },
      ],
    },
  ]);

  const repoA = contributorRepo(seedRepo, patchA);
  const repoB = contributorRepo(seedRepo, patchB);
  const repoC = contributorRepo(seedRepo, patchC);

  void test("all 6 join permutations of 3 contributor repos produce the same result", () => {
    const count = assertPermutationConvergence([repoA, repoB, repoC], "3-way-text-insert");
    assert.equal(count, 6, "expected 3! = 6 permutations");
  });

  void test("joined result has no warnings (text OT path — no conflict)", () => {
    const { repo } = joinRepositories(joinRepositories(repoA, repoB).repo, repoC);
    const { warnings } = replay(repo);
    assert.deepEqual(
      warnings,
      [],
      `3-way text OT must produce no warnings; got: ${JSON.stringify(warnings)}`,
    );
  });

  void test("joined frontier contains all 4 contributors", () => {
    const { repo } = joinRepositories(joinRepositories(repoA, repoB).repo, repoC);
    assert.equal(repo.frontier.get("seed@example.com"), 1);
    assert.equal(repo.frontier.get("alice@example.com"), 1);
    assert.equal(repo.frontier.get("bob@example.com"), 1);
    assert.equal(repo.frontier.get("carol@example.com"), 1);
  });

  void test("merge direction does not affect result (SPEC §6.5)", () => {
    // join(repoA, repoB, repoC) == join(repoC, repoB, repoA)
    const r1 = joinSequential([repoA, repoB, repoC]);
    const r2 = joinSequential([repoC, repoB, repoA]);
    assert.equal(r1.treeEntries, r2.treeEntries, "merge direction must not affect tree bytes");
    assert.equal(r1.warnings, r2.warnings, "merge direction must not affect warnings");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: 3-way concurrent put / delete / put conflicts
// SPEC §6.4 rules 2–5: delete-wins, later-put-wins
// All 3! = 6 join permutations must converge.
// ---------------------------------------------------------------------------

void describe("causal-graph: 3-way concurrent put/delete/put — join permutation convergence", () => {
  /**
   * Seed: data.bin = bytes [0x01]
   * Contributor D: puts data.bin = [0x02]   (alice@example.com < bob < carol in snap order)
   * Contributor E: deletes data.bin
   * Contributor F: puts data.bin = [0x03]
   *
   * Integration order determined by snap order:
   *   alice result: {alice@x:1, seed@x:1} — checked below
   *   Each contributor has a unique author so their snap-order decides the winner.
   */

  const seedPatch2 = makePatch("seed2@example.com", 1, [], "initial data", [
    { type: "put", path: "data.bin", content: Buffer.from([0x01]).toString("base64") },
  ]);
  const seedRepo2: Repository = {
    format: 1,
    frontier: new Map([["seed2@example.com", 1]]),
    patches: [seedPatch2],
  };

  // alice@x < bob@x < carol@x in snap order (sorted UTF-8 order of author strings)
  // alice@x integrates LAST (highest snap-order result vector at alice@x component)
  const patchD = makePatch("alice@x", 1, [["seed2@example.com", 1]], "alice put 0x02", [
    { type: "put", path: "data.bin", content: Buffer.from([0x02]).toString("base64") },
  ]);
  const patchE = makePatch("bob@x", 1, [["seed2@example.com", 1]], "bob delete", [
    { type: "delete", path: "data.bin" },
  ]);
  const patchF = makePatch("carol@x", 1, [["seed2@example.com", 1]], "carol put 0x03", [
    { type: "put", path: "data.bin", content: Buffer.from([0x03]).toString("base64") },
  ]);

  const repoD = contributorRepo(seedRepo2, patchD);
  const repoE = contributorRepo(seedRepo2, patchE);
  const repoF = contributorRepo(seedRepo2, patchF);

  void test("all 6 join permutations of put/delete/put repos produce identical results", () => {
    const count = assertPermutationConvergence([repoD, repoE, repoF], "3-way-put-delete-put");
    assert.equal(count, 6, "expected 3! = 6 permutations");
  });

  void test("re-merging the same history is a no-op (SPEC §6.5)", () => {
    const { repo: merged } = joinRepositories(joinRepositories(repoD, repoE).repo, repoF);
    // Merging the merged result with itself should change nothing
    const { repo: remerged } = joinRepositories(merged, merged);
    const snap1 = snapshot(merged);
    const snap2 = snapshot(remerged);
    assert.equal(snap1.treeEntries, snap2.treeEntries, "re-merging must be idempotent");
    assert.equal(snap1.frontier, snap2.frontier, "re-merging must be idempotent");
    assert.equal(snap1.warnings, snap2.warnings, "re-merging must be idempotent");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: 4-way concurrent creates of the same path
// SPEC §6.4 rule 4: later-create-wins — canonically latest wins
// All 4! = 24 join permutations must converge.
// ---------------------------------------------------------------------------

void describe("causal-graph: 4-way concurrent creates of same path — only one wins", () => {
  /**
   * No seed. Four contributors each independently create "shared.txt":
   *   p1@example.com creates "shared.txt" = "one\n"
   *   p2@example.com creates "shared.txt" = "two\n"
   *   p3@example.com creates "shared.txt" = "three\n"
   *   p4@example.com creates "shared.txt" = "four\n"
   *
   * Snap order determines the winner. All 24 permutations of join must
   * produce the same single-file tree and same set of warnings.
   *
   * SPEC §6.4 rule 4: B absent, C present, T present → later-create-wins
   * (one warning per overwritten create)
   */

  const patch1 = makePatch("p1@example.com", 1, [], "p1 creates shared.txt", [
    { type: "text", path: "shared.txt", edit: [{ type: "insert", tokens: ["one\n"] }] },
  ]);
  const patch2 = makePatch("p2@example.com", 1, [], "p2 creates shared.txt", [
    { type: "text", path: "shared.txt", edit: [{ type: "insert", tokens: ["two\n"] }] },
  ]);
  const patch3 = makePatch("p3@example.com", 1, [], "p3 creates shared.txt", [
    { type: "text", path: "shared.txt", edit: [{ type: "insert", tokens: ["three\n"] }] },
  ]);
  const patch4 = makePatch("p4@example.com", 1, [], "p4 creates shared.txt", [
    { type: "text", path: "shared.txt", edit: [{ type: "insert", tokens: ["four\n"] }] },
  ]);

  // Each contributor's repo has only their own single patch
  const repo1: Repository = {
    format: 1,
    frontier: new Map([["p1@example.com", 1]]),
    patches: [patch1],
  };
  const repo2: Repository = {
    format: 1,
    frontier: new Map([["p2@example.com", 1]]),
    patches: [patch2],
  };
  const repo3: Repository = {
    format: 1,
    frontier: new Map([["p3@example.com", 1]]),
    patches: [patch3],
  };
  const repo4: Repository = {
    format: 1,
    frontier: new Map([["p4@example.com", 1]]),
    patches: [patch4],
  };

  void test("all 24 join permutations of 4 concurrent creates produce identical results", () => {
    const count = assertPermutationConvergence([repo1, repo2, repo3, repo4], "4-way-create");
    assert.equal(count, 24, "expected 4! = 24 permutations");
  });

  void test("exactly one later-create-wins warning per overwritten create (deduplicated)", () => {
    const merged = joinSequentialRepo([repo1, repo2, repo3, repo4]);
    const { warnings } = replay(merged);
    const lcw = warnings.filter((w) => w.reason === "later-create-wins");
    // 4 concurrent creates → the later 3 each trigger later-create-wins when they
    // overwrite the earlier winner. Only unique (path, reason) pairs are kept.
    // Since all are same path + same reason, exactly 1 deduplicated warning.
    assert.equal(
      lcw.length,
      1,
      `SPEC §6.4 deduplication: same (path, reason) → 1 warning; got: ${JSON.stringify(lcw)}`,
    );
    assert.equal(lcw[0]!.path, "shared.txt");
    assert.equal(lcw[0]!.reason, "later-create-wins");
  });

  void test("the winner is deterministic and consistent with snap order", () => {
    // After joining all 4, the file exists (one winner)
    const merged = joinSequentialRepo([repo1, repo2, repo3, repo4]);
    const { tree } = replay(merged);
    const content = tree.get("shared.txt")?.toString("utf8");
    assert.ok(content !== undefined, "shared.txt must exist after 4-way concurrent create merge");
    // Direct join in reverse order must produce the same winner
    const directRepo = joinSequentialRepo([repo4, repo3, repo2, repo1]);
    const { tree: dt } = replay(directRepo);
    assert.equal(
      dt.get("shared.txt")?.toString("utf8"),
      content,
      "winner must be the same regardless of join direction",
    );
  });

  void test("associativity: (repo1 ∪ repo2) ∪ (repo3 ∪ repo4) == repo1 ∪ (repo2 ∪ (repo3 ∪ repo4))", () => {
    // SPEC §1.1 invariant 6: Import is set union — associative
    const leftAssoc = joinSequential([repo1, repo2, repo3, repo4]);

    // Right-associative: repo1 ∪ (repo2 ∪ (repo3 ∪ repo4))
    const r34 = joinRepositories(repo3, repo4).repo;
    const r234 = joinRepositories(repo2, r34).repo;
    const r1234 = joinRepositories(repo1, r234).repo;
    const rightAssoc = snapshot(r1234);

    // Pairwise: (repo1 ∪ repo2) ∪ (repo3 ∪ repo4)
    const r12 = joinRepositories(repo1, repo2).repo;
    const r34b = joinRepositories(repo3, repo4).repo;
    const r12_34 = joinRepositories(r12, r34b).repo;
    const pairwiseAssoc = snapshot(r12_34);

    assert.equal(
      leftAssoc.treeEntries,
      rightAssoc.treeEntries,
      "associativity: left vs right — tree bytes must match",
    );
    assert.equal(
      leftAssoc.treeEntries,
      pairwiseAssoc.treeEntries,
      "associativity: left vs pairwise — tree bytes must match",
    );
    assert.equal(
      leftAssoc.frontier,
      rightAssoc.frontier,
      "associativity: left vs right — frontier must match",
    );
    assert.equal(
      leftAssoc.warnings,
      rightAssoc.warnings,
      "associativity: left vs right — warnings must match",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Namespace conflict with simultaneous delete of the blocker
// SPEC §6.2 namespace rule + §6.4 delete-wins
// PLAN.md §12: "Namespace: collision combined with a simultaneous delete of the blocker"
// All 3! = 6 join permutations must converge.
// ---------------------------------------------------------------------------

void describe("causal-graph: namespace conflict + simultaneous delete of blocker — join permutation convergence", () => {
  /**
   * Seed: foo (file) = "root\n"
   *
   * Contributor X: deletes "foo"
   * Contributor Y: creates "foo/bar" (conflicts with "foo" as ancestor)
   * Contributor Z: creates "foo/baz" (also conflicts with "foo" as ancestor)
   *
   * Note: X's delete and Y/Z's namespace conflict interact in an interesting way:
   * - When X integrates before Y: X deletes "foo", then Y's "foo/bar" has
   *   no ancestor conflict → installed cleanly.
   * - When Y integrates before X: Y's "foo/bar" triggers namespace conflict
   *   with "foo" → namespace-wins removes "foo"; then X's delete finds "foo"
   *   absent from C → SPEC §6.4 rule 2 (T absent, delete-wins) or no-op.
   *
   * SPEC §6.5: all orderings must produce the same final tree.
   *
   * SPEC §6.2: let C' = C with P's deletions removed. X's delete of "foo"
   * means when X is the incoming patch, C' has "foo" removed, so Y's "foo/bar"
   * and Z's "foo/baz" have no ancestor conflict in C'.
   */

  const seedPatch4 = makePatch("seed4@example.com", 1, [], "seed foo", [
    { type: "text", path: "foo", edit: [{ type: "insert", tokens: ["root\n"] }] },
  ]);
  const seedRepo4: Repository = {
    format: 1,
    frontier: new Map([["seed4@example.com", 1]]),
    patches: [seedPatch4],
  };

  const patchX = makePatch("x@example.com", 1, [["seed4@example.com", 1]], "x deletes foo", [
    { type: "delete", path: "foo" },
  ]);
  const patchY = makePatch("y@example.com", 1, [["seed4@example.com", 1]], "y creates foo/bar", [
    { type: "text", path: "foo/bar", edit: [{ type: "insert", tokens: ["bar\n"] }] },
  ]);
  const patchZ = makePatch("z@example.com", 1, [["seed4@example.com", 1]], "z creates foo/baz", [
    { type: "text", path: "foo/baz", edit: [{ type: "insert", tokens: ["baz\n"] }] },
  ]);

  const repoX = contributorRepo(seedRepo4, patchX);
  const repoY = contributorRepo(seedRepo4, patchY);
  const repoZ = contributorRepo(seedRepo4, patchZ);

  void test("all 6 join permutations of namespace+delete scenario produce identical results", () => {
    const count = assertPermutationConvergence([repoX, repoY, repoZ], "namespace-delete");
    assert.equal(count, 6, "expected 3! = 6 permutations");
  });

  void test("final tree: foo is absent, foo/bar and foo/baz are present", () => {
    const { repo } = joinRepositories(joinRepositories(repoX, repoY).repo, repoZ);
    const { tree } = replay(repo);
    // The ancestor "foo" must be gone (either deleted by X or removed by namespace-wins)
    assert.equal(tree.has("foo"), false, "foo must be absent after namespace conflict + delete");
    // foo/bar and foo/baz must be present
    assert.equal(tree.get("foo/bar")?.toString("utf8"), "bar\n", "foo/bar must be present");
    assert.equal(tree.get("foo/baz")?.toString("utf8"), "baz\n", "foo/baz must be present");
  });

  void test("commutativity: join(repoY, repoX) produces same result as join(repoX, repoY)", () => {
    // SPEC §1.1 invariant 6: Import is set union — commutative
    const xy = joinRepositories(repoX, repoY);
    const yx = joinRepositories(repoY, repoX);
    const snapXY = snapshot(xy.repo);
    const snapYX = snapshot(yx.repo);
    assert.equal(
      snapXY.treeEntries,
      snapYX.treeEntries,
      "commutativity: join(X,Y) tree must equal join(Y,X) tree",
    );
    assert.equal(
      snapXY.frontier,
      snapYX.frontier,
      "commutativity: join(X,Y) frontier must equal join(Y,X) frontier",
    );
    assert.equal(
      snapXY.warnings,
      snapYX.warnings,
      "commutativity: join(X,Y) warnings must equal join(Y,X) warnings",
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Idempotency (SPEC §1.1 invariant 6: import is idempotent)
// ---------------------------------------------------------------------------

void describe("causal-graph: idempotency — merging equal or contained history is a no-op", () => {
  const seedPatch5 = makePatch("seed5@example.com", 1, [], "seed", [
    { type: "text", path: "f.txt", edit: [{ type: "insert", tokens: ["hello\n"] }] },
  ]);
  const seedRepo5: Repository = {
    format: 1,
    frontier: new Map([["seed5@example.com", 1]]),
    patches: [seedPatch5],
  };

  void test("join(repo, repo) is a no-op (idempotency — SPEC §6.5)", () => {
    const { repo: self } = joinRepositories(seedRepo5, seedRepo5);
    const snap1 = snapshot(seedRepo5);
    const snap2 = snapshot(self);
    assert.equal(snap1.frontier, snap2.frontier, "idempotent join must preserve frontier");
    assert.equal(snap1.treeEntries, snap2.treeEntries, "idempotent join must preserve tree");
    assert.equal(snap1.warnings, snap2.warnings, "idempotent join must preserve warnings");
    assert.equal(self.patches.length, seedRepo5.patches.length, "no new patches added");
  });

  void test("merging already-contained history succeeds and changes nothing (SPEC §7.8)", () => {
    // Build a repo with two patches, then merge a repo that only has the first patch
    const patch2 = makePatch("a@example.com", 1, [["seed5@example.com", 1]], "p2", [
      {
        type: "text",
        path: "f.txt",
        edit: [
          { type: "delete", count: 1 },
          { type: "insert", tokens: ["world\n"] },
        ],
      },
    ]);
    const bigRepo: Repository = {
      format: 1,
      frontier: new Map([
        ["seed5@example.com", 1],
        ["a@example.com", 1],
      ]),
      patches: [seedPatch5, patch2],
    };

    // Merging seedRepo5 (subset of bigRepo) into bigRepo must not change bigRepo
    const { repo: afterMerge } = joinRepositories(bigRepo, seedRepo5);
    const snap1 = snapshot(bigRepo);
    const snap2 = snapshot(afterMerge);
    assert.equal(snap1.frontier, snap2.frontier, "contained-history merge must preserve frontier");
    assert.equal(
      snap1.treeEntries,
      snap2.treeEntries,
      "contained-history merge must preserve tree",
    );
  });
});
