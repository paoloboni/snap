// Tracked-path validation, UTF-8 byte order comparison, and prefix operations

import { errPathIsInvalid } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

// Validate a tracked path (SPEC §2):
//   - Non-empty
//   - No leading slash
//   - No trailing slash
//   - No component is "." or ".."
//   - No empty component (no "//")
//   - No first component equal to ".snap"
//   - No null bytes or control characters (< 0x20 or === 0x7F)
//   - No backslash
// Returns an error value if invalid
export function validatePath(p: string): SnapResult<void> {
  if (p.length === 0) {
    return err(errPathIsInvalid(p));
  }

  // No leading slash
  if (p.startsWith("/")) {
    return err(errPathIsInvalid(p));
  }

  // No trailing slash
  if (p.endsWith("/")) {
    return err(errPathIsInvalid(p));
  }

  // Check for control characters (< 0x20 or === 0x7F), null bytes, and backslash
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || code === 0 || code === 0x7f) {
      return err(errPathIsInvalid(p));
    }
    if (p[i] === "\\") {
      return err(errPathIsInvalid(p));
    }
  }

  const segments = p.split("/");

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === undefined || seg === "") {
      // Empty segment means leading slash, trailing slash, or "//"
      return err(errPathIsInvalid(p));
    }
    if (seg === "." || seg === "..") {
      return err(errPathIsInvalid(p));
    }
  }

  // No first segment equal to ".snap"
  if (segments[0] === ".snap") {
    return err(errPathIsInvalid(p));
  }

  return ok(undefined);
}

// Compare two paths in unsigned lexicographic UTF-8 byte order
// Returns -1 | 0 | 1
export function comparePaths(a: string, b: string): -1 | 0 | 1 {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  const cmp = bufA.compare(bufB);
  if (cmp < 0) return -1;
  if (cmp > 0) return 1;
  return 0;
}

// Check if `prefix` is a path prefix of `p` (same path or ancestor directory)
// "a/b" is a prefix of "a/b" and "a/b/c" but NOT "a/bc"
export function isPrefix(prefix: string, p: string): boolean {
  if (prefix === p) return true;
  // prefix must match p up to a "/" separator
  return p.startsWith(prefix + "/");
}
