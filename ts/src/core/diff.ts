// §5 canonical text diff — reference DP oracle and Hirschberg linear-space fast path

import type { Tokens } from "./tokens.js";

export type DiffOp =
  | { type: "retain"; count: number }
  | { type: "delete"; count: number }
  | { type: "insert"; tokens: readonly string[] };

export type DiffScript = readonly DiffOp[];

// Reference DP diff (O(mn) space, §5 algorithm with delete-on-tie)
export function diffReference(_P: Tokens, _Q: Tokens): DiffScript {
  throw new Error("not implemented");
}

// Hirschberg diff (linear space, same output as diffReference)
export function diffHirschberg(_P: Tokens, _Q: Tokens): DiffScript {
  throw new Error("not implemented");
}

// Primary diff export (uses Hirschberg for large inputs, reference for small)
export function diff(_P: Tokens, _Q: Tokens): DiffScript {
  throw new Error("not implemented");
}
