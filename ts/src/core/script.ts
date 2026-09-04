// Shared helpers for building and normalising DiffScript values.

import type { DiffOp, DiffScript } from "./diff.js";

/**
 * Clone a single DiffOp (shallow for retain/delete, deep-copy tokens for insert).
 */
export function cloneOp(op: DiffOp): DiffOp {
  if (op.type === "insert") {
    return { type: "insert", tokens: [...op.tokens] };
  }
  return { ...op };
}

/**
 * Merge adjacent operations of the same kind into a single operation.
 * Returns a canonical DiffScript with no adjacent same-type ops.
 */
export function coalesce(ops: DiffOp[]): DiffScript {
  if (ops.length === 0) return [];
  const out: DiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last === undefined) {
      out.push(cloneOp(op));
      continue;
    }
    if (op.type === "retain" && last.type === "retain") {
      (last as { type: "retain"; count: number }).count += op.count;
    } else if (op.type === "delete" && last.type === "delete") {
      (last as { type: "delete"; count: number }).count += op.count;
    } else if (op.type === "insert" && last.type === "insert") {
      (last as { type: "insert"; tokens: string[] }).tokens = [
        ...(last as { type: "insert"; tokens: readonly string[] }).tokens,
        ...op.tokens,
      ];
    } else {
      out.push(cloneOp(op));
    }
  }
  return out;
}
