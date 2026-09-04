// Parse/format/4-way compare, vector join, and snap ordering for version vectors
//
// SPEC §3.1: A revision is a positive integer ≤ Number.MAX_SAFE_INTEGER (9007199254740991)
// SPEC §3.2: Canonical version string: "(author@host->revision,...)" sorted by UTF-8 bytes,
//            no spaces. Empty is "()"
// SPEC §3.3: Causal comparison and join
// SPEC §3.4: Snap order — lexicographic on sorted union of IDs

import { errInvalidVersion } from "../errors.js";
import { validateContributorId } from "./contributor.js";

// A single author+revision pair (one entry in a version vector)
export type Version = { readonly author: string; readonly revision: number };

// A full version vector: map from contributor ID to latest revision
export type VersionVector = ReadonlyMap<string, number>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER = 9007199254740991; // Number.MAX_SAFE_INTEGER

/**
 * Parse a revision string.  Returns the integer or throws SnapError.
 * Leading zeroes and non-positive values are errors.
 */
function parseRevision(s: string, context: string): number {
  if (s.length === 0) {
    throw errInvalidVersion(context);
  }
  // No leading zeros (a single "0" is also invalid since revision must be positive)
  if (s.length > 1 && s[0] === "0") {
    throw errInvalidVersion(context);
  }
  // Must be all digits
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      throw errInvalidVersion(context);
    }
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_SAFE_INTEGER) {
    throw errInvalidVersion(context);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Single-entry Version parse/format (used by repo layer for dot notation)
// ---------------------------------------------------------------------------

/**
 * Parse "author->revision" — a single author-revision pair.
 * Throws SnapError on invalid syntax.
 */
export function parseVersion(s: string): Version {
  const arrowIdx = s.lastIndexOf("->");
  if (arrowIdx < 0) {
    throw errInvalidVersion(s);
  }
  const author = s.slice(0, arrowIdx);
  const revStr = s.slice(arrowIdx + 2);

  // Validate the contributor ID
  try {
    validateContributorId(author);
  } catch {
    throw errInvalidVersion(s);
  }

  const revision = parseRevision(revStr, s);
  return { author, revision };
}

/** Format a single Version to "author->revision" */
export function formatVersion(v: Version): string {
  return `${v.author}->${v.revision}`;
}

// ---------------------------------------------------------------------------
// Full version string parse/format
// ---------------------------------------------------------------------------

/**
 * Parse the canonical version string "(author->revision,...)" into a VersionVector.
 * SPEC §3.2: duplicate IDs, explicit zeroes, leading zeroes, overflow, whitespace,
 * noncanonical ordering are all errors.
 */
export function parseVersionString(s: string): VersionVector {
  if (s === "()") {
    return new Map();
  }

  if (!s.startsWith("(") || !s.endsWith(")")) {
    throw errInvalidVersion(s);
  }

  const inner = s.slice(1, -1);

  if (inner.length === 0) {
    // "()" already handled above; if we somehow land here it means "()" with no inner
    throw errInvalidVersion(s);
  }

  // No whitespace allowed
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (c <= 0x20) {
      throw errInvalidVersion(s);
    }
  }

  const entries = inner.split(",");
  const map = new Map<string, number>();
  const sortedEntries: string[] = [];

  for (const entry of entries) {
    if (entry.length === 0) {
      throw errInvalidVersion(s);
    }

    const arrowIdx = entry.lastIndexOf("->");
    if (arrowIdx < 0) {
      throw errInvalidVersion(s);
    }

    const id = entry.slice(0, arrowIdx);
    const revStr = entry.slice(arrowIdx + 2);

    // Validate contributor ID
    try {
      validateContributorId(id);
    } catch {
      throw errInvalidVersion(s);
    }

    // Validate revision
    const revision = parseRevision(revStr, s);

    // Check for duplicate IDs
    if (map.has(id)) {
      throw errInvalidVersion(s);
    }

    map.set(id, revision);
    sortedEntries.push(entry);
  }

  // Verify canonical ordering (sorted by unsigned UTF-8 bytes of the full "author->revision" entry)
  for (let i = 1; i < sortedEntries.length; i++) {
    const prev = sortedEntries[i - 1]!;
    const curr = sortedEntries[i]!;
    const prevBuf = Buffer.from(prev, "utf8");
    const currBuf = Buffer.from(curr, "utf8");
    if (prevBuf.compare(currBuf) >= 0) {
      throw errInvalidVersion(s);
    }
  }

  return map;
}

