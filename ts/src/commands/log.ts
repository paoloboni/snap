// snap log — print patches in reverse canonical integration order
// SPEC §7.4

import { findRepository, readRepository } from "../repo/store.js";
import { errNotARepository } from "../errors.js";
import { formatVersionString } from "../core/version.js";
import type { Patch } from "../repo/model.js";

/**
 * Escape a commit message for log output.
 * SPEC §7.4: backslash → \\, tab → \t, LF → \n (in that order).
 */
function escapeMessage(msg: string): string {
  return msg.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

/**
 * Compute the result version vector for a patch.
 */
function patchResultVector(patch: Patch): ReadonlyMap<string, number> {
  const result = new Map<string, number>(patch.base);
  result.set(patch.author, patch.revision);
  return result;
}

/**
 * Run the log command.
 * Prints patches in reverse canonical integration order (newest first).
 * Format: <version>\t<author>\t<message_escaped>\n
 */
export async function run(cwd: string): Promise<number> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    throw errNotARepository();
  }

  const repo = await readRepository(repoDir);

  // We need the canonical integration order from replay.
  // replay() returns the final tree, but we need the ORDER in which patches were integrated.
  // The integration order is computed by the same logic as replay — we re-derive it here.

  // Use the same Snap-order logic to determine integration order.
  // Since replay processes patches in Snap order of their result vectors,
  // we can sort patches by their result vectors using snapOrder.

  const patches = [...repo.patches];

  if (patches.length === 0) {
    return 0;
  }

  // Sort patches by integration order (same as replay):
  // 1. Snap order of result version
  // 2. UTF-8 byte order of author
  // 3. numeric revision
  // We need topological sort with these tie-breakers.

  // Re-implement integration order using the same logic as replay
  const integrationOrder = computeIntegrationOrder(patches);

  // Reverse for display (newest first)
  const reversed = [...integrationOrder].reverse();

  for (const patch of reversed) {
    const resultVec = patchResultVector(patch);
    const versionStr = formatVersionString(resultVec);
    const escaped = escapeMessage(patch.message);
    process.stdout.write(`${versionStr}\t${patch.author}\t${escaped}\n`);
  }

  return 0;
}

/**
 * Compute the canonical integration order for a set of patches.
 * Uses the same topological + Snap-order sort as replay.
 */
function computeIntegrationOrder(patches: Patch[]): Patch[] {
  const appliedDots = new Set<string>();
  const result: Patch[] = [];
  const remaining = new Set<Patch>(patches);

  while (remaining.size > 0) {
    // Find ready patches: all base dependencies are satisfied
    const ready: Patch[] = [];
    for (const patch of remaining) {
      if (isReady(patch, appliedDots)) {
        ready.push(patch);
      }
    }

    if (ready.length === 0) {
      // Should not happen if repository is valid
      break;
    }

    // Sort by Snap order of result version, then author, then revision
    ready.sort(comparePatchesSnapOrder);

    const patch = ready[0]!;
    result.push(patch);
    appliedDots.add(`${patch.author}@${patch.revision}`);
    remaining.delete(patch);
  }

  return result;
}

function isReady(patch: Patch, appliedDots: Set<string>): boolean {
  for (const [author, revision] of patch.base) {
    for (let r = 1; r <= revision; r++) {
      if (!appliedDots.has(`${author}@${r}`)) {
        return false;
      }
    }
  }
  return true;
}

function comparePatchesSnapOrder(a: Patch, b: Patch): number {
  const aResult = new Map(a.base);
  aResult.set(a.author, a.revision);
  const bResult = new Map(b.base);
  bResult.set(b.author, b.revision);

  const allKeys = [...new Set([...aResult.keys(), ...bResult.keys()])];
  allKeys.sort((x, y) => Buffer.from(x, "utf8").compare(Buffer.from(y, "utf8")));

  for (const key of allKeys) {
    const av = aResult.get(key) ?? 0;
    const bv = bResult.get(key) ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // Tiebreak by author, then revision
  const authorCmp = Buffer.from(a.author, "utf8").compare(Buffer.from(b.author, "utf8"));
  if (authorCmp !== 0) return authorCmp;
  return a.revision - b.revision;
}
