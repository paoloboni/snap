// snap status — print current version and working-tree changes sorted by path
// SPEC §7.3

import { findRepository, readRepository } from "../repo/store.js";
import { errNotARepository, errUnsupportedEntry } from "../errors.js";
import { replay } from "../repo/replay.js";
import { scanWorktree } from "../fsys/worktree.js";
import { formatVersionString } from "../core/version.js";

/**
 * Run the status command.
 * Prints:
 *   version <version>\n
 *   A path\n   (added: in working tree, not in repo)
 *   M path\n   (modified: bytes differ)
 *   D path\n   (deleted: in repo, not in working tree)
 * Files sorted by path (UTF-8 byte order).
 */
export async function run(cwd: string): Promise<number> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    throw errNotARepository();
  }

  const repo = await readRepository(repoDir);
  const { tree: currentTree } = replay(repo);
  const versionStr = formatVersionString(repo.frontier);

  // Scan working tree
  const entries = await scanWorktree(repoDir);

  // Check for unsupported entries first
  for (const entry of entries) {
    if (entry.type === "unsupported") {
      throw errUnsupportedEntry(entry.path);
    }
  }

  // Build map of working tree files
  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") {
      worktreeMap.set(entry.path, entry.buf);
    }
  }

  // Compute status changes
  const changes: Array<{ code: "A" | "M" | "D"; path: string }> = [];

  // Collect all paths from both sides
  const allPaths = new Set<string>([...worktreeMap.keys(), ...currentTree.paths()]);

  for (const p of allPaths) {
    const inRepo = currentTree.get(p);
    const inWork = worktreeMap.get(p);

    if (inWork !== undefined && inRepo === undefined) {
      changes.push({ code: "A", path: p });
    } else if (inWork === undefined && inRepo !== undefined) {
      changes.push({ code: "D", path: p });
    } else if (inWork !== undefined && inRepo !== undefined && !inWork.equals(inRepo)) {
      changes.push({ code: "M", path: p });
    }
    // else: unchanged
  }

  // Sort by path (UTF-8 byte order)
  changes.sort((a, b) => {
    const bufA = Buffer.from(a.path, "utf8");
    const bufB = Buffer.from(b.path, "utf8");
    return bufA.compare(bufB);
  });

  // Print output
  process.stdout.write(`version ${versionStr}\n`);
  for (const { code, path } of changes) {
    process.stdout.write(`${code} ${path}\n`);
  }

  return 0;
}
