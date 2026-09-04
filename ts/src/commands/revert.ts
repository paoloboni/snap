// snap revert <version> — install the tree at the given version
// SPEC §7.7

import { findRepository, readRepository, writeRepository } from "../repo/store.js";
import { readConfig } from "../repo/config.js";
import {
  errNotARepository,
  errContributorIdRequired,
  errInvalidVersion,
  errUnknownVersion,
  errWorkingTreeDirty,
  errTargetTreeAlreadyCurrent,
  errUnsupportedEntry,
} from "../errors.js";
import { replay } from "../repo/replay.js";
import { parseVersionString, formatVersionString } from "../core/version.js";
import { scanWorktree } from "../fsys/worktree.js";
import { materialize } from "../fsys/materialize.js";
import { isText, tokenize } from "../core/tokens.js";
import { diff } from "../core/diff.js";
import { comparePaths } from "../core/path.js";
import type { Change, Patch } from "../repo/model.js";
import type { Tree } from "../core/tree.js";
import type { Repository } from "../repo/model.js";
import type { VersionVector } from "../core/version.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";

/**
 * Check if a version is materializable in the repository.
 * A version is known when it is syntactically valid, every patch (c,n) where n <= V[c] exists,
 * and that selected set contains the complete base of every selected patch.
 * SPEC §4.1.
 */
function isVersionKnown(version: VersionVector, repo: Repository): boolean {
  // For each contributor in version, all revisions 1..n must exist
  for (const [author, maxRev] of version) {
    for (let r = 1; r <= maxRev; r++) {
      const found = repo.patches.some((p) => p.author === author && p.revision === r);
      if (!found) return false;
    }
  }
  return true;
}

/**
 * Materialize the tree at a given version by replaying selected patches.
 */
function materializeVersion(version: VersionVector, repo: Repository): Tree {
  // Create a sub-repository containing only the patches selected by version
  const selectedPatches = repo.patches.filter((p) => p.revision <= (version.get(p.author) ?? 0));

  const subRepo: Repository = {
    format: 1,
    frontier: version,
    patches: selectedPatches,
  };

  const { tree } = replay(subRepo);
  return tree;
}

/**
 * Create a change to transform oldBytes → newBytes at path.
 * Uses text change when both sides are text; otherwise put/delete.
 */
function makeChange(
  path: string,
  oldBytes: Buffer | undefined,
  newBytes: Buffer | undefined,
): Change {
  if (newBytes === undefined) {
    return { type: "delete", path };
  }

  const newIsText = isText(newBytes);
  const oldIsText = oldBytes === undefined ? true : isText(oldBytes);

  if (newIsText && oldIsText) {
    const oldTokens = oldBytes === undefined ? [] : tokenize(oldBytes.toString("utf8"));
    const newTokens = tokenize(newBytes.toString("utf8"));
    const editScript = diff(oldTokens, newTokens);
    return { type: "text", path, edit: editScript };
  }

  return { type: "put", path, content: newBytes.toString("base64") };
}

/**
 * Run the revert command.
 * Error precedence (DEC-015):
 * 1. Find repo → errNotARepository
 * 2. Read repo
 * 3. Scan worktree → errUnsupportedEntry (priority 3)
 * 4. Check dirty tree → errWorkingTreeDirty (priority 4)
 * 5. Parse version string → errInvalidVersion (priority 5)
 * 6. Check version is known → errUnknownVersion (priority 6)
 * 7. Read config → check contributor.id → errContributorIdRequired (priority 7)
 * 8. Execute
 */
