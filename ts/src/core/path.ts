// Tracked-path validation, UTF-8 byte order comparison, and prefix operations

// Validate a tracked path (no leading slash, no .., valid UTF-8 components); throws SnapError if invalid
export function validatePath(_p: string): void {
  throw new Error("not implemented");
}

// Compare two paths in UTF-8 byte order
export function comparePaths(_a: string, _b: string): -1 | 0 | 1 {
  throw new Error("not implemented");
}

// Check if `prefix` is a path prefix of `p` (same or ancestor directory)
export function isPrefix(_prefix: string, _p: string): boolean {
  throw new Error("not implemented");
}
