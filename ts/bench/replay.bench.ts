// Benchmark: replay engine
// Budget: < 1000ms for 50 concurrent patches each making a text edit to a 100-line file

import { replay } from "../src/repo/replay.js";
import type { Repository, Patch } from "../src/repo/model.js";
import type { DiffOp, DiffScript } from "../src/core/diff.js";

// Build a 100-line text file as base64
function buildBaseContent(lines: number): string {
  const text = Array.from({ length: lines }, (_, i) => `line ${i}\n`).join("");
  return Buffer.from(text, "utf8").toString("base64");
}

// Build a text edit that replaces one line in a 100-line file.
// Each patch author replaces their own line (line index = patchIndex).
// Edit: retain `patchIndex` lines, delete 1 line, insert replacement, retain rest.
function buildTextEdit(patchIndex: number, totalLines: number): DiffScript {
  const ops: DiffOp[] = [];
  if (patchIndex > 0) {
    ops.push({ type: "retain", count: patchIndex });
  }
  ops.push({ type: "delete", count: 1 });
  ops.push({ type: "insert", tokens: [`edited by patch ${patchIndex}\n`] });
  const remaining = totalLines - patchIndex - 1;
  if (remaining > 0) {
    ops.push({ type: "retain", count: remaining });
  }
  return ops;
}

// Build a repository with `count` concurrent patches (all with empty base = concurrent from seed)
// Each patch makes a single-line text edit to the same file "file.txt".
// Patch 0 (the "seed") creates the file via put; patches 1..count-1 are concurrent text edits.
export function buildReplayRepository(patchCount: number): Repository {
  const LINES = 100;
  const FILE = "file.txt";
  const baseContent = buildBaseContent(LINES);

  const patches: Patch[] = [];

  // Patch 0: seed patch — creates the file
  const seedAuthor = "seed@example.com";
  patches.push({
    author: seedAuthor,
    revision: 1,
    base: new Map<string, number>(),
    message: "create file",
    changes: [{ type: "put", path: FILE, content: baseContent }],
  });

  // Patches 1..patchCount-1: concurrent text edits (each based on the seed)
  for (let i = 0; i < patchCount - 1; i++) {
    const author = `author${i}@example.com`;
    const edit = buildTextEdit(i % LINES, LINES);
    patches.push({
      author,
      revision: 1,
      // Each concurrent patch has the seed in its base
      base: new Map<string, number>([[seedAuthor, 1]]),
      message: `edit line ${i}`,
      changes: [{ type: "text", path: FILE, edit }],
    });
  }

  // Sort patches by author then revision (as required by SPEC §4.1)
  const sortedPatches = [...patches].sort((a, b) => {
    const ac = Buffer.from(a.author, "utf8").compare(Buffer.from(b.author, "utf8"));
    if (ac !== 0) return ac;
    return a.revision - b.revision;
  });

  // Frontier: includes all authors at their latest revision
  const frontier = new Map<string, number>();
  for (const p of sortedPatches) {
    const cur = frontier.get(p.author) ?? 0;
    if (p.revision > cur) {
      frontier.set(p.author, p.revision);
    }
  }

  return {
    format: 1,
    frontier,
    patches: sortedPatches,
  };
}

export function runReplayBenchmark(): { replayMs: number } {
  const PATCH_COUNT = 50;

  // Build the repository outside the timed region
  const repo = buildReplayRepository(PATCH_COUNT);

  // Warm up with a smaller repo
  const smallRepo = buildReplayRepository(5);
  const warmup = replay(smallRepo);
  if (!warmup.ok) {
    process.stderr.write(`bench: replay warm-up failed: ${warmup.error.message}\n`);
    return { replayMs: Number.POSITIVE_INFINITY };
  }

  // Benchmark replay
  const start = performance.now();
  const replayed = replay(repo);
  const replayMs = performance.now() - start;

  if (!replayed.ok) {
    process.stderr.write(`bench: replay failed: ${replayed.error.message}\n`);
    return { replayMs: Number.POSITIVE_INFINITY };
  }

  return { replayMs };
}
