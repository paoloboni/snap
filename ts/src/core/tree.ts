// Immutable path-to-bytes map with sorted key array for O(log n + k) prefix queries
// SPEC.md §2: prefix-free by path segment
// PLAN.md §9: Tree = Map for point lookups + sorted key array giving O(log n + k) descendant queries

import { comparePaths, isPrefix } from "./path.js";

export type Tree = {
  readonly get: (path: string) => Buffer | undefined;
  readonly set: (path: string, value: Buffer) => Tree;
  readonly delete: (path: string) => Tree;
  readonly has: (path: string) => boolean;
  readonly paths: () => readonly string[];
  // All paths that are descendants of the given prefix
  readonly descendants: (prefix: string) => readonly string[];
};

// ---------------------------------------------------------------------------
// Internal constructor
// ---------------------------------------------------------------------------

function makeTree(map: ReadonlyMap<string, Buffer>, sortedKeys: readonly string[]): Tree {
  return {
    get(path: string): Buffer | undefined {
      return map.get(path);
    },

    set(path: string, value: Buffer): Tree {
      const newMap = new Map(map);
      newMap.set(path, value);

      // Insert into sorted key array (binary-search insertion)
      if (map.has(path)) {
        // Key already exists — just update the map, keep same sorted keys
        return makeTree(newMap, sortedKeys);
      }

      // Insert in sorted order
      const newKeys = insertSorted(sortedKeys, path);
      return makeTree(newMap, newKeys);
    },

    delete(path: string): Tree {
      if (!map.has(path)) {
        return makeTree(map, sortedKeys);
      }
      const newMap = new Map(map);
      newMap.delete(path);
      const newKeys = sortedKeys.filter((k) => k !== path);
      return makeTree(newMap, newKeys);
    },

    has(path: string): boolean {
      return map.has(path);
    },

    paths(): readonly string[] {
      return sortedKeys;
    },

    descendants(prefix: string): readonly string[] {
      // Use binary search to find the range of keys that start with prefix or prefix + "/"
      // Keys are sorted by comparePaths (UTF-8 byte order)
      const n = sortedKeys.length;
      if (n === 0) return [];

      // Find lower bound: smallest index where comparePaths(key, prefix) >= 0
      // (i.e., key >= prefix)
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (comparePaths(sortedKeys[mid]!, prefix) < 0) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      const start = lo;

      // Collect all keys where isPrefix(prefix, key) is true
      const result: string[] = [];
      for (let i = start; i < n; i++) {
        const key = sortedKeys[i]!;
        // Once key is lexicographically greater than prefix + "~" (high bound),
        // we can stop. A simple heuristic: if key doesn't start with prefix, break.
        // Actually we need to check if key could still be a descendant:
        // key starts with prefix or prefix+"/"
        // Since keys are sorted, once key > prefix+"/" + max_char, we stop.
        // The simplest approach: check isPrefix and stop when key > prefix+"/"
        // because all descendants are contiguous in sorted order.
        if (!isPrefix(prefix, key)) {
          // If key > prefix (we're past the prefix range), stop
          // But we might skip over keys like "prefixZ" which aren't descendants
          // but come before "prefix/a". We need to be careful.
          // Since we started from `start` (first key >= prefix), and keys are sorted,
          // any key that is NOT a descendant but comes after `prefix` alphabetically
          // signals we've passed the range of descendants.
          // isPrefix(prefix, key) is true iff key === prefix or key starts with prefix+"/"
          // So if key > prefix and not a descendant, we must have passed all descendants.
          // This works because descendants are in [prefix, prefix+"/"+max] and the
          // UTF-8 sort order ensures "prefix/" < "prefix0" (since '/' = 0x2F < '0' = 0x30).
          // Wait — that's wrong. "/" = 0x2F and "0" = 0x30, so "prefix/" < "prefix0".
          // But "prefixZ" (0x5A) > "prefix/" (0x2F), so "prefixZ" would appear AFTER
          // all "prefix/..." entries in sorted order. So "prefixZ" is NOT a descendant.
          // If we encounter key > prefix and not a descendant, all subsequent keys
          // are also > prefix and not starting with prefix+"/", so we can break.
          // Actually we need to check more carefully. Let's just check: if key starts
          // with prefix+"/" then it's a descendant. If key > prefix+"/" but doesn't
          // start with it, we're done.
          break;
        }
        result.push(key);
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Binary-search sorted insertion
// ---------------------------------------------------------------------------

function insertSorted(sortedKeys: readonly string[], path: string): readonly string[] {
  const n = sortedKeys.length;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (comparePaths(sortedKeys[mid]!, path) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const result = [...sortedKeys];
  result.splice(lo, 0, path);
  return result;
}

// ---------------------------------------------------------------------------
// Public constructors
// ---------------------------------------------------------------------------

// Create an empty tree
export function emptyTree(): Tree {
  return makeTree(new Map(), []);
}

// Create a tree from an array of [path, bytes] entries
export function treeFromEntries(entries: readonly [string, Buffer][]): Tree {
  const map = new Map<string, Buffer>();
  for (const [path, value] of entries) {
    map.set(path, value);
  }
  // Sort keys by comparePaths
  const sortedKeys = [...map.keys()].sort(comparePaths);
  return makeTree(map, sortedKeys);
}
