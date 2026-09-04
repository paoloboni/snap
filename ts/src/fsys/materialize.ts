// Install exact target path/byte map to the working directory with no leftover temp files
// PLAN.md §7.5 rule 3: no leftover temp file after success or failure

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as nodePath from "node:path";
import { comparePaths } from "../core/path.js";
import type { Tree } from "../core/tree.js";

/**
 * Install the exact tree at workDir:
 * 1. Write all files in tree (atomically, same-dir temp file → rename).
 * 2. Remove files currently in workDir that are NOT in tree (skip .snap/).
 * 3. Handle file↔directory transitions.
 * 4. Clean up temp files even on failure.
 */
export async function materialize(workDir: string, tree: Tree): Promise<void> {
  const treePaths = tree.paths();

  // Step 1: Write all tree files atomically
  for (const treePath of treePaths) {
    const bytes = tree.get(treePath)!;
    const absPath = nodePath.join(workDir, treePath);
    const dir = nodePath.dirname(absPath);

    // Handle file→directory transition: if a file exists at a path that we need
    // to be a directory, remove it first.
    await ensureDirectoryForFile(absPath);

    // Atomic write: write to temp file in same dir, then rename
    await atomicWrite(dir, absPath, bytes);
  }

  // Step 2: Remove files currently in workDir NOT in tree (skip .snap/)
  const treePathSet = new Set(treePaths);
  await removeExtraFiles(workDir, workDir, treePathSet);

  // Step 3: Remove empty directories (except .snap/)
  await removeEmptyDirs(workDir, workDir);
}

/**
 * Ensure all parent directories for a file path exist.
 * If a file exists at an intermediate path (file→directory transition), remove it first.
 * If a directory exists at the target path itself (directory→file transition), remove it.
 */
async function ensureDirectoryForFile(absFilePath: string): Promise<void> {
  // Check if the target path itself is a directory (directory→file transition)
  try {
    const stat = await fs.stat(absFilePath);
    if (stat.isDirectory()) {
      // Remove the existing directory so we can write a file there
      await fs.rm(absFilePath, { recursive: true, force: true });
    }
  } catch {
    // Path doesn't exist yet — that's fine
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
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(part);
    } catch {
      // Doesn't exist — create it
      await fs.mkdir(part, { recursive: true });
      break;
    }
    if (!stat.isDirectory()) {
      // A file exists at this path — remove it (file→directory transition)
      await fs.rm(part, { force: true });
      await fs.mkdir(part, { recursive: true });
      break;
    }
  }

  // Finally ensure the directory chain exists
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Write bytes to absPath atomically using a same-directory temp file.
 * Cleans up the temp file on failure.
 */
async function atomicWrite(dir: string, absPath: string, bytes: Buffer): Promise<void> {
  const tempPath = nodePath.join(dir, `.snap-tmp-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, absPath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Recursively remove files in currentDir that are NOT in treePathSet.
 * Skip .snap/ at the root level.
 */
async function removeExtraFiles(
  rootDir: string,
  currentDir: string,
  treePathSet: Set<string>,
): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const dirent of dirents) {
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
        await removeExtraFiles(rootDir, absPath, treePathSet);
      } else {
        // No tree paths under this dir — remove the whole directory
        await fs.rm(absPath, { recursive: true, force: true });
      }
    } else {
      // It's a file (or symlink/special) — remove if not in tree
      if (!treePathSet.has(relPath)) {
        await fs.unlink(absPath);
      }
    }
  }
}

/**
 * Remove empty directories (bottom-up), skipping .snap/.
 * Returns true if the directory itself is now empty (and can be removed by caller).
 */
async function removeEmptyDirs(rootDir: string, currentDir: string): Promise<boolean> {
  if (currentDir === rootDir) {
    // At root, just process children — don't remove rootDir itself
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return false;
    }

    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (currentDir === rootDir && dirent.name === ".snap") continue;
      const absPath = nodePath.join(currentDir, dirent.name);
      await removeEmptyDirs(rootDir, absPath);
    }
    return false;
  }

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return false;
  }

  // Recurse first
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const absPath = nodePath.join(currentDir, dirent.name);
    await removeEmptyDirs(rootDir, absPath);
  }

  // Re-read after recursion to see if dir is now empty
  let afterNames: string[];
  try {
    afterNames = await fs.readdir(currentDir, { encoding: "utf8" });
  } catch {
    return false;
  }

  if (afterNames.length === 0) {
    await fs.rmdir(currentDir);
    return true;
  }
  return false;
}

/**
 * Scan working directory (excluding .snap/) and return all relative file paths.
 * Sorted by comparePaths.
 */
export async function scanWorkDir(workDir: string): Promise<string[]> {
  const paths: string[] = [];
  await collectPaths(workDir, workDir, paths);
  paths.sort(comparePaths);
  return paths;
}

async function collectPaths(rootDir: string, currentDir: string, paths: string[]): Promise<void> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    const name = dirent.name;
    const absPath = nodePath.join(currentDir, name);
    const relPath =
      currentDir === rootDir
        ? name
        : nodePath.relative(rootDir, absPath).split(nodePath.sep).join("/");

    if (currentDir === rootDir && name === ".snap") continue;

    if (dirent.isDirectory()) {
      await collectPaths(rootDir, absPath, paths);
    } else {
      paths.push(relPath);
    }
  }
}
