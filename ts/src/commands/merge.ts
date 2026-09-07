// snap merge <repository> — import patches from another repository and replay
// SPEC §7.8

import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import { findRepository, readRepository, writeRepository } from "../repo/store.js";
import { parseJSON } from "../repo/json.js";
import { validateRepository } from "../repo/validate.js";
import { fetchRemote } from "../net/client.js";
import { errNotARepository, errWorkingTreeDirty, errUnsupportedEntry } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";
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
export async function run(url: string, cwd: string): Promise<SnapResult<number>> {
  // Step 1: Find local repository
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    return err(errNotARepository());
  }

  // Step 2: Read and validate local repository
  const localRepoResult = await readRepository(repoDir);
  if (!localRepoResult.ok) return err(localRepoResult.error);
  const localRepo = localRepoResult.value;

  // Step 3: Scan working tree for unsupported entries
  const scanned = await scanWorktree(repoDir);
  if (!scanned.ok) return err(scanned.error);
  const entries = scanned.value;

  for (const entry of entries) {
    if (entry.type === "unsupported") {
      return err(errUnsupportedEntry(entry.path));
    }
  }

  // Step 4: Check for dirty working tree
  const localReplayed = replay(localRepo);
  if (!localReplayed.ok) return err(localReplayed.error);
  const currentTree = localReplayed.value.tree;

  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") {
      worktreeMap.set(entry.path, entry.buf);
    }
  }

  if (checkDirty(currentTree, worktreeMap)) {
    return err(errWorkingTreeDirty());
  }

  // Step 5: Load and validate remote repository
  const remoteRepoResult = await loadRemoteRepo(url, cwd);
  if (!remoteRepoResult.ok) return err(remoteRepoResult.error);
  const remoteRepo = remoteRepoResult.value;

  // Step 6: Compute pre-merge warnings (to detect NEW warnings added by merge)
  const preWarningKeys = new Set(localReplayed.value.warnings.map((w) => `${w.path}:${w.reason}`));

  // Step 7: Join repositories
  const joined = joinRepositories(localRepo, remoteRepo);
  if (!joined.ok) return err(joined.error);
  const mergedRepo = joined.value.repo;

  // Step 8: Compute new warnings (only those not present before merge)
  const newWarnings = joined.value.warnings.filter(
    (w) => !preWarningKeys.has(`${w.path}:${w.reason}`),
  );

  // Step 9: Materialize merged tree (update working files first per SPEC §10)
  const mergedReplayed = replay(mergedRepo);
  if (!mergedReplayed.ok) return err(mergedReplayed.error);

  const installed = await materialize(repoDir, mergedReplayed.value.tree);
  if (!installed.ok) return err(installed.error);

  // Step 10: Write merged repository
  const written = await writeRepository(repoDir, mergedRepo);
  if (!written.ok) return err(written.error);

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

  return ok(0);
}

/**
 * Load a repository from a URL (HTTP/HTTPS) or local path.
 * SPEC §7: "A repository operand is an explicit http:// or https:// URL,
 * or otherwise a local path to a repository root."
 */
async function loadRemoteRepo(url: string, cwd: string): Promise<SnapResult<Repository>> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    // HTTP repository
    return fetchRemote(url);
  } else {
    // Local path
    const absPath = nodePath.resolve(cwd, url);
    const repoJsonPath = nodePath.join(absPath, ".snap", "repository.json");

    const text = await attemptAsync(
      () => fs.readFile(repoJsonPath, "utf8"),
      () => errNotARepository(),
    );
    if (!text.ok) return err(text.error);

    const raw = parseJSON(text.value);
    if (!raw.ok) return err(raw.error);

    return validateRepository(raw.value);
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
