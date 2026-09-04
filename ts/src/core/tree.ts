// Immutable path-to-bytes map with sorted key array for O(log n + k) prefix queries

export type Tree = {
  readonly get: (path: string) => Buffer | undefined;
  readonly set: (path: string, value: Buffer) => Tree;
  readonly delete: (path: string) => Tree;
  readonly has: (path: string) => boolean;
  readonly paths: () => readonly string[];
  // All paths that are descendants of the given prefix
  readonly descendants: (prefix: string) => readonly string[];
};

// Create an empty tree
export function emptyTree(): Tree {
  throw new Error("not implemented");
}

// Create a tree from an array of [path, bytes] entries
export function treeFromEntries(_entries: readonly [string, Buffer][]): Tree {
  throw new Error("not implemented");
}
