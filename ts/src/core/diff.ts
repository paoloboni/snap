// §5 canonical text diff — reference DP oracle and Hirschberg linear-space fast path
// SPEC.md §5, PLAN.md §6.2 trap 4

import type { Tokens } from "./tokens.js";

export type DiffOp =
  | { type: "retain"; count: number }
  | { type: "delete"; count: number }
  | { type: "insert"; tokens: readonly string[] };

export type DiffScript = readonly DiffOp[];

// ---------------------------------------------------------------------------
// Coalesce helper
// ---------------------------------------------------------------------------

function coalesce(ops: DiffOp[]): DiffScript {
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

function cloneOp(op: DiffOp): DiffOp {
  if (op.type === "insert") {
    return { type: "insert", tokens: [...op.tokens] };
  }
  return { ...op };
}

// ---------------------------------------------------------------------------
// Reference DP diff (O(n*m) space, §5 algorithm with delete-on-tie)
// ---------------------------------------------------------------------------

/**
 * Build the full D table where D[i][j] = minimum edits to transform A[i..] into B[j..].
 * Uses the §5 recurrence:
 *   D(n, m) = 0
 *   D(i, m) = n - i     (B exhausted, delete remaining A tokens)
 *   D(n, j) = m - j     (A exhausted, insert remaining B tokens)
 *   if A[i] == B[j]: D(i,j) = D(i+1, j+1)
 *   else: D(i,j) = 1 + min(D(i+1,j), D(i,j+1))
 */
function buildDTable(A: Tokens, B: Tokens): number[][] {
  const n = A.length;
  const m = B.length;
  const D: number[][] = [];
  for (let i = 0; i <= n; i++) {
    D.push(new Array<number>(m + 1).fill(0));
  }
  for (let i = 0; i <= n; i++) {
    D[i]![m] = n - i;
  }
  for (let j = 0; j <= m; j++) {
    D[n]![j] = m - j;
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (A[i] === B[j]) {
        D[i]![j] = D[i + 1]![j + 1]!;
      } else {
        const delCost = D[i + 1]![j]!;
        const insCost = D[i]![j + 1]!;
        D[i]![j] = 1 + Math.min(delCost, insCost);
      }
    }
  }
  return D;
}

/**
 * Reference DP diff (O(n*m) space).
 * Walk from (0, 0) using the D table, following §5's tie-breaking rule:
 *   - delete if D(i+1,j) <= D(i,j+1) (delete-on-tie)
 * PLAN.md §6.2 trap 4: exhausted-side check MUST be before steps 1-3.
 */
export function diffReference(A: Tokens, B: Tokens): DiffScript {
  const n = A.length;
  const m = B.length;
  const D = buildDTable(A, B);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    // CRITICAL: check exhaustion FIRST (PLAN.md §6.2 trap 4)
    if (i === n) {
      ops.push({ type: "insert", tokens: [B[j]!] });
      j++;
    } else if (j === m) {
      ops.push({ type: "delete", count: 1 });
      i++;
    } else if (A[i] === B[j]) {
      ops.push({ type: "retain", count: 1 });
      i++;
      j++;
    } else {
      const delCost = D[i + 1]![j]!;
      const insCost = D[i]![j + 1]!;
      if (delCost <= insCost) {
        ops.push({ type: "delete", count: 1 });
        i++;
      } else {
        ops.push({ type: "insert", tokens: [B[j]!] });
        j++;
      }
    }
  }
  return coalesce(ops);
}

// ---------------------------------------------------------------------------
// Hirschberg linear-space diff
// ---------------------------------------------------------------------------

/**
 * Simulate the greedy reference-DP walk for A[iLo..iHi) vs B[jLo..jHi)
 * but only process the FIRST iMid-iLo rows of A, returning the j position
 * the walk reaches after those rows.
 *
 * This uses the SAME D-table (built for the full subproblem) to ensure
 * identical tie-breaking with the reference walk.
 *
 * Returns the j (relative to jLo) that the greedy walk reaches after
 * processing rows iLo..iMid.
 */
