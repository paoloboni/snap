// Working tree scan, unsupported entry detection, and status classification
// SPEC §2: symlinks and other non-regular filesystem entries are unsupported
// PLAN.md §7.5 rule: unsupported entry status takes priority over dirty status

import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as nodePath from "node:path";
import { comparePaths } from "../core/path.js";
import type { Tree } from "../core/tree.js";
import { errInternalError } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";

export type WorktreeEntry =
  { type: "tracked"; path: string; buf: Buffer } | { type: "unsupported"; path: string };

export type WorktreeStatus =
  | { type: "clean" }
  | { type: "dirty"; entries: readonly WorktreeEntry[] }
  | { type: "unsupported"; paths: readonly string[] };

/**
 * Recursively scan workDir for all files and entries.
 * Skips .snap/ entirely. Returns entries sorted by path (UTF-8 byte order).
 * - Regular files → { type: "tracked", path, buf }
 * - Symlinks, FIFOs, sockets, devices, etc. → { type: "unsupported", path }
 * - Directories → recurse (empty dirs are not tracked)
 */
export async function scanWorktree(workDir: string): Promise<SnapResult<WorktreeEntry[]>> {
  const entries: WorktreeEntry[] = [];
  const scanned = await scanDir(workDir, workDir, entries);
  if (!scanned.ok) return err(scanned.error);
  entries.sort((a, b) => comparePaths(a.path, b.path));
  return ok(entries);
}

async function scanDir(
  rootDir: string,
  currentDir: string,
  entries: WorktreeEntry[],
): Promise<SnapResult<void>> {
  // An unreadable directory contributes no entries, as before.
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

    // Skip .snap/ entirely (only at the root level)
    if (currentDir === rootDir && name === ".snap") {
      continue;
    }

    if (dirent.isDirectory()) {
      // Recurse into directory; empty dirs are not tracked (no entry added)
      const sub = await scanDir(rootDir, absPath, entries);
      if (!sub.ok) return err(sub.error);
    } else if (dirent.isFile()) {
      const buf = await attemptAsync(() => fs.readFile(absPath), errInternalError);
      if (!buf.ok) return err(buf.error);
      entries.push({ type: "tracked", path: relPath, buf: buf.value });
    } else {
      // Symlink, FIFO, socket, device, or anything else → unsupported
      entries.push({ type: "unsupported", path: relPath });
    }
  }

  return ok(undefined);
}

/**
 * Classify the working tree against the given current tree snapshot.
 *
 * Priority:
 * 1. If any unsupported entries exist → return { type: "unsupported", paths: [...] }
 * 2. If working tree differs from currentTree → return { type: "dirty", entries: [...] }
 * 3. Otherwise → return { type: "clean" }
 */
export async function classifyWorktree(
  workDir: string,
  currentTree: Tree,
): Promise<SnapResult<WorktreeStatus>> {
  const scanned = await scanWorktree(workDir);
  if (!scanned.ok) return err(scanned.error);
  const entries = scanned.value;

  // Check for unsupported entries first (takes priority over dirty)
  const unsupportedPaths = entries
    .filter((e): e is { type: "unsupported"; path: string } => e.type === "unsupported")
    .map((e) => e.path);

  if (unsupportedPaths.length > 0) {
    return ok({ type: "unsupported", paths: unsupportedPaths });
  }

  // All entries are tracked files — compare against currentTree
  const trackedEntries = entries.filter(
    (e): e is { type: "tracked"; path: string; buf: Buffer } => e.type === "tracked",
  );

  // Check if working tree matches currentTree exactly
  const treePaths = currentTree.paths();

  // Build a set of working tree paths for O(1) lookup
  const worktreePaths = new Set(trackedEntries.map((e) => e.path));

  // Check for added or modified files
  for (const entry of trackedEntries) {
    const treeBytes = currentTree.get(entry.path);
    if (treeBytes === undefined) {
      // File is added (not in current tree) → dirty
      return ok({ type: "dirty", entries: trackedEntries });
    }
    if (!treeBytes.equals(entry.buf)) {
      // File is modified → dirty
      return ok({ type: "dirty", entries: trackedEntries });
    }
  }

  // Check for deleted files (in currentTree but not in working tree)
  for (const treePath of treePaths) {
    if (!worktreePaths.has(treePath)) {
      // File deleted from working tree → dirty
      return ok({ type: "dirty", entries: trackedEntries });
    }
  }

  return ok({ type: "clean" });
}
