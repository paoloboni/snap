// Edit-script validation and application against a base token sequence
// SPEC.md §4.4

import type { Tokens } from "./tokens.js";
import type { DiffScript, DiffOp } from "./diff.js";
import {
  errRevisionNotPositiveSafeInteger,
  errInsertIsEmpty,
  errDoesNotConsumeOldContent,
  errConsumesBeeyondOldContent,
  errAdjacentInsert,
} from "../errors.js";

export type EditScript = DiffScript; // reuse DiffOp

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER; // 9007199254740991

/**
 * Validate a single operation's values:
 * - counts must be positive safe integers
 * - insert tokens must be nonempty strings
 *
 * Note: the "must have one operation" structural check (errMustHaveOneOperation)
 * belongs in the JSON schema validator (repo/validate.ts) where raw JSON objects
 * are first parsed. Here we work with already-typed DiffOp values.
 */
function validateOp(op: DiffOp): void {
  if (op.type === "retain" || op.type === "delete") {
    const count = op.count;
    if (!Number.isInteger(count) || count <= 0 || count > MAX_SAFE_INTEGER) {
      throw errRevisionNotPositiveSafeInteger("retain/delete count");
    }
  } else {
    if (op.tokens.length === 0) {
      throw errInsertIsEmpty();
    }
    for (const tok of op.tokens) {
      if (tok.length === 0) {
        throw errInsertIsEmpty();
      }
    }
  }
}

/**
 * Validate an edit script against a base token sequence; throws SnapError on invalid.
 * SPEC.md §4.4 rules:
 * - Operations: {retain: n}, {delete: n}, {insert: [s...]}
 * - Counts are positive safe integers
 * - Insert tokens are nonempty strings
 * - Adjacent same-kind operations are FORBIDDEN
 * - The script MUST consume exactly the old token sequence length
 */
export function validateEdit(base: Tokens, script: DiffScript): void {
  let consumed = 0;
  const baseLen = base.length;
  let prevType: string | null = null;

  for (const op of script) {
    validateOp(op);

    // Check for adjacent same-kind operations
    if (op.type === prevType) {
      throw errAdjacentInsert();
    }
    prevType = op.type;

    if (op.type === "retain") {
      consumed += op.count;
      if (consumed > baseLen) {
        throw errConsumesBeeyondOldContent();
      }
    } else if (op.type === "delete") {
      consumed += op.count;
      if (consumed > baseLen) {
        throw errConsumesBeeyondOldContent();
      }
    }
    // insert doesn't consume base tokens
  }

  if (consumed < baseLen) {
    throw errDoesNotConsumeOldContent();
  }
}

/**
 * Apply an edit script to a base token sequence; throws SnapError on invalid.
 * Returns the resulting token sequence.
 */
export function applyEdit(base: Tokens, script: DiffScript): Tokens {
  validateEdit(base, script);
  const result: string[] = [];
  let pos = 0;

  for (const op of script) {
    if (op.type === "retain") {
      for (let i = 0; i < op.count; i++) {
        result.push(base[pos]!);
        pos++;
      }
    } else if (op.type === "delete") {
      pos += op.count;
    } else {
      for (const tok of op.tokens) {
        result.push(tok);
      }
    }
  }

  return result;
}
