// ASCII email-shaped contributor ID validation

import { errInvalidContributorId } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

// Validate a contributor ID (ASCII email-shaped); returns an error value if invalid
// Rules (SPEC §3.1):
//   - ASCII only (bytes 0x20–0x7E), no whitespace (bytes 0x09, 0x0A, 0x0D, 0x20), no comma,
//     no parentheses, no substring "->"
//   - Exactly one "@" with nonempty text on both sides
//   - At most 254 bytes
export function validateContributorId(id: string): SnapResult<void> {
  // Check byte length (UTF-8 — all allowed chars are ASCII, so byte length = char length)
  const byteLen = Buffer.byteLength(id, "utf8");
  if (byteLen > 254) {
    return err(errInvalidContributorId(id));
  }

  // Must be non-empty
  if (id.length === 0) {
    return err(errInvalidContributorId(id));
  }

  // Check each character: must be in 0x21–0x7E (printable ASCII excluding space)
  // space (0x20), tab (0x09), LF (0x0A), CR (0x0D) are whitespace — all forbidden
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    // Must be printable ASCII (0x21–0x7E) — 0x20 (space) is excluded
    if (code < 0x21 || code > 0x7e) {
      return err(errInvalidContributorId(id));
    }
  }

  // No comma
  if (id.includes(",")) {
    return err(errInvalidContributorId(id));
  }

  // No parentheses
  if (id.includes("(") || id.includes(")")) {
    return err(errInvalidContributorId(id));
  }

  // No substring "->"
  if (id.includes("->")) {
    return err(errInvalidContributorId(id));
  }

  // Exactly one "@"
  const atCount = (id.match(/@/g) ?? []).length;
  if (atCount !== 1) {
    return err(errInvalidContributorId(id));
  }

  // Nonempty text on both sides of "@"
  const atIdx = id.indexOf("@");
  if (atIdx === 0 || atIdx === id.length - 1) {
    return err(errInvalidContributorId(id));
  }

  return ok(undefined);
}
