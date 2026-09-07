// Install exact target path/byte map to the working directory with no leftover temp files
// PLAN.md §7.5 rule 3: no leftover temp file after success or failure

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as nodePath from "node:path";
import type { Tree } from "../core/tree.js";
import { errInternalError } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";

/**
 * Install the exact tree at workDir:
 * 1. Write all files in tree (atomically, same-dir temp file → rename).
 * 2. Remove files currently in workDir that are NOT in tree (skip .snap/).
 * 3. Handle file↔directory transitions.
 * 4. Clean up temp files even on failure.
 */
export async function materialize(workDir: string, tree: Tree): Promise<SnapResult<void>> {
  const treePaths = tree.paths();

  // Step 1: Write all tree files atomically
  for (const treePath of treePaths) {
    const bytes = tree.get(treePath)!;
    const absPath = nodePath.join(workDir, treePath);
    const dir = nodePath.dirname(absPath);

    // Handle file→directory transition: if a file exists at a path that we need
    // to be a directory, remove it first.
    const prepared = await ensureDirectoryForFile(absPath);
    if (!prepared.ok) return err(prepared.error);

    // Atomic write: write to temp file in same dir, then rename
    const written = await atomicWrite(dir, absPath, bytes);
    if (!written.ok) return err(written.error);
  }

  // Step 2: Remove files currently in workDir NOT in tree (skip .snap/)
  const treePathSet = new Set(treePaths);
  const pruned = await removeExtraFiles(workDir, workDir, treePathSet);
  if (!pruned.ok) return err(pruned.error);

  // Step 3: Remove empty directories (except .snap/)
  const cleaned = await removeEmptyDirs(workDir, workDir);
  if (!cleaned.ok) return err(cleaned.error);

  return ok(undefined);
}

/**
 * Ensure all parent directories for a file path exist.
 * If a file exists at an intermediate path (file→directory transition), remove it first.
 * If a directory exists at the target path itself (directory→file transition), remove it.
 */
async function ensureDirectoryForFile(absFilePath: string): Promise<SnapResult<void>> {
  // Check if the target path itself is a directory (directory→file transition).
  // A stat failure just means the path does not exist yet.
  const targetIsDir = await attemptAsync(
    async () => (await fs.stat(absFilePath)).isDirectory(),
    () => false,
  );
  if (targetIsDir.ok && targetIsDir.value) {
    // Remove the existing directory so we can write a file there
    const removed = await attemptAsync(
      () => fs.rm(absFilePath, { recursive: true, force: true }),
      errInternalError,
    );
    if (!removed.ok) return err(removed.error);
  }

  const dir = nodePath.dirname(absFilePath);
  // Walk up from the file's directory to ensure each segment is a directory (not a file)
  // Collect the chain of directories to create
  const parts: string[] = [];
  let current = dir;
  const root = nodePath.parse(current).root;
  while (current !== root && current !== nodePath.dirname(current)) {
    parts.unshift(current);
    current = nodePath.dirname(current);
  }

  for (const part of parts) {
    const isDir = await attemptAsync(
      async () => (await fs.stat(part)).isDirectory(),
      () => null,
    );

    if (!isDir.ok) {
      // Doesn't exist — create it
      const made = await attemptAsync(() => fs.mkdir(part, { recursive: true }), errInternalError);
      if (!made.ok) return err(made.error);
      break;
    }

    if (!isDir.value) {
      // A file exists at this path — remove it (file→directory transition)
      const removed = await attemptAsync(() => fs.rm(part, { force: true }), errInternalError);
      if (!removed.ok) return err(removed.error);
      const made = await attemptAsync(() => fs.mkdir(part, { recursive: true }), errInternalError);
      if (!made.ok) return err(made.error);
      break;
    }
  }

  // Finally ensure the directory chain exists
  const made = await attemptAsync(() => fs.mkdir(dir, { recursive: true }), errInternalError);
  if (!made.ok) return err(made.error);

  return ok(undefined);
}

/**
 * Write bytes to absPath atomically using a same-directory temp file.
 * Cleans up the temp file on failure.
 */
