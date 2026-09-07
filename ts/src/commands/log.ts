// snap log — print patches in reverse canonical integration order
// SPEC §7.4, §7.11

import { findRepository, readRepository } from "../repo/store.js";
import { errNotARepository } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";
import { formatVersionString } from "../core/version.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";
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
 * Plain: <version>\t<author>\t<message_escaped>\n
 * Terminal: S(36,"●") + " " + S(1,message) + LF + "  " + S(36,version) + " " + S(2,"by") + " " + S(35,author) + LF
 * Entries separated by one extra LF in terminal mode.
 */
export async function run(cwd: string): Promise<SnapResult<number>> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    return err(errNotARepository());
  }

  const repoResult = await readRepository(repoDir);
  if (!repoResult.ok) return err(repoResult.error);
  const repo = repoResult.value;

  // We need the canonical integration order from replay.
  // replay() returns the final tree, but we need the ORDER in which patches were integrated.
  // The integration order is computed by the same logic as replay — we re-derive it here.

  // Use the same Snap-order logic to determine integration order.
  // Since replay processes patches in Snap order of their result vectors,
  // we can sort patches by their result vectors using snapOrder.

  const patches = [...repo.patches];

  if (patches.length === 0) {
    return ok(0);
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

  const useColor = colorMode(process.stdout);

  for (let i = 0; i < reversed.length; i++) {
    const patch = reversed[i]!;
    const resultVec = patchResultVector(patch);
    const versionStr = formatVersionString(resultVec);

    if (useColor) {
      // Terminal mode: S(36,"●") + " " + S(1,message) + LF + "  " + S(36,version) + " " + S(2,"by") + " " + S(35,author) + LF
      // Between entries: one additional LF
      if (i > 0) {
        process.stdout.write("\n");
      }
      process.stdout.write(
        `${S(36, "●")} ${S(1, patch.message)}\n  ${S(36, versionStr)} ${S(2, "by")} ${S(35, patch.author)}\n`,
      );
    } else {
      // Plain mode: <version>\t<author>\t<message_escaped>\n
      const escaped = escapeMessage(patch.message);
      process.stdout.write(`${versionStr}\t${patch.author}\t${escaped}\n`);
    }
  }

  return ok(0);
}

/**
 * Compute the canonical integration order for a set of patches.
 * Uses the same topological + Snap-order sort as replay.
 */
function computeIntegrationOrder(patches: readonly Patch[]): Patch[] {
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
