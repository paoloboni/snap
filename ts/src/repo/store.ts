// Repository discovery walk and atomic same-directory temp-file replacement
// PLAN.md §7.5 rule 3: atomic same-dir temp replace, no leftover temp files

import * as fs from "node:fs";
import * as fsAsync from "node:fs/promises";
import * as nodePath from "node:path";
import { parseJSON } from "./json.js";
import { validateRepository } from "./validate.js";
import { serializeRepository } from "./json.js";
import type { Repository } from "./model.js";

const SNAP_DIR = ".snap";
const REPO_FILE = "repository.json";

/**
 * Walk up from cwd looking for .snap/repository.json.
 * Returns the directory containing .snap/ or null if not found.
 * Synchronous because it's just stat calls over a shallow directory tree.
 */
export function findRepository(cwd: string): string | null {
  let current = nodePath.resolve(cwd);

  for (;;) {
    const candidate = nodePath.join(current, SNAP_DIR, REPO_FILE);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return current;
      }
    } catch {
      // Not found at this level
    }

    const parent = nodePath.dirname(current);
    if (parent === current) {
      // Reached filesystem root
      return null;
    }
    current = parent;
  }
}

/**
 * Read and parse repository.json from the given directory.
 * Throws SnapError if file is missing, invalid JSON, or fails validation.
 */
export async function readRepository(dir: string): Promise<Repository> {
  const repoPath = nodePath.join(dir, SNAP_DIR, REPO_FILE);
  const text = await fsAsync.readFile(repoPath, "utf8");
  const data = parseJSON(text);
  return validateRepository(data);
}

/**
 * Atomically write repository.json (same-dir temp replace, no leftover temp files).
 * PLAN.md §7.5 rule 3.
 */
export async function writeRepository(dir: string, repo: Repository): Promise<void> {
  const snapDir = nodePath.join(dir, SNAP_DIR);
  const repoPath = nodePath.join(snapDir, REPO_FILE);
  const tempPath = nodePath.join(snapDir, `.snap-tmp-${Math.random().toString(36).slice(2)}`);

  const text = serializeRepository(repo);
  const bytes = Buffer.from(text, "utf8");

  try {
    await fsAsync.writeFile(tempPath, bytes);
    await fsAsync.rename(tempPath, repoPath);
  } catch (err) {
    try {
      await fsAsync.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}