export async function run(versionStr: string, cwd: string): Promise<number> {
  // Step 1: Find repository
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    throw errNotARepository();
  }

  // Step 2: Read repository
  const repo = await readRepository(repoDir);

  // Step 3: Scan working tree, check for unsupported entries (DEC-015 priority 3)
  const entries = await scanWorktree(repoDir);
  for (const entry of entries) {
    if (entry.type === "unsupported") {
      throw errUnsupportedEntry(entry.path);
    }
  }

  // Step 4: Check dirty tree (DEC-015 priority 4 — before version validation)
  const { tree: currentTree } = replay(repo);
  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") {
      worktreeMap.set(entry.path, entry.buf);
    }
  }

  const isDirty = checkDirty(currentTree, worktreeMap);
  if (isDirty) {
    throw errWorkingTreeDirty();
  }

  // Step 5: Parse version string (syntax check — DEC-015 priority 5)
  let targetVersion: VersionVector;
  try {
    targetVersion = parseVersionString(versionStr);
  } catch {
    throw errInvalidVersion(versionStr);
  }

  // Step 6: Check version is known (DEC-015 priority 6)
  if (!isVersionKnown(targetVersion, repo)) {
    throw errUnknownVersion(versionStr);
  }

  // Step 7: Read config and check contributor ID (DEC-015 priority 7)
  const config = await readConfig(repoDir);
  if (config.contributorId === undefined) {
    throw errContributorIdRequired();
  }
  const authorId = config.contributorId;

  // Step 8: Materialize target tree
  const targetTree = materializeVersion(targetVersion, repo);

  // Check if current tree == target tree
  if (treesEqual(currentTree, targetTree)) {
    throw errTargetTreeAlreadyCurrent();
  }

  // Step 9: Build changes from current tree to target tree
  const allPaths = new Set<string>([...currentTree.paths(), ...targetTree.paths()]);

  const changes: Change[] = [];
  for (const path of [...allPaths].sort(comparePaths)) {
    const fromBytes = currentTree.get(path);
    const toBytes = targetTree.get(path);

    if (fromBytes === undefined && toBytes === undefined) continue;
    if (fromBytes !== undefined && toBytes !== undefined && fromBytes.equals(toBytes)) continue;

    changes.push(makeChange(path, fromBytes, toBytes));
  }

  // The revert message contains the target version string
  const revertMessage = `revert to ${versionStr}`;

  // Step 10: Create the new patch
  const currentFrontier = repo.frontier;
  const authorRevision = (currentFrontier.get(authorId) ?? 0) + 1;

  const newPatch: Patch = {
    author: authorId,
    revision: authorRevision,
    base: currentFrontier,
    message: revertMessage,
    changes,
  };

  // Build new frontier
  const newFrontier = new Map(currentFrontier);
  newFrontier.set(authorId, authorRevision);

  // Build new patches list
  const newPatches = [...repo.patches, newPatch].sort((a, b) => {
    const aBuf = Buffer.from(a.author, "utf8");
    const bBuf = Buffer.from(b.author, "utf8");
    const ac = aBuf.compare(bBuf);
    if (ac !== 0) return ac;
    return a.revision - b.revision;
  });

  const newRepo = {
    format: 1 as const,
    frontier: newFrontier,
    patches: newPatches,
  };

  // Step 11: Materialize target tree (update working files first per SPEC §10)
  await materialize(repoDir, targetTree);

  // Step 12: Write repository (after working files are updated)
  await writeRepository(repoDir, newRepo);

  // Print new version
  const newVersionStr = formatVersionString(newFrontier);
  if (colorMode(process.stdout)) {
    // terminal mode: S(32,"✓") + " " + S(1,"Reverted") + " " + S(36,version) + LF
    process.stdout.write(`${S(32, "✓")} ${S(1, "Reverted")} ${S(36, newVersionStr)}\n`);
  } else {
    process.stdout.write(newVersionStr + "\n");
  }

  return 0;
}

function checkDirty(currentTree: Tree, worktreeMap: Map<string, Buffer>): boolean {
  const treePaths = currentTree.paths();
  const worktreePaths = new Set(worktreeMap.keys());

  for (const entry of worktreeMap) {
    const [path, buf] = entry;
    const treeBytes = currentTree.get(path);
    if (treeBytes === undefined) return true; // Added
    if (!treeBytes.equals(buf)) return true; // Modified
  }

  for (const treePath of treePaths) {
    if (!worktreePaths.has(treePath)) return true; // Deleted
  }

  return false;
}

function treesEqual(a: Tree, b: Tree): boolean {
  const aPaths = a.paths();
  const bPaths = b.paths();
  if (aPaths.length !== bPaths.length) return false;
  for (let i = 0; i < aPaths.length; i++) {
    const ap = aPaths[i]!;
    const bp = bPaths[i]!;
    if (ap !== bp) return false;
    const aBytes = a.get(ap)!;
    const bBytes = b.get(bp)!;
    if (!aBytes.equals(bBytes)) return false;
  }
  return true;
}
