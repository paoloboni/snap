// snap commit <message> — record a dirty working tree as a new patch
// SPEC §7.5

import { findRepository, readRepository, writeRepository } from "../repo/store.js";
import { readConfig } from "../repo/config.js";
import {
  errNotARepository,
  errContributorIdRequired,
  errInvalidCommitMessage,
  errWorkingTreeClean,
  errUnsupportedEntry,
} from "../errors.js";
import { replay } from "../repo/replay.js";
import { scanWorktree } from "../fsys/worktree.js";
import { formatVersionString } from "../core/version.js";
import { isText, tokenize } from "../core/tokens.js";
import { diff } from "../core/diff.js";
import { comparePaths } from "../core/path.js";
import type { Change, Patch } from "../repo/model.js";
import type { DiffOp } from "../core/diff.js";

const MAX_MESSAGE_BYTES = 4096;

/**
 * Validate a commit message:
 * - Must be non-empty
 * - Must be ≤ 4096 UTF-8 bytes
 * - Must not contain control characters other than TAB and LF
 */
function validateCommitMessage(msg: string): void {
  if (msg.length === 0) {
    throw errInvalidCommitMessage();
  }
  // Check for forbidden control characters
  for (let i = 0; i < msg.length; i++) {
    const code = msg.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      throw errInvalidCommitMessage();
    }
  }
  // Check byte length
  const byteLen = Buffer.byteLength(msg, "utf8");
  if (byteLen > MAX_MESSAGE_BYTES) {
    throw errInvalidCommitMessage();
  }
}

/**
 * Create a Change for a file addition or modification.
 * SPEC §7.5: "Uses a text change when the new content is text and the old path
 * is absent or text. Otherwise it uses put."
 */
function makeChange(path: string, oldBytes: Buffer | undefined, newBytes: Buffer): Change {
  const newIsText = isText(newBytes);

  if (newIsText) {
    const oldIsText = oldBytes === undefined ? true : isText(oldBytes);
    if (oldIsText) {
      // Use text change
      const oldTokens = oldBytes === undefined ? [] : tokenize(oldBytes.toString("utf8"));
      const newTokens = tokenize(newBytes.toString("utf8"));
      const editScript = diff(oldTokens, newTokens);
      return { type: "text", path, edit: editScript as readonly DiffOp[] };
    }
  }

  // Use put (binary, or text→binary transition)
  const content = newBytes.toString("base64");
  return { type: "put", path, content };
}

/**
 * Run the commit command.
 * Error precedence (DEC-015 + PLAN.md §7.5 rule 5):
 * 1. Find repo → errNotARepository
 * 2. Read repo
 * 3. Scan worktree → errUnsupportedEntry (priority 3)
 * 4. Read config → errInvalidContributorId if format invalid
 * 5. Check contributor.id present → errContributorIdRequired (priority 7)
 * 6. Validate message → errInvalidCommitMessage (priority 9, but before clean-tree per PLAN rule 5)
 * 7. Check clean tree → errWorkingTreeClean (priority 8)
 * 8. Execute
 */
export async function run(message: string, cwd: string): Promise<number> {
  // Step 1: Find repository
  const repoDir = findRepository(cwd);
  if (repoDir === null) {
    throw errNotARepository();
  }

  // Step 2: Read and validate repository
  const repo = await readRepository(repoDir);
  const { tree: currentTree } = replay(repo);

  // Step 3: Scan working tree, check for unsupported entries (DEC-015 priority 3)
  const entries = await scanWorktree(repoDir);
  for (const entry of entries) {
    if (entry.type === "unsupported") {
      throw errUnsupportedEntry(entry.path);
    }
  }

  // Step 4: Read config (throws on malformed/invalid config — e.g. errInvalidContributorId)
  // Done before message validation so config format errors fire at priority 7 (higher than 9).
  const config = await readConfig(repoDir);

  // Step 5: Check contributor ID present (DEC-015 priority 7)
  if (config.contributorId === undefined) {
    throw errContributorIdRequired();
  }
  const authorId = config.contributorId;

  // Step 6: Validate message (DEC-015 priority 9 but before clean-tree per PLAN.md §7.5 rule 5)
  validateCommitMessage(message);

  // Build working tree map
  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") {
      worktreeMap.set(entry.path, entry.buf);
    }
  }

  // Step 7: Check if working tree is dirty
  // Compute changes
  const allPaths = new Set<string>([...worktreeMap.keys(), ...currentTree.paths()]);

  const changes: Change[] = [];
  const sortedPaths = [...allPaths].sort(comparePaths);

  for (const path of sortedPaths) {
    const inRepo = currentTree.get(path);
    const inWork = worktreeMap.get(path);

    if (inWork !== undefined && inRepo === undefined) {
      // Added file
      changes.push(makeChange(path, undefined, inWork));
    } else if (inWork === undefined && inRepo !== undefined) {
      // Deleted file
      changes.push({ type: "delete", path });
    } else if (inWork !== undefined && inRepo !== undefined && !inWork.equals(inRepo)) {
      // Modified file
      changes.push(makeChange(path, inRepo, inWork));
    }
  }

  if (changes.length === 0) {
    throw errWorkingTreeClean();
  }

  // Step 8: Create the new patch
  const currentFrontier = repo.frontier;
  const authorRevision = (currentFrontier.get(authorId) ?? 0) + 1;

  const newPatch: Patch = {
    author: authorId,
    revision: authorRevision,
    base: currentFrontier,
    message,
    changes,
  };

  // Build new frontier
  const newFrontier = new Map(currentFrontier);
  newFrontier.set(authorId, authorRevision);

  // Build new patches list (sorted by author, then revision)
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

  // Step 9: Write repository
  await writeRepository(repoDir, newRepo);

  // Print new version
  const versionStr = formatVersionString(newFrontier);
  process.stdout.write(versionStr + "\n");

  return 0;
}

// Re-export for use in other commands
export { validateCommitMessage };