async function atomicWrite(dir: string, absPath: string, bytes: Buffer): Promise<SnapResult<void>> {
  const tempPath = nodePath.join(dir, `.snap-tmp-${Math.random().toString(36).slice(2)}`);

  const written = await attemptAsync(async () => {
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, absPath);
  }, errInternalError);

  if (!written.ok) {
    // Best-effort cleanup; a failure to remove the temp file is ignored.
    await attemptAsync(() => fs.unlink(tempPath), errInternalError);
    return err(written.error);
  }

  return ok(undefined);
}

/**
 * Recursively remove files in currentDir that are NOT in treePathSet.
 * Skip .snap/ at the root level.
 */
async function removeExtraFiles(
  rootDir: string,
  currentDir: string,
  treePathSet: Set<string>,
): Promise<SnapResult<void>> {
  const dirents = await attemptAsync(
    (): Promise<Dirent[]> => fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" }),
    () => null,
  );
  if (!dirents.ok) return ok(undefined);

  for (const dirent of dirents.value) {
    const name = dirent.name;
    const absPath = nodePath.join(currentDir, name);
    const relPath =
      currentDir === rootDir
        ? name
        : nodePath.relative(rootDir, absPath).split(nodePath.sep).join("/");

    // Never touch .snap/ at root
    if (currentDir === rootDir && name === ".snap") {
      continue;
    }

    if (dirent.isDirectory()) {
      // Check if any tree path is under this directory
      const prefix = relPath + "/";
      const hasChildren = [...treePathSet].some((p) => p.startsWith(prefix));
      if (hasChildren) {
        // Recurse into directory to remove extra files within it
        const sub = await removeExtraFiles(rootDir, absPath, treePathSet);
        if (!sub.ok) return err(sub.error);
      } else {
        // No tree paths under this dir — remove the whole directory
        const removed = await attemptAsync(
          () => fs.rm(absPath, { recursive: true, force: true }),
          errInternalError,
        );
        if (!removed.ok) return err(removed.error);
      }
    } else {
      // It's a file (or symlink/special) — remove if not in tree
      if (!treePathSet.has(relPath)) {
        const removed = await attemptAsync(() => fs.unlink(absPath), errInternalError);
        if (!removed.ok) return err(removed.error);
      }
    }
  }

  return ok(undefined);
}

/**
 * Remove empty directories (bottom-up), skipping .snap/.
 * Resolves to true if the directory itself is now empty (and was removed).
 */
async function removeEmptyDirs(rootDir: string, currentDir: string): Promise<SnapResult<boolean>> {
  if (currentDir === rootDir) {
    // At root, just process children — don't remove rootDir itself
    const dirents = await attemptAsync(
      (): Promise<Dirent[]> => fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" }),
      () => null,
    );
    if (!dirents.ok) return ok(false);

    for (const dirent of dirents.value) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === ".snap") continue;
      const absPath = nodePath.join(currentDir, dirent.name);
      const sub = await removeEmptyDirs(rootDir, absPath);
      if (!sub.ok) return err(sub.error);
    }
    return ok(false);
  }

  const dirents = await attemptAsync(
    (): Promise<Dirent[]> => fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" }),
    () => null,
  );
  if (!dirents.ok) return ok(false);

  // Recurse first
  for (const dirent of dirents.value) {
    if (!dirent.isDirectory()) continue;
    const absPath = nodePath.join(currentDir, dirent.name);
    const sub = await removeEmptyDirs(rootDir, absPath);
    if (!sub.ok) return err(sub.error);
  }

  // Re-read after recursion to see if dir is now empty
  const afterNames = await attemptAsync(
    (): Promise<string[]> => fs.readdir(currentDir, { encoding: "utf8" }),
    () => null,
  );
  if (!afterNames.ok) return ok(false);

  if (afterNames.value.length === 0) {
    const removed = await attemptAsync(() => fs.rmdir(currentDir), errInternalError);
    if (!removed.ok) return err(removed.error);
    return ok(true);
  }

  return ok(false);
}
