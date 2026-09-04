// Parse/format/4-way compare, vector join, and snap ordering for version vectors

export type Version = { readonly author: string; readonly revision: number };
export type VersionVector = ReadonlyMap<string, number>;

// Parse "author@revision" string; throws SnapError on invalid syntax
export function parseVersion(_s: string): Version {
  throw new Error("not implemented");
}

// Format Version to "author@revision"
export function formatVersion(_v: Version): string {
  throw new Error("not implemented");
}

// Compare two versions: -1 | 0 | 1 | "concurrent"
export function compareVersions(_a: Version, _b: Version): -1 | 0 | 1 | "concurrent" {
  throw new Error("not implemented");
}

// Join two version vectors (element-wise max)
export function joinVectors(_a: VersionVector, _b: VersionVector): VersionVector {
  throw new Error("not implemented");
}

// Snap ordering: compare two version vectors for deterministic integration order
export function snapOrder(_a: VersionVector, _b: VersionVector): -1 | 0 | 1 {
  throw new Error("not implemented");
}
