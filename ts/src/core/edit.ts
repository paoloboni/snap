// Edit-script validation and application against a base token sequence

import type { Tokens } from "./tokens.js";
import type { DiffScript } from "./diff.js";

export type EditScript = DiffScript; // reuse DiffOp

// Validate an edit script against a base token sequence; throws SnapError on invalid
export function validateEdit(_base: Tokens, _script: DiffScript): void {
  throw new Error("not implemented");
}

// Apply an edit script to a base token sequence; throws SnapError on invalid
export function applyEdit(_base: Tokens, _script: DiffScript): Tokens {
  throw new Error("not implemented");
}
