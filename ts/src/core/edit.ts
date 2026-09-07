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
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

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
function validateOp(op: DiffOp): SnapResult<void> {
  if (op.type === "retain" || op.type === "delete") {
    const count = op.count;
    if (!Number.isInteger(count) || count <= 0 || count > MAX_SAFE_INTEGER) {
      return err(errRevisionNotPositiveSafeInteger("retain/delete count"));
    }
  } else {
    if (op.tokens.length === 0) {
      return err(errInsertIsEmpty());
    }
    for (const tok of op.tokens) {
      if (tok.length === 0) {
        return err(errInsertIsEmpty());
      }
    }
  }
  return ok(undefined);
}

/**
 * Validate an edit script against a base token sequence; returns an error value on invalid.
 * SPEC.md §4.4 rules:
 * - Operations: {retain: n}, {delete: n}, {insert: [s...]}
 * - Counts are positive safe integers
 * - Insert tokens are nonempty strings
 * - Adjacent same-kind operations are FORBIDDEN
 * - The script MUST consume exactly the old token sequence length
 */
export function validateEdit(base: Tokens, script: DiffScript): SnapResult<void> {
  let consumed = 0;
  const baseLen = base.length;
  let prevType: string | null = null;

  for (const op of script) {
    const opCheck = validateOp(op);
    if (!opCheck.ok) {
      return opCheck;
    }

    // Check for adjacent same-kind operations
    if (op.type === prevType) {
      return err(errAdjacentInsert());
    }
    prevType = op.type;

    if (op.type === "retain") {
      consumed += op.count;
      if (consumed > baseLen) {
        return err(errConsumesBeeyondOldContent());
      }
    } else if (op.type === "delete") {
      consumed += op.count;
      if (consumed > baseLen) {
        return err(errConsumesBeeyondOldContent());
      }
    }
    // insert doesn't consume base tokens
  }

  if (consumed < baseLen) {
    return err(errDoesNotConsumeOldContent());
  }

  return ok(undefined);
}

/**
 * Apply an edit script to a base token sequence; returns an error value on invalid.
 * Returns the resulting token sequence.
 */
export function applyEdit(base: Tokens, script: DiffScript): SnapResult<Tokens> {
  const valid = validateEdit(base, script);
  if (!valid.ok) {
    return err(valid.error);
  }

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

  return ok(result);
}
