// §6.3 operational transform for concurrent text edits
// SPEC.md §6.3

import type { DiffOp, DiffScript } from "./diff.js";
import { coalesce } from "./script.js";

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * A cursor into an edit script, tracking the current operation and how many
 * units remain in it (for splitting counts).
 */
interface Cursor {
  ops: readonly DiffOp[];
  idx: number;
  // For retain/delete: how many more units remain in the current op
  remaining: number;
}

function makeCursor(ops: DiffScript): Cursor {
  const c: Cursor = { ops, idx: 0, remaining: 0 };
  advance(c);
  return c;
}

/** Load the count/length for the current op into `remaining`. */
function advance(c: Cursor): void {
  if (c.idx < c.ops.length) {
    const op = c.ops[c.idx]!;
    if (op.type === "retain") {
      c.remaining = op.count;
    } else if (op.type === "delete") {
      c.remaining = op.count;
    } else {
      // insert: remaining = token count (length), used for Q-insert priority
      c.remaining = op.tokens.length;
    }
  } else {
    c.remaining = 0;
  }
}

function currentOp(c: Cursor): DiffOp | undefined {
  return c.ops[c.idx];
}

/** Consume `n` units from a retain/delete operation, moving to next if exhausted. */
function consume(c: Cursor, n: number): void {
  c.remaining -= n;
  if (c.remaining === 0) {
    c.idx++;
    advance(c);
  }
}

/** Consume the entire current insert op and move to next. */
function consumeInsert(c: Cursor): void {
  c.idx++;
  advance(c);
}

// ---------------------------------------------------------------------------
// Main transform
// ---------------------------------------------------------------------------

/**
 * Transform incoming edit P so it applies after aggregate context edit Q.
 * Process both streams left to right, splitting counts as needed.
 *
 * SPEC.md §6.3 table (in priority order):
 * 1. Q insert → output retain(|Q insert|), advance Q only
 * 2. P insert → output same P insert, advance P only
 * 3. P retain, Q retain → output retain(min), consume min from both
 * 4. P delete, Q retain → output delete(min), consume min from both
 * 5. P retain, Q delete → output nothing, consume min from both
 * 6. P delete, Q delete → output nothing, consume min from both
 *
 * Both scripts consume the same base token count; continue until both end.
 * Trailing insertions (from either side) are processed with their applicable row.
 * Coalesce adjacent output operations.
 */
export function transform(P: DiffScript, Q: DiffScript): DiffScript {
  const pCur = makeCursor(P);
  const qCur = makeCursor(Q);
  const out: DiffOp[] = [];

  while (pCur.idx < P.length || qCur.idx < Q.length) {
    const pOp = currentOp(pCur);
    const qOp = currentOp(qCur);

    // Row 1 (highest priority): Q insert
    // "The Q insert row has priority."
    if (qOp !== undefined && qOp.type === "insert") {
      out.push({ type: "retain", count: qOp.tokens.length });
      consumeInsert(qCur);
      continue;
    }

    // Row 2: P insert (and Q is not an insert at front)
    if (pOp !== undefined && pOp.type === "insert") {
      out.push({ type: "insert", tokens: [...pOp.tokens] });
      consumeInsert(pCur);
      continue;
    }

    // At this point both pOp and qOp must be retain or delete (or undefined if trailing)
    // SPEC §6.3: "No unmatched retain or delete can remain."
    // Both scripts consume the same base token count, so if one has retain/delete,
    // the other must also (or one has ended — only inserts can trail).
    // But in practice after all inserts are handled, we only have retain/delete
    // on both sides in lockstep.

    if (pOp === undefined || qOp === undefined) {
      // Trailing inserts would have been handled above; if we get here
      // with a non-insert operation remaining, something is wrong.
      // Per spec: "No unmatched retain or delete can remain."
      // This shouldn't happen for valid scripts.
      break;
    }

    // Rows 3-6: both are retain or delete
    const n = Math.min(pCur.remaining, qCur.remaining);

    if (pOp.type === "retain" && qOp.type === "retain") {
      // Row 3: P retain, Q retain → output retain(min)
      out.push({ type: "retain", count: n });
      consume(pCur, n);
      consume(qCur, n);
    } else if (pOp.type === "delete" && qOp.type === "retain") {
      // Row 4: P delete, Q retain → output delete(min)
      out.push({ type: "delete", count: n });
      consume(pCur, n);
      consume(qCur, n);
    } else if (pOp.type === "retain" && qOp.type === "delete") {
      // Row 5: P retain, Q delete → output nothing
      consume(pCur, n);
      consume(qCur, n);
    } else if (pOp.type === "delete" && qOp.type === "delete") {
      // Row 6: P delete, Q delete → output nothing
      consume(pCur, n);
      consume(qCur, n);
    }
  }

  return coalesce(out);
}
