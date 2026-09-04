// snap merge <repository> — import patches from another repository and replay
// SPEC §7.8

import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import { findRepository, readRepository, writeRepository } from "../repo/store.js";
import { parseJSON } from "../repo/json.js";
import { validateRepository } from "../repo/validate.js";
import { fetchRemote } from "../net/client.js";
import { errNotARepository, errWorkingTreeDirty, errUnsupportedEntry } from "../errors.js";
import { replay, joinRepositories } from "../repo/replay.js";
import { scanWorktree } from "../fsys/worktree.js";
import { materialize } from "../fsys/materialize.js";
import { formatVersionString } from "../core/version.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";
import type { Tree } from "../core/tree.js";
import type { Repository } from "../repo/model.js";

/**
 * Run the merge command.
 * SPEC §7.8:
 * - Requires a clean working tree (but no contributor configuration)
 * - Loads and validates the other repository
 * - Unions the patch sets and joins the frontiers
 * - Canonically replays, installs the result, and updates repository.json
 * - Creates no patch and increments no revision
 * - Prints new warnings from §6.4 to stderr and the joined version to stdout
 *
 * Error precedence (DEC-015):
 * 3. Unsupported working tree entries → errUnsupportedEntry
 * 4. Working tree dirty → errWorkingTreeDirty
 */
export async function run(url: string, cwd: string): Promise<number> {
  // Step 1: Find local repository
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    throw errNotARepository();
  }

  // Step 2: Read and validate local repository
  const localRepo = await readRepository(repoDir);

  // Step 3: Scan working tree for unsupported entries
  const entries = await scanWorktree(repoDir);
  for (const entry of entries) {
    if (entry.type === "unsupported") {
      throw errUnsupportedEntry(entry.path);
    }
  }

  // Step 4: Check for dirty working tree
  const { tree: currentTree } = replay(localRepo);
  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") {
      worktreeMap.set(entry.path, entry.buf);
    }
  }

  if (checkDirty(currentTree, worktreeMap)) {
    throw errWorkingTreeDirty();
  }

  // Step 5: Load and validate remote repository
  const remoteRepo = await loadRemoteRepo(url, cwd);

  // Step 6: Compute pre-merge warnings (to detect NEW warnings added by merge)
  const { warnings: preWarnings } = replay(localRepo);
  const preWarningKeys = new Set(preWarnings.map((w) => `${w.path}:${w.reason}`));

  // Step 7: Join repositories
  const { repo: mergedRepo, warnings: allWarnings } = joinRepositories(localRepo, remoteRepo);

  // Step 8: Compute new warnings (only those not present before merge)
  const newWarnings = allWarnings.filter((w) => !preWarningKeys.has(`${w.path}:${w.reason}`));

  // Step 9: Materialize merged tree (update working files first per SPEC §10)
  const { tree: newTree } = replay(mergedRepo);
  await materialize(repoDir, newTree);

  // Step 10: Write merged repository
  await writeRepository(repoDir, mergedRepo);

  // Step 11: Print warnings to stderr (sorted by path, then reason — from replay)
  for (const warning of newWarnings) {
    if (colorMode(process.stderr)) {
      // terminal mode: S(33,"⚠") + " " + S(33,"auto-resolved path: reason") + LF
      process.stderr.write(
        `${S(33, "⚠")} ${S(33, `auto-resolved ${warning.path}: ${warning.reason}`)}\n`,
      );
    } else {
      process.stderr.write(`warning: auto-resolved ${warning.path}: ${warning.reason}\n`);
    }
  }

  // Step 12: Print new version to stdout
  const versionStr = formatVersionString(mergedRepo.frontier);
  if (colorMode(process.stdout)) {
    // terminal mode: S(32,"✓") + " " + S(1,"Merged") + " " + S(36,version) + LF
    process.stdout.write(`${S(32, "✓")} ${S(1, "Merged")} ${S(36, versionStr)}\n`);
  } else {
    process.stdout.write(versionStr + "\n");
  }

  return 0;
}

/**
 * Load a repository from a URL (HTTP/HTTPS) or local path.
 * SPEC §7: "A repository operand is an explicit http:// or https:// URL,
 * or otherwise a local path to a repository root."
 */
async function loadRemoteRepo(url: string, cwd: string): Promise<Repository> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // HTTP repository
    return fetchRemote(url);
  } else {
    // Local path
    const absPath = nodePath.resolve(cwd, url);
    const repoJsonPath = nodePath.join(absPath, ".snap", "repository.json");
    let text: string;
    try {
      text = await fs.readFile(repoJsonPath, "utf8");
    } catch {
      throw errNotARepository();
    }
    const raw = parseJSON(text);
    return validateRepository(raw);
  }
}

function checkDirty(currentTree: Tree, worktreeMap: Map<string, Buffer>): boolean {
  const treePaths = currentTree.paths();
  const worktreePaths = new Set(worktreeMap.keys());

  for (const [path, buf] of worktreeMap) {
    const treeBytes = currentTree.get(path);
    if (treeBytes === undefined) return true;
    if (!treeBytes.equals(buf)) return true;
  }

  for (const treePath of treePaths) {
    if (!worktreePaths.has(treePath)) return true;
  }

  return false;
}