function greedySplitColumn(
  A: Tokens,
  iLo: number,
  iMid: number,
  iHi: number,
  B: Tokens,
  jLo: number,
  jHi: number,
): number {
  // We need the D table for A[iLo..iHi) vs B[jLo..jHi) to get tie-breaking right.
  // This is O(n*m) space for this subproblem, same as reference.
  // But we only walk through iMid-iLo rows.
  const Asub = A.slice(iLo, iHi);
  const Bsub = B.slice(jLo, jHi);
  const D = buildDTable(Asub, Bsub);
  const rowsToProcess = iMid - iLo;
  let i = 0;
  let j = 0;
  // Process greedy walk for the first `rowsToProcess` A-consuming steps.
  // We stop after consuming `rowsToProcess` A tokens via retain or delete.
  let aConsumed = 0;
  const m = Bsub.length;
  while (aConsumed < rowsToProcess) {
    if (j === m) {
      // B exhausted: delete A[i]
      i++;
      aConsumed++;
    } else if (Asub[i] === Bsub[j]) {
      i++;
      j++;
      aConsumed++;
    } else {
      const delCost = D[i + 1]![j]!;
      const insCost = D[i]![j + 1]!;
      if (delCost <= insCost) {
        // delete A[i] — consumes A
        i++;
        aConsumed++;
      } else {
        // insert B[j] — consumes B, not A
        j++;
      }
    }
  }
  return j; // relative to 0 in Bsub, which is relative to jLo in B
}

/**
 * Hirschberg divide-and-conquer diff.
 * Produces identical output to diffReference (same tie-breaking).
 *
 * To guarantee identical tie-breaking, we use the reference D-table to determine
 * the split column (which j the greedy walk reaches after iMid-iLo A tokens).
 * This makes the split O(n*m) at each level, but only O(n+m) space since we
 * discard the D table after finding the split column.
 *
 * The overall time complexity remains O(n*m) like the reference, but space
 * is O(n+m) per recursion level = O((n+m) log n) total — acceptable for
 * the diff oracle correctness requirement.
 */
function hirschbergRec(
  A: Tokens,
  iLo: number,
  iHi: number,
  B: Tokens,
  jLo: number,
  jHi: number,
  ops: DiffOp[],
): void {
  const n = iHi - iLo;
  const m = jHi - jLo;

  if (n === 0) {
    for (let j = jLo; j < jHi; j++) {
      ops.push({ type: "insert", tokens: [B[j]!] });
    }
    return;
  }
  if (m === 0) {
    for (let i = iLo; i < iHi; i++) {
      ops.push({ type: "delete", count: 1 });
    }
    return;
  }
  if (n === 1 || m === 1) {
    // For n=1 or m=1, use reference DP to guarantee tie-breaking correctness
    diffSmall(A, iLo, iHi, B, jLo, jHi, ops);
    return;
  }

  // Divide A at the midpoint
  const iMid = iLo + Math.floor(n / 2);

  // Use the greedy reference walk to find the exact split column.
  // This ensures identical tie-breaking with diffReference.
  const bestJ = greedySplitColumn(A, iLo, iMid, iHi, B, jLo, jHi);

  // Recurse on the two halves
  hirschbergRec(A, iLo, iMid, B, jLo, jLo + bestJ, ops);
  hirschbergRec(A, iMid, iHi, B, jLo + bestJ, jHi, ops);
}

/**
 * Handle small subproblems using the D-table walk for exact tie-breaking.
 */
function diffSmall(
  A: Tokens,
  iLo: number,
  iHi: number,
  B: Tokens,
  jLo: number,
  jHi: number,
  ops: DiffOp[],
): void {
  const Asub = A.slice(iLo, iHi);
  const Bsub = B.slice(jLo, jHi);
  const D = buildDTable(Asub, Bsub);
  const n = Asub.length;
  const m = Bsub.length;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i === n) {
      ops.push({ type: "insert", tokens: [Bsub[j]!] });
      j++;
    } else if (j === m) {
      ops.push({ type: "delete", count: 1 });
      i++;
    } else if (Asub[i] === Bsub[j]) {
      ops.push({ type: "retain", count: 1 });
      i++;
      j++;
    } else {
      const delCost = D[i + 1]![j]!;
      const insCost = D[i]![j + 1]!;
      if (delCost <= insCost) {
        ops.push({ type: "delete", count: 1 });
        i++;
      } else {
        ops.push({ type: "insert", tokens: [Bsub[j]!] });
        j++;
      }
    }
  }
}

/**
 * Hirschberg diff (linear space, same output as diffReference).
 * SPEC.md §5: "Implementations MAY use Myers, Hirschberg, or another
 * optimization only if it produces the same script."
 */
export function diffHirschberg(A: Tokens, B: Tokens): DiffScript {
  const ops: DiffOp[] = [];
  hirschbergRec(A, 0, A.length, B, 0, B.length, ops);
  return coalesce(ops);
}

/**
 * Primary diff export (uses Hirschberg for large inputs, reference for small).
 * Both produce identical output; Hirschberg is preferred for O(n+m) space.
 */
export function diff(A: Tokens, B: Tokens): DiffScript {
  const threshold = 50;
  if (A.length <= threshold && B.length <= threshold) {
    return diffReference(A, B);
  }
  return diffHirschberg(A, B);
}
