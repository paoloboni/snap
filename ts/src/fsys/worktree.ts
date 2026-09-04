// Working tree scan, unsupported entry detection, and status classification

import type { Tree } from "../core/tree.js";

export type WorktreeEntry =
  { type: "tracked"; path: string; buf: Buffer } | { type: "unsupported"; path: string };

export type WorktreeStatus =
  | { type: "clean" }
  | { type: "dirty"; entries: readonly WorktreeEntry[] }
  | { type: "unsupported"; paths: readonly string[] };

// Scan working tree rooted at workDir, tracking all files relative to workDir; returns entries
export async function scanWorktree(_workDir: string): Promise<WorktreeEntry[]> {
  throw new Error("not implemented");
}

// Classify the working tree against the given tree snapshot
export async function classifyWorktree(
  _workDir: string,
  _currentTree: Tree,
): Promise<WorktreeStatus> {
  throw new Error("not implemented");
}
