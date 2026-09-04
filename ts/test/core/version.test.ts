/**
 * Unit tests for core/version.ts
 * Node.js built-in test runner (node:test + node:assert/strict)
 * SPEC §3.1–3.5
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersion,
  formatVersion,
  compareVersions,
  joinVectors,
  snapOrder,
  parseVersionString,
  formatVersionString,
  compareVectors,
  type VersionVector,
} from "../../src/core/version.js";
import { SnapError } from "../../src/errors.js";

function throwsSnapError(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert.ok(e instanceof SnapError, `expected SnapError, got ${String(e)}`);
  }
  assert.ok(threw, "expected function to throw SnapError");
}

function makeVector(entries: [string, number][]): VersionVector {
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// parseVersion (single dot notation "author->revision")
// ---------------------------------------------------------------------------

void describe("parseVersion — valid", () => {
  void test("simple author->revision", () => {
    const v = parseVersion("alice@example.com->1");
    assert.equal(v.author, "alice@example.com");
    assert.equal(v.revision, 1);
  });

  void test("large revision", () => {
    const v = parseVersion("bob@x->9007199254740991");
    assert.equal(v.revision, 9007199254740991);
  });

  void test("revision 1 (minimum valid)", () => {
    const v = parseVersion("a@b->1");
    assert.equal(v.revision, 1);
  });
});

void describe("parseVersion — invalid", () => {
  void test("no arrow", () => {
    throwsSnapError(() => parseVersion("alice@example.com"));
  });

  void test("revision 0 (not positive)", () => {
    throwsSnapError(() => parseVersion("alice@example.com->0"));
  });

  void test("leading zero in revision", () => {
    throwsSnapError(() => parseVersion("alice@example.com->01"));
  });

  void test("negative revision", () => {
    throwsSnapError(() => parseVersion("alice@example.com->-1"));
  });

  void test("non-numeric revision", () => {
    throwsSnapError(() => parseVersion("alice@example.com->abc"));
  });

  void test("overflow revision", () => {
    throwsSnapError(() => parseVersion("alice@example.com->9007199254740992"));
  });

  void test("invalid contributor ID (no @)", () => {
    throwsSnapError(() => parseVersion("alice->1"));
  });
});

// ---------------------------------------------------------------------------
// formatVersion
// ---------------------------------------------------------------------------

void describe("formatVersion", () => {
  void test("formats to 'author->revision'", () => {
    assert.equal(
      formatVersion({ author: "alice@example.com", revision: 42 }),
      "alice@example.com->42",
    );
  });

  void test("formats MAX_SAFE_INTEGER revision", () => {
    assert.equal(
      formatVersion({ author: "a@b", revision: 9007199254740991 }),
      "a@b->9007199254740991",
    );
  });
});

// ---------------------------------------------------------------------------
// parseVersionString — valid
// ---------------------------------------------------------------------------

void describe("parseVersionString — valid", () => {
  void test("empty version '()'", () => {
    const v = parseVersionString("()");
    assert.equal(v.size, 0);
  });

  void test("single entry", () => {
    const v = parseVersionString("(alice@x->1)");
    assert.equal(v.size, 1);
    assert.equal(v.get("alice@x"), 1);
  });

  void test("multiple entries, already sorted", () => {
    const v = parseVersionString("(alice@x->2,bob@x->3)");
    assert.equal(v.size, 2);
    assert.equal(v.get("alice@x"), 2);
    assert.equal(v.get("bob@x"), 3);
  });

  void test("spec example: two contributors", () => {
    const v = parseVersionString("(jdegoes@example.com->2323,vigoo@example.com->239)");
    assert.equal(v.size, 2);
    assert.equal(v.get("jdegoes@example.com"), 2323);
    assert.equal(v.get("vigoo@example.com"), 239);
  });

  void test("revision MAX_SAFE_INTEGER", () => {
    const v = parseVersionString("(a@b->9007199254740991)");
    assert.equal(v.get("a@b"), 9007199254740991);
  });
});

// ---------------------------------------------------------------------------
// parseVersionString — invalid
// ---------------------------------------------------------------------------

void describe("parseVersionString — invalid", () => {
  void test("missing outer parens", () => {
    throwsSnapError(() => parseVersionString("alice@x->1"));
  });

  void test("leading zero in revision", () => {
    throwsSnapError(() => parseVersionString("(alice@x->01)"));
  });

  void test("revision 0 (explicit zero)", () => {
    throwsSnapError(() => parseVersionString("(alice@x->0)"));
  });

  void test("duplicate IDs", () => {
    throwsSnapError(() => parseVersionString("(alice@x->1,alice@x->2)"));
  });

  void test("wrong order (non-canonical)", () => {
    // bob@x->3 comes after alice@x->2 in byte order, so (bob,alice) is non-canonical
    throwsSnapError(() => parseVersionString("(bob@x->3,alice@x->2)"));
  });

  void test("whitespace in string", () => {
    throwsSnapError(() => parseVersionString("(alice@x->1, bob@x->2)"));
  });

  void test("overflow revision", () => {
    throwsSnapError(() => parseVersionString("(a@b->9007199254740992)"));
  });

  void test("missing closing paren", () => {
    throwsSnapError(() => parseVersionString("(alice@x->1"));
  });

  void test("missing opening paren", () => {
    throwsSnapError(() => parseVersionString("alice@x->1)"));
  });

  void test("invalid contributor ID in version string", () => {
    throwsSnapError(() => parseVersionString("(noemail->1)"));
  });

  void test("empty entry (trailing comma)", () => {
    throwsSnapError(() => parseVersionString("(alice@x->1,)"));
  });

  void test("two entries in non-canonical order", () => {
    // 'z@x->1' sorts before 'alice@x->2' would be wrong — actually:
    // 'alice@x->2' starts with 'a' (0x61), 'z@x->1' starts with 'z' (0x7A)
    // So alice < z in byte order; (z, alice) is non-canonical
    throwsSnapError(() => parseVersionString("(z@x->1,alice@x->2)"));
  });
});

// ---------------------------------------------------------------------------
// formatVersionString
// ---------------------------------------------------------------------------

void describe("formatVersionString — canonical output", () => {
  void test("empty vector produces '()'", () => {
    assert.equal(formatVersionString(new Map()), "()");
  });

  void test("single entry", () => {
    assert.equal(formatVersionString(makeVector([["alice@x", 1]])), "(alice@x->1)");
  });

  void test("two entries, sorted correctly", () => {
    // alice@x->2 should come before bob@x->3 in byte order
    const result = formatVersionString(
      makeVector([
        ["bob@x", 3],
        ["alice@x", 2],
      ]),
    );
    assert.equal(result, "(alice@x->2,bob@x->3)");
  });

  void test("spec example", () => {
    const result = formatVersionString(
      makeVector([
        ["vigoo@example.com", 239],
        ["jdegoes@example.com", 2323],
      ]),
    );
    assert.equal(result, "(jdegoes@example.com->2323,vigoo@example.com->239)");
  });

  void test("round-trip: parse then format returns same string", () => {
    const s = "(alice@x->1,bob@x->2)";
    assert.equal(formatVersionString(parseVersionString(s)), s);
  });

  void test("round-trip empty", () => {
    assert.equal(formatVersionString(parseVersionString("()")), "()");
  });
});

// ---------------------------------------------------------------------------
// compareVersions (single-entry)
// ---------------------------------------------------------------------------

void describe("compareVersions — single-entry", () => {
  void test("same author, same revision → 0", () => {
    assert.equal(
      compareVersions({ author: "a@x", revision: 1 }, { author: "a@x", revision: 1 }),
      0,
    );
  });

  void test("same author, lower revision → -1", () => {
    assert.equal(
      compareVersions({ author: "a@x", revision: 1 }, { author: "a@x", revision: 2 }),
      -1,
    );
  });

  void test("same author, higher revision → 1", () => {
    assert.equal(
      compareVersions({ author: "a@x", revision: 5 }, { author: "a@x", revision: 2 }),
      1,
    );
  });

  void test("different authors → concurrent", () => {
    assert.equal(
      compareVersions({ author: "a@x", revision: 1 }, { author: "b@x", revision: 1 }),
      "concurrent",
    );
  });
});

// ---------------------------------------------------------------------------
// compareVectors — 4-way causal comparison (SPEC §3.3)
// ---------------------------------------------------------------------------

void describe("compareVectors — equal", () => {
  void test("both empty → 0", () => {
    assert.equal(compareVectors(new Map(), new Map()), 0);
  });

  void test("same single entry → 0", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), makeVector([["a@x", 1]])), 0);
  });

  void test("same two entries → 0", () => {
    const a = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    const b = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    assert.equal(compareVectors(a, b), 0);
  });
});

void describe("compareVectors — less than (-1)", () => {
  void test("subset: {} < {a:1}", () => {
    assert.equal(compareVectors(new Map(), makeVector([["a@x", 1]])), -1);
  });

  void test("{a:1} < {a:2}", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), makeVector([["a@x", 2]])), -1);
  });

  void test("{a:1} < {a:1,b:1}", () => {
    assert.equal(
      compareVectors(
        makeVector([["a@x", 1]]),
        makeVector([
          ["a@x", 1],
          ["b@x", 1],
        ]),
      ),
      -1,
    );
  });

  void test("{a:1,b:2} < {a:2,b:3}", () => {
    assert.equal(
      compareVectors(
        makeVector([
          ["a@x", 1],
          ["b@x", 2],
        ]),
        makeVector([
          ["a@x", 2],
          ["b@x", 3],
        ]),
      ),
      -1,
    );
  });
});

void describe("compareVectors — greater than (1)", () => {
  void test("{a:1} > {}", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), new Map()), 1);
  });

  void test("{a:2} > {a:1}", () => {
    assert.equal(compareVectors(makeVector([["a@x", 2]]), makeVector([["a@x", 1]])), 1);
  });
});

void describe("compareVectors — concurrent", () => {
  void test("{a:1} || {b:1}", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), makeVector([["b@x", 1]])), "concurrent");
  });

  void test("{a:2,b:1} || {a:1,b:2}", () => {
    assert.equal(
      compareVectors(
        makeVector([
          ["a@x", 2],
          ["b@x", 1],
        ]),
        makeVector([
          ["a@x", 1],
          ["b@x", 2],
        ]),
      ),
      "concurrent",
    );
  });

  void test("{a:1,b:1} || {a:1,c:1}", () => {
    // a:1 same, b:1>0 (a has more), c:0<1 (b has more) → concurrent
    assert.equal(
      compareVectors(
        makeVector([
          ["a@x", 1],
          ["b@x", 1],
        ]),
        makeVector([
          ["a@x", 1],
          ["c@x", 1],
        ]),
      ),
      "concurrent",
    );
  });
});

// ---------------------------------------------------------------------------
// joinVectors — SPEC §3.3 join laws
// ---------------------------------------------------------------------------

void describe("joinVectors — element-wise max", () => {
  void test("join of two empties is empty", () => {
    const j = joinVectors(new Map(), new Map());
    assert.equal(j.size, 0);
  });

  void test("join with empty is identity", () => {
    const a = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    const j = joinVectors(a, new Map());
    assert.deepEqual([...j], [...a]);
  });

  void test("join({a:1},{a:2}) = {a:2}", () => {
    const j = joinVectors(makeVector([["a@x", 1]]), makeVector([["a@x", 2]]));
    assert.equal(j.get("a@x"), 2);
  });

  void test("join({a:2},{a:1}) = {a:2}", () => {
    const j = joinVectors(makeVector([["a@x", 2]]), makeVector([["a@x", 1]]));
    assert.equal(j.get("a@x"), 2);
  });

  void test("join of disjoint vectors includes all entries", () => {
    const j = joinVectors(makeVector([["a@x", 1]]), makeVector([["b@x", 2]]));
    assert.equal(j.get("a@x"), 1);
    assert.equal(j.get("b@x"), 2);
  });

  void test("join({a:3,b:1},{a:1,b:4}) = {a:3,b:4}", () => {
    const j = joinVectors(
      makeVector([
        ["a@x", 3],
        ["b@x", 1],
      ]),
      makeVector([
        ["a@x", 1],
        ["b@x", 4],
      ]),
    );
    assert.equal(j.get("a@x"), 3);
    assert.equal(j.get("b@x"), 4);
  });
});

void describe("joinVectors — algebraic laws", () => {
  function vectorsEqual(a: VersionVector, b: VersionVector): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (b.get(k) !== v) return false;
    }
    return true;
  }

  const v1 = makeVector([
    ["a@x", 1],
    ["b@x", 3],
  ]);
  const v2 = makeVector([
    ["a@x", 2],
    ["c@x", 1],
  ]);
  const v3 = makeVector([
    ["b@x", 4],
    ["c@x", 2],
  ]);

  void test("idempotent: join(v,v) = v", () => {
    assert.ok(vectorsEqual(joinVectors(v1, v1), v1));
  });

  void test("commutative: join(a,b) = join(b,a)", () => {
    assert.ok(vectorsEqual(joinVectors(v1, v2), joinVectors(v2, v1)));
  });

  void test("associative: join(join(a,b),c) = join(a,join(b,c))", () => {
    const left = joinVectors(joinVectors(v1, v2), v3);
    const right = joinVectors(v1, joinVectors(v2, v3));
    assert.ok(vectorsEqual(left, right));
  });

  void test("join is monotone: v <= join(v, w)", () => {
    const j = joinVectors(v1, v2);
    // Every entry of v1 is <= j
    for (const [k, rv] of v1) {
      assert.ok((j.get(k) ?? 0) >= rv, `key ${k}`);
    }
    // Every entry of v2 is <= j
    for (const [k, rv] of v2) {
      assert.ok((j.get(k) ?? 0) >= rv, `key ${k}`);
    }
  });
});

// ---------------------------------------------------------------------------
// snapOrder — SPEC §3.4
// ---------------------------------------------------------------------------

void describe("snapOrder", () => {
  void test("equal vectors → 0", () => {
    const a = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    assert.equal(snapOrder(a, a), 0);
  });

  void test("both empty → 0", () => {
    assert.equal(snapOrder(new Map(), new Map()), 0);
  });

  void test("PLAN §7.5 rule 1: [0,1] < [1,0]", () => {
    // From PLAN.md §7.5 rule 1: "bob always integrates before alice ([0,1] < [1,0])"
    // In snap order context: two vectors with sorted IDs [alice, bob]:
    //   [0,1] means alice=0, bob=1
    //   [1,0] means alice=1, bob=0
    // Sorted IDs: alice < bob (byte order). Compare alice's counter first: 0 < 1, so [0,1] < [1,0]
    const aliceX = "alice@x";
    const bobX = "bob@x";
    // Verify sorted order: alice < bob in byte order
    const bufAlice = Buffer.from(aliceX, "utf8");
    const bufBob = Buffer.from(bobX, "utf8");
    assert.ok(bufAlice.compare(bufBob) < 0, "alice < bob in byte order");

    // [0,1]: alice=0 (absent), bob=1
    const vec01 = makeVector([[bobX, 1]]);
    // [1,0]: alice=1, bob=0 (absent)
    const vec10 = makeVector([[aliceX, 1]]);

    // alice's counter: vec01 has 0, vec10 has 1 → first difference at alice → vec01 < vec10
    assert.equal(snapOrder(vec01, vec10), -1, "[0,1] < [1,0]");
    assert.equal(snapOrder(vec10, vec01), 1, "[1,0] > [0,1]");
  });

  void test("single contributor, lower revision < higher", () => {
    assert.equal(snapOrder(makeVector([["a@x", 1]]), makeVector([["a@x", 2]])), -1);
  });

  void test("single contributor, higher revision > lower", () => {
    assert.equal(snapOrder(makeVector([["a@x", 2]]), makeVector([["a@x", 1]])), 1);
  });

  void test("first differing key determines order", () => {
    // Sorted IDs: a@x < b@x; a has 1 vs 2 → -1
    assert.equal(
      snapOrder(
        makeVector([
          ["a@x", 1],
          ["b@x", 5],
        ]),
        makeVector([
          ["a@x", 2],
          ["b@x", 1],
        ]),
      ),
      -1,
    );
  });

  void test("snap order is total (antisymmetric): a<b => not b<a", () => {
    const a = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    const b = makeVector([
      ["a@x", 2],
      ["b@x", 1],
    ]);
    const ab = snapOrder(a, b);
    const ba = snapOrder(b, a);
    // They should be opposite signs
    assert.ok(ab !== 0 || ba === 0);
    if (ab === -1) assert.equal(ba, 1);
    if (ab === 1) assert.equal(ba, -1);
  });

  void test("all four comparison outcomes exist in snap order context", () => {
    // snap order is total: -1, 0, 1 are the only outcomes
    // Test that concurrent vectors (in causal terms) have a determined snap order
    const a = makeVector([
      ["a@x", 2],
      ["b@x", 1],
    ]);
    const b = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    // Causally concurrent, but snapOrder must return -1 or 1, not 0
    const causal = compareVectors(a, b);
    assert.equal(causal, "concurrent", "vectors are causally concurrent");
    const snap = snapOrder(a, b);
    assert.ok(
      snap === -1 || snap === 1,
      `snap order of concurrent vectors must be -1 or 1, got ${snap}`,
    );
  });

  void test("snap order of empty vs non-empty: empty has all zeros", () => {
    // empty = all zeros, {a:1} has a=1 > 0 → empty < {a:1}
    assert.equal(snapOrder(new Map(), makeVector([["a@x", 1]])), -1);
    assert.equal(snapOrder(makeVector([["a@x", 1]]), new Map()), 1);
  });
});

// ---------------------------------------------------------------------------
// Revision boundary tests (PLAN.md §12)
// ---------------------------------------------------------------------------

void describe("revision boundary tests", () => {
  void test("revision exactly 9007199254740991 is valid (MAX_SAFE_INTEGER)", () => {
    const v = parseVersion("a@b->9007199254740991");
    assert.equal(v.revision, 9007199254740991);
  });

  void test("revision 9007199254740992 is invalid (overflow)", () => {
    throwsSnapError(() => parseVersion("a@b->9007199254740992"));
  });

  void test("in version string: MAX_SAFE_INTEGER is valid", () => {
    const s = "(a@b->9007199254740991)";
    const v = parseVersionString(s);
    assert.equal(v.get("a@b"), 9007199254740991);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

void describe("version string edge cases", () => {
  void test("only whitespace in parens is invalid", () => {
    throwsSnapError(() => parseVersionString("( )"));
  });

  void test("entry with only arrow is invalid", () => {
    throwsSnapError(() => parseVersionString("(->1)"));
  });

  void test("equal single-entry vectors", () => {
    const a = makeVector([["a@x", 5]]);
    const b = makeVector([["a@x", 5]]);
    assert.equal(compareVectors(a, b), 0);
    assert.equal(snapOrder(a, b), 0);
  });
});