/**
 * Format a VersionVector to canonical "(author->revision,...)" string.
 * SPEC §3.2: entries sorted by unsigned UTF-8 bytes of the full "author->revision" string.
 */
export function formatVersionString(v: VersionVector): string {
  if (v.size === 0) {
    return "()";
  }

  // Build entries, sort by unsigned UTF-8 byte order of the full "id->revision" string
  const entries: string[] = [];
  for (const [id, revision] of v) {
    entries.push(`${id}->${revision}`);
  }

  entries.sort((a, b) => {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    return bufA.compare(bufB);
  });

  return `(${entries.join(",")})`;
}

// ---------------------------------------------------------------------------
// Compare two Versions (single-entry comparison)
// ---------------------------------------------------------------------------

/**
 * Compare two single-Version values (author must be the same for meaningful ordering).
 * Returns -1 | 0 | 1 | "concurrent".
 * Note: For single entries from the same contributor, concurrent is impossible;
 * but for different contributors, they are always concurrent unless equal (both zero, not valid).
 */
export function compareVersions(a: Version, b: Version): -1 | 0 | 1 | "concurrent" {
  if (a.author === b.author) {
    if (a.revision < b.revision) return -1;
    if (a.revision > b.revision) return 1;
    return 0;
  }
  // Different authors — treat as 1-entry vectors:
  // a = {a.author: a.revision}, b = {b.author: b.revision}
  // Union of IDs is [a.author, b.author]. V1 has b.author=0, V2 has a.author=0.
  // V1[a.author]=a.revision >= 0 = V2[a.author], V1[b.author]=0 <= b.revision=V2[b.author]
  // So neither dominates (unless revision = 0, which is not a valid revision).
  // Since both revisions are positive, they are concurrent.
  return "concurrent";
}

// ---------------------------------------------------------------------------
// Vector operations
// ---------------------------------------------------------------------------

/**
 * Join two version vectors: element-wise maximum.
 * SPEC §3.3: join(V,W)[c] = max(V[c], W[c])
 */
export function joinVectors(a: VersionVector, b: VersionVector): VersionVector {
  const result = new Map<string, number>(a);
  for (const [id, rev] of b) {
    const existing = result.get(id) ?? 0;
    if (rev > existing) {
      result.set(id, rev);
    }
  }
  return result;
}

/**
 * 4-way causal comparison of two version vectors.
 * SPEC §3.3:
 *   V = W iff every component is equal
 *   V < W iff every V[c] <= W[c] and at least one strict
 *   V > W iff every V[c] >= W[c] and at least one strict
 *   V || W (concurrent) otherwise
 */
export function compareVectors(a: VersionVector, b: VersionVector): -1 | 0 | 1 | "concurrent" {
  // Collect all keys
  const allKeys = new Set<string>([...a.keys(), ...b.keys()]);

  let aGreater = false;
  let bGreater = false;

  for (const key of allKeys) {
    const av = a.get(key) ?? 0;
    const bv = b.get(key) ?? 0;
    if (av > bv) aGreater = true;
    if (bv > av) bGreater = true;
  }

  if (!aGreater && !bGreater) return 0; // equal
  if (aGreater && !bGreater) return 1; // a > b
  if (!aGreater && bGreater) return -1; // a < b
  return "concurrent";
}

/**
 * Snap ordering: a total order over version vectors used for deterministic integration.
 * SPEC §3.4: Take the sorted union of contributor IDs; lexicographically compare the
 * counter at each ID. The first unequal counter decides.
 * Returns -1 | 0 | 1.
 */
export function snapOrder(a: VersionVector, b: VersionVector): -1 | 0 | 1 {
  // Collect sorted union of all contributor IDs (UTF-8 byte order)
  const allKeys = [...new Set<string>([...a.keys(), ...b.keys()])];
  allKeys.sort((x, y) => {
    const bufX = Buffer.from(x, "utf8");
    const bufY = Buffer.from(y, "utf8");
    return bufX.compare(bufY);
  });

  for (const key of allKeys) {
    const av = a.get(key) ?? 0;
    const bv = b.get(key) ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  return 0;
}
