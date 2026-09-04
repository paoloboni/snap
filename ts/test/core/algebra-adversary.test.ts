/**
 * Algebra Adversary — Phase 2 adversarial tests for core/version.ts,
 * core/contributor.ts, and core/path.ts
 *
 * RULES:
 * - Every test cites a SPEC.md line range.
 * - At least one test is expected to FAIL against the current implementation,
 *   revealing a real spec violation.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVersionString,
  formatVersionString,
  snapOrder,
  joinVectors,
  compareVectors,
  type VersionVector,
} from "../../src/core/version.js";
import { validateContributorId } from "../../src/core/contributor.js";
import { validatePath, isPrefix } from "../../src/core/path.js";
import { SnapError } from "../../src/errors.js";

function throwsSnapError(fn: () => void, label = ""): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert.ok(e instanceof SnapError, `expected SnapError, got ${String(e)} [${label}]`);
  }
  assert.ok(threw, `expected function to throw SnapError [${label}]`);
}

function makeVector(entries: [string, number][]): VersionVector {
  return new Map(entries);
}

// ===========================================================================
// ADV-A-001 — path.ts: DEL (0x7F) is an ASCII control character (SPEC §2)
// SPEC §2 lines 67–71: "contain no ASCII control character or backslash"
// DEL (U+007F, 0x7F) is universally classified as an ASCII control character.
// The implementation only checks `code < 0x20`, missing 0x7F entirely.
// This test is expected to FAIL (current code accepts the DEL character).
// ===========================================================================

void describe("ADV-A-001 path: DEL (0x7F) must be rejected (SPEC §2:67-71)", () => {
  void test("DEL in middle of path must be rejected", () => {
    // 0x7F is ASCII DEL — a control character. SPEC §2 forbids it.
    // Current validatePath only checks code < 0x20, so 0x7F passes through.
    throwsSnapError(() => validatePath("a\x7fb"), "DEL in middle");
  });

  void test("DEL at start of path must be rejected", () => {
    throwsSnapError(() => validatePath("\x7fabc"), "DEL at start");
  });

  void test("DEL at end of path must be rejected", () => {
    throwsSnapError(() => validatePath("abc\x7f"), "DEL at end");
  });

  void test("standalone DEL must be rejected", () => {
    throwsSnapError(() => validatePath("\x7f"), "standalone DEL");
  });
});

// ===========================================================================
// ADV-A-002 — path.ts: isPrefix(prefix, p) where prefix === p
// SPEC §2:73-75: prefix-free by path segment.
// isPrefix("a", "a") must return true (same path is a prefix of itself).
// This is a correctness verification test.
// ===========================================================================

void describe("ADV-A-002 path: isPrefix same-path identity (SPEC §2:73-75)", () => {
  void test('isPrefix("a","a") === true', () => {
    assert.equal(isPrefix("a", "a"), true);
  });

  void test('isPrefix("a/b","a/b") === true', () => {
    assert.equal(isPrefix("a/b", "a/b"), true);
  });

  void test('isPrefix("a/b","a") === false (longer prefix, shorter path)', () => {
    assert.equal(isPrefix("a/b", "a"), false);
  });

  void test('isPrefix("a","a/b") === true (parent of child)', () => {
    assert.equal(isPrefix("a", "a/b"), true);
  });

  void test('isPrefix("a/b","a") is false, not symmetric with isPrefix("a","a/b")', () => {
    assert.equal(isPrefix("a", "a/b"), true);
    assert.equal(isPrefix("a/b", "a"), false);
  });
});

// ===========================================================================
// ADV-A-003 — path.ts: ".snap" as sole first segment must be rejected,
// but ".snapshots" must be accepted (SPEC §2:69).
// ===========================================================================

void describe("ADV-A-003 path: .snap boundary (SPEC §2:67-71)", () => {
  void test('".snap" as full path must be rejected', () => {
    throwsSnapError(() => validatePath(".snap"), ".snap as full path");
  });

  void test('".snap/foo" must be rejected (first segment is .snap)', () => {
    throwsSnapError(() => validatePath(".snap/foo"), ".snap prefix");
  });

  void test('".snapshots/foo" must be accepted (first segment is .snapshots, not .snap)', () => {
    // ".snapshots" !== ".snap", so this must be valid
    assert.doesNotThrow(() => validatePath(".snapshots/foo"));
  });

  void test('".snapper" as first segment must be accepted', () => {
    assert.doesNotThrow(() => validatePath(".snapper/config"));
  });
});

// ===========================================================================
// ADV-A-004 — contributor.ts: exactly 254-byte boundary (SPEC §3.1:91-93)
// SPEC §3.1: "at most 254 bytes".
// 254 bytes → valid. 255 bytes → invalid.
// ===========================================================================

void describe("ADV-A-004 contributor: 254-byte boundary (SPEC §3.1:91-93)", () => {
  void test("exactly 254 bytes is valid", () => {
    // 123 'a' chars + '@' + 130 'b' chars = 254 bytes
    const id = "a".repeat(123) + "@" + "b".repeat(130);
    assert.equal(Buffer.byteLength(id, "utf8"), 254);
    assert.doesNotThrow(() => validateContributorId(id));
  });

  void test("exactly 255 bytes is invalid", () => {
    // 124 'a' chars + '@' + 130 'b' chars = 255 bytes
    const id = "a".repeat(124) + "@" + "b".repeat(130);
    assert.equal(Buffer.byteLength(id, "utf8"), 255);
    throwsSnapError(() => validateContributorId(id), "255-byte ID");
  });
});

// ===========================================================================
// ADV-A-005 — contributor.ts: no whitespace means ALL whitespace characters
// SPEC §3.1:91: "contain no control character, whitespace"
// Tab (0x09), LF (0x0A), CR (0x0D), and VT (0x0B), FF (0x0C) must all be
// rejected.
// ===========================================================================

void describe("ADV-A-005 contributor: whitespace variants (SPEC §3.1:88-93)", () => {
  void test("tab (0x09) must be rejected", () => {
    throwsSnapError(() => validateContributorId("a\x09b@host.com"), "tab");
  });

  void test("LF (0x0A) must be rejected", () => {
    throwsSnapError(() => validateContributorId("a\x0ab@host.com"), "LF");
  });

  void test("CR (0x0D) must be rejected", () => {
    throwsSnapError(() => validateContributorId("a\x0db@host.com"), "CR");
  });

  void test("VT (0x0B) must be rejected", () => {
    throwsSnapError(() => validateContributorId("a\x0bb@host.com"), "VT");
  });

  void test("FF (0x0C) must be rejected", () => {
    throwsSnapError(() => validateContributorId("a\x0cb@host.com"), "FF");
  });

  void test("non-breaking space (U+00A0) must be rejected (non-ASCII)", () => {
    // U+00A0 encodes as 0xC2 0xA0 in UTF-8; charCodeAt returns 160 > 0x7E
    throwsSnapError(() => validateContributorId("a\u00a0b@host.com"), "NBSP");
  });
});

// ===========================================================================
// ADV-A-006 — contributor.ts: -> substring (SPEC §3.1:91)
// "->" must be forbidden anywhere in the ID.
// ===========================================================================

void describe("ADV-A-006 contributor: -> substring (SPEC §3.1:88-93)", () => {
  void test("'a->b@host' must be rejected", () => {
    throwsSnapError(() => validateContributorId("a->b@host"), "->");
  });

  void test("'user->x@host' must be rejected", () => {
    throwsSnapError(() => validateContributorId("user->x@host"), "user->x");
  });

  void test("'user@ho->st' must be rejected (-> in domain)", () => {
    throwsSnapError(() => validateContributorId("user@ho->st"), "-> in domain");
  });
});

// ===========================================================================
// ADV-A-007 — version.ts: parseVersionString ordering is by full entry string
// SPEC §3.2:100-101 (and §3.3 implies sorting by UTF-8 bytes of full entry)
// Verify that parseVersionString requires the full "id->revision" string to be
// in ascending UTF-8 byte order (not just the IDs).
// Key case: two IDs that would sort the same way both by ID and by full entry.
// Verify a string that is in correct full-entry order but where the IDs would
// also be in the same order — should be ACCEPTED.
// Also verify a string that is in WRONG full-entry order — should be REJECTED.
// ===========================================================================

void describe("ADV-A-007 version: parseVersionString full-entry sort order (SPEC §3.2:100-101)", () => {
  void test("(a@x->2,a@xa->1) — correct full-entry order must be accepted", () => {
    // Full entries: "a@x->2" vs "a@xa->1"
    // Byte comparison: at position 3: '-' (0x2D) vs 'a' (0x61), 0x2D < 0x61
    // So "a@x->2" < "a@xa->1": correct canonical order → must parse OK
    const v = parseVersionString("(a@x->2,a@xa->1)");
    assert.equal(v.size, 2);
    assert.equal(v.get("a@x"), 2);
    assert.equal(v.get("a@xa"), 1);
  });

  void test("(a@xa->1,a@x->2) — wrong full-entry order must be rejected", () => {
    // "a@xa->1" > "a@x->2" by byte order, so this is noncanonical → must reject
    throwsSnapError(() => parseVersionString("(a@xa->1,a@x->2)"), "wrong full-entry order");
  });

  void test("(a@x->10,b@x->1) — 'a' < 'b' means a@x->10 comes first — accepted", () => {
    // "a@x->10" starts with 'a' (0x61); "b@x->1" starts with 'b' (0x62)
    // 0x61 < 0x62, so a@x->10 < b@x->1: correct order
    const v = parseVersionString("(a@x->10,b@x->1)");
    assert.equal(v.size, 2);
    assert.equal(v.get("a@x"), 10);
    assert.equal(v.get("b@x"), 1);
  });

  void test("(b@x->1,a@x->10) — wrong order must be rejected", () => {
    throwsSnapError(() => parseVersionString("(b@x->1,a@x->10)"), "b before a");
  });
});

// ===========================================================================
// ADV-A-008 — version.ts: formatVersionString uses full-entry UTF-8 sort
// SPEC §3.2:100-101: sorted by unsigned UTF-8 bytes of the full entry string
// Test that formatVersionString produces correct order in the case where
// full-entry order differs from naive ID-only lexicographic order.
// ===========================================================================

void describe("ADV-A-008 version: formatVersionString full-entry sort (SPEC §3.2:100-101)", () => {
  void test("formatVersionString sorts by full entry, not just ID", () => {
    // IDs: "a@x" and "a@xa"
    // Full entries: "a@x->2" and "a@xa->1"
    // Full entry byte order: "a@x->2" < "a@xa->1" (0x2D < 0x61 at position 3)
    // By ID only: "a@x" < "a@xa" — same result here
    const v = makeVector([
      ["a@xa", 1],
      ["a@x", 2],
    ]);
    const s = formatVersionString(v);
    assert.equal(s, "(a@x->2,a@xa->1)");
  });

  void test("round-trip: formatVersionString(parseVersionString(s)) === s", () => {
    const s = "(a@x->2,a@xa->1)";
    assert.equal(formatVersionString(parseVersionString(s)), s);
  });

  void test("formatVersionString empty", () => {
    assert.equal(formatVersionString(new Map()), "()");
  });
});

// ===========================================================================
// ADV-A-009 — version.ts: snapOrder correctness (SPEC §3.4:133-138)
// SPEC §3.4: "Take the sorted union of contributor IDs and lexicographically
// compare the counter at each ID. The first unequal counter decides."
// Test: V1={a@x:0, b@x:1} vs V2={a@x:1, b@x:0}
// Sorted IDs: [a@x, b@x]. At a@x: V1=0, V2=1 → V1 < V2 → return -1.
// ===========================================================================

void describe("ADV-A-009 version: snapOrder first-key rule (SPEC §3.4:133-138)", () => {
  void test("V1={a:0,b:1} < V2={a:1,b:0}: first key a decides", () => {
    // a@x sorts before b@x. V1[a@x]=0, V2[a@x]=1 → first diff: 0 < 1 → V1 < V2
    const v1 = makeVector([["b@x", 1]]); // a@x absent = 0
    const v2 = makeVector([["a@x", 1]]); // b@x absent = 0
    assert.equal(snapOrder(v1, v2), -1, "V1 should be less than V2");
    assert.equal(snapOrder(v2, v1), 1, "V2 should be greater than V1");
  });

  void test("snapOrder is total: concurrent vectors get -1 or 1, never 0 unless equal", () => {
    // Causally concurrent but snapOrder must be decisive
    const v1 = makeVector([
      ["a@x", 2],
      ["b@x", 1],
    ]);
    const v2 = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    assert.equal(compareVectors(v1, v2), "concurrent");
    const order = snapOrder(v1, v2);
    assert.ok(order === -1 || order === 1, `expected -1 or 1, got ${order}`);
    assert.equal(snapOrder(v2, v1), -order as -1 | 1);
  });

  void test("snapOrder symmetric: snapOrder(a,b) = -snapOrder(b,a)", () => {
    const v1 = makeVector([
      ["a@x", 3],
      ["b@x", 1],
    ]);
    const v2 = makeVector([
      ["a@x", 1],
      ["b@x", 3],
    ]);
    const ab = snapOrder(v1, v2);
    const ba = snapOrder(v2, v1);
    assert.equal(ab + ba, 0, `expected opposite signs, got ${ab} and ${ba}`);
  });

  void test("snapOrder with disjoint key sets: first sorted key decides", () => {
    // IDs: "a@x" (0x61...) vs "b@x" (0x62...)  → a@x < b@x
    // V1={a@x:1}, V2={b@x:1}
    // At a@x: V1=1, V2=0 → 1 > 0 → V1 > V2 → return 1
    const v1 = makeVector([["a@x", 1]]);
    const v2 = makeVector([["b@x", 1]]);
    assert.equal(snapOrder(v1, v2), 1, "{a:1} > {b:1} since a is first sorted key");
    assert.equal(snapOrder(v2, v1), -1, "{b:1} < {a:1}");
  });
});

// ===========================================================================
// ADV-A-010 — version.ts: joinVectors with keys only in b (SPEC §3.3:119-126)
// SPEC §3.3: join(V,W)[c] = max(V[c], W[c]); absent component is zero.
// When b has keys not in a, they must be included in the result.
// ===========================================================================

void describe("ADV-A-010 version: joinVectors keys-only-in-b (SPEC §3.3:119-126)", () => {
  void test("join({a:1},{b:2}) includes both keys", () => {
    const j = joinVectors(makeVector([["a@x", 1]]), makeVector([["b@x", 2]]));
    assert.equal(j.get("a@x"), 1);
    assert.equal(j.get("b@x"), 2);
    assert.equal(j.size, 2);
  });

  void test("join({},{a:1}) = {a:1}", () => {
    const j = joinVectors(new Map(), makeVector([["a@x", 1]]));
    assert.equal(j.get("a@x"), 1);
    assert.equal(j.size, 1);
  });

  void test("join({a:1,b:2},{b:3,c:4}) = {a:1,b:3,c:4}", () => {
    const j = joinVectors(
      makeVector([
        ["a@x", 1],
        ["b@x", 2],
      ]),
      makeVector([
        ["b@x", 3],
        ["c@x", 4],
      ]),
    );
    assert.equal(j.get("a@x"), 1);
    assert.equal(j.get("b@x"), 3);
    assert.equal(j.get("c@x"), 4);
  });

  void test("join is idempotent: join(v,v) === v", () => {
    const v = makeVector([
      ["a@x", 1],
      ["b@x", 2],
    ]);
    const j = joinVectors(v, v);
    assert.equal(j.size, v.size);
    for (const [k, rev] of v) {
      assert.equal(j.get(k), rev);
    }
  });
});

// ===========================================================================
// ADV-A-011 — version.ts: parseVersionString explicit zeros (SPEC §3.2:108)
// SPEC §3.2: "explicit zeroes... are errors"
// ===========================================================================

void describe("ADV-A-011 version: parseVersionString explicit zero (SPEC §3.2:107-109)", () => {
  void test("(a@x->0) must be rejected — explicit zero", () => {
    throwsSnapError(() => parseVersionString("(a@x->0)"), "explicit zero");
  });

  void test("(a@x->00) must be rejected — leading zero + zero value", () => {
    throwsSnapError(() => parseVersionString("(a@x->00)"), "leading zero zero");
  });

  void test("(a@x->01) must be rejected — leading zero", () => {
    throwsSnapError(() => parseVersionString("(a@x->01)"), "leading zero");
  });
});

// ===========================================================================
// ADV-A-012 — version.ts: duplicate IDs in version string (SPEC §3.2:108)
// ===========================================================================

void describe("ADV-A-012 version: duplicate IDs in version string (SPEC §3.2:107-109)", () => {
  void test("(a@x->1,a@x->2) — duplicate ID must be rejected", () => {
    throwsSnapError(() => parseVersionString("(a@x->1,a@x->2)"), "dup a@x");
  });

  void test("(a@x->1,b@x->1,a@x->3) — duplicate ID in longer list", () => {
    // Note: this would also fail sort check, but dup check should fire
    throwsSnapError(() => parseVersionString("(a@x->1,b@x->1,a@x->3)"), "dup a@x longer");
  });
});

// ===========================================================================
// ADV-A-013 — path.ts: control character 0x7E is NOT a control char (boundary)
// 0x7E is '~', a valid printable ASCII character, must be accepted.
// 0x7F (DEL) is a control character, must be rejected (tested in ADV-A-001).
// This test verifies the boundary: 0x7E is fine, 0x7F is not.
// ===========================================================================

void describe("ADV-A-013 path: 0x7E boundary (SPEC §2:67-71)", () => {
  void test("path with 0x7E ('~') character must be accepted", () => {
    // '~' is 0x7E, a valid printable non-control character
    assert.doesNotThrow(() => validatePath("a~b"));
  });

  void test("path with 0x7F (DEL) must be rejected", () => {
    // 0x7F is the DEL control character — must be rejected
    throwsSnapError(() => validatePath("a\x7fb"), "DEL = 0x7F");
  });
});

// ===========================================================================
// ADV-A-014 — version.ts: compareVectors four-way outcomes (SPEC §3.3:120-128)
// Verifies all four comparison outcomes (=, <, >, ||) are distinct.
// ===========================================================================

void describe("ADV-A-014 version: compareVectors four-way (SPEC §3.3:120-128)", () => {
  void test("equal vectors → 0", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), makeVector([["a@x", 1]])), 0);
  });

  void test("V < W (before) → -1", () => {
    assert.equal(compareVectors(makeVector([["a@x", 1]]), makeVector([["a@x", 2]])), -1);
  });

  void test("V > W (after) → 1", () => {
    assert.equal(compareVectors(makeVector([["a@x", 2]]), makeVector([["a@x", 1]])), 1);
  });

  void test("concurrent vectors → 'concurrent'", () => {
    assert.equal(
      compareVectors(
        makeVector([
          ["a@x", 1],
          ["b@x", 2],
        ]),
        makeVector([
          ["a@x", 2],
          ["b@x", 1],
        ]),
      ),
      "concurrent",
    );
  });

  void test("concurrent is not equivalent to before or after (SPEC §3.3:128-129)", () => {
    const result = compareVectors(
      makeVector([
        ["a@x", 2],
        ["b@x", 1],
      ]),
      makeVector([
        ["a@x", 1],
        ["b@x", 2],
      ]),
    );
    assert.notEqual(result, -1, "concurrent must not be -1");
    assert.notEqual(result, 0, "concurrent must not be 0");
    assert.notEqual(result, 1, "concurrent must not be 1");
    assert.equal(result, "concurrent");
  });
});
