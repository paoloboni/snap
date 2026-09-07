// Shared assertions for the Result-returning API surface.
//
// Production code never throws; these helpers turn Result values into ordinary
// test assertions (assertion failures themselves still throw, as node:assert does).

import assert from "node:assert/strict";
import { SnapError } from "../../src/errors.js";
import type { Result } from "../../src/result.js";

/** Assert a Result succeeded and return its value. */
export function assertOk<T, E>(result: Result<T, E>, label = ""): T {
  if (!result.ok) {
    assert.fail(`Expected ok Result${suffix(label)}, got error: ${String(result.error)}`);
  }
  return result.value;
}

/** Assert a Result failed with a SnapError and return that error. */
export function assertErr<T>(result: Result<T, SnapError>, label = ""): SnapError {
  if (result.ok) {
    assert.fail(
      `Expected error Result${suffix(label)}, got ok: ${String(JSON.stringify(result.value))}`,
    );
  }
  assert.ok(result.error instanceof SnapError, `Expected SnapError, got ${String(result.error)}`);
  return result.error;
}

/** Assert a Result failed and that the error message contains `substring`. */
export function expectErr<T>(result: Result<T, SnapError>, substring: string): SnapError {
  const error = assertErr(result);
  assert.ok(
    error.message.includes(substring),
    `Expected message to contain "${substring}", got: "${error.message}"`,
  );
  return error;
}

function suffix(label: string): string {
  return label === "" ? "" : ` (${label})`;
}
