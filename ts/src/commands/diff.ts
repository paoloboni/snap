// snap diff [<old> [<new>] [--repo <repo>]] — unified text diff between versions or working tree
// SPEC §7.6, §7.11

import * as nodePath from "node:path";
import * as fs from "node:fs/promises";
import { findRepository, readRepository } from "../repo/store.js";
import { parseJSON } from "../repo/json.js";
import { validateRepository } from "../repo/validate.js";
import { fetchRemote } from "../net/client.js";
import {
  errNotARepository,
  errInvalidVersion,
  errUnknownVersion,
  errUnsupportedEntry,
  errPatchCollision,
} from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";
import { replay } from "../repo/replay.js";
import { scanWorktree } from "../fsys/worktree.js";
import { parseVersionString } from "../core/version.js";
import { isText, tokenize } from "../core/tokens.js";
import { diff } from "../core/diff.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";
import type { Tree } from "../core/tree.js";
import type { VersionVector } from "../core/version.js";
import type { Repository } from "../repo/model.js";
import type { Patch } from "../repo/model.js";
import type { DiffOp } from "../core/diff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isVersionKnown(version: VersionVector, repo: Repository): boolean {
  for (const [author, maxRev] of version) {
    for (let r = 1; r <= maxRev; r++) {
      if (!repo.patches.some((p) => p.author === author && p.revision === r)) {
        return false;
      }
    }
  }
  return true;
}

function materializeVersion(version: VersionVector, repo: Repository): SnapResult<Tree> {
  const selectedPatches = repo.patches.filter((p) => p.revision <= (version.get(p.author) ?? 0));
  const subRepo: Repository = { format: 1, frontier: version, patches: selectedPatches };
  const replayed = replay(subRepo);
  if (!replayed.ok) return err(replayed.error);
  return ok(replayed.value.tree);
}

function checkCrossRepoDots(local: Repository, remote: Repository): SnapResult<void> {
  const localMap = new Map<string, Patch>();
  for (const p of local.patches) localMap.set(`${p.author}@${p.revision}`, p);
  for (const rp of remote.patches) {
    const lp = localMap.get(`${rp.author}@${rp.revision}`);
    if (lp !== undefined && !patchesStructurallyEqual(lp, rp)) {
      return err(errPatchCollision(rp.author, rp.revision));
    }
  }
  return ok(undefined);
}

function patchesStructurallyEqual(a: Patch, b: Patch): boolean {
  if (a.author !== b.author || a.revision !== b.revision || a.message !== b.message) return false;
  if (!vectEqual(a.base, b.base)) return false;
  if (a.changes.length !== b.changes.length) return false;
  for (let i = 0; i < a.changes.length; i++) {
    const ca = a.changes[i]!;
    const cb = b.changes[i]!;
    if (ca.type !== cb.type || ca.path !== cb.path) return false;
    if (ca.type === "put" && cb.type === "put" && ca.content !== cb.content) return false;
    if (ca.type === "text" && cb.type === "text") {
      if (ca.edit.length !== cb.edit.length) return false;
      for (let j = 0; j < ca.edit.length; j++) {
        const oa = ca.edit[j]!;
        const ob = cb.edit[j]!;
        if (oa.type !== ob.type) return false;
        if (oa.type === "retain" && ob.type === "retain" && oa.count !== ob.count) return false;
        if (oa.type === "delete" && ob.type === "delete" && oa.count !== ob.count) return false;
        if (oa.type === "insert" && ob.type === "insert") {
          if (oa.tokens.length !== ob.tokens.length) return false;
          for (let k = 0; k < oa.tokens.length; k++) {
            if (oa.tokens[k] !== ob.tokens[k]) return false;
          }
        }
      }
    }
  }
  return true;
}

function vectEqual(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

async function loadRemoteRepo(url: string, cwd: string): Promise<SnapResult<Repository>> {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return fetchRemote(url);
  }
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

// ---------------------------------------------------------------------------
// Diff rendering
// ---------------------------------------------------------------------------

/**
 * Apply color to a plain diff output line (line excludes LF).
 * SPEC §7.11: first applicable style wins:
 *   "--- " or "+++ " → bold (1)
 *   "@@ "            → cyan (36)
 *   "-"              → red (31)
 *   "+"              → green (32)
 *   "\ "             → dim (2)
 *   "Binary files "  → yellow (33)
 *   other            → unchanged
 */
function colorDiffLine(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    return S(1, line);
  }
  if (line.startsWith("@@ ")) {
    return S(36, line);
  }
  if (line.startsWith("-")) {
    return S(31, line);
  }
  if (line.startsWith("+")) {
    return S(32, line);
  }
  if (line.startsWith("\\ ")) {
    return S(2, line);
  }
  if (line.startsWith("Binary files ")) {
    return S(33, line);
  }
  return line;
}

/**
 * Transform plain diff output to terminal colored output.
 * Lines are separated by LF; each line (sans LF) is passed through colorDiffLine.
 */
function applyDiffColor(plain: string): string {
  if (plain.length === 0) return plain;
  // Split by LF — each line ends with LF
  const lines = plain.split("\n");
  // Last element is "" if string ends with LF
  const result: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    result.push(colorDiffLine(lines[i]!) + "\n");
  }
  // If there's a trailing non-empty element, include it (shouldn't happen normally)
  const tail = lines[lines.length - 1]!;
  if (tail.length > 0) {
    result.push(colorDiffLine(tail));
  }
  return result.join("");
}

/**
 * Render a single diff line. If token doesn't end with LF, adds
 * LF and "\ No newline at end of file\n".
 */
function renderToken(prefix: string, token: string): string {
  if (token.endsWith("\n")) {
    return `${prefix}${token}`;
  }
  return `${prefix}${token}\n\\ No newline at end of file\n`;
}

/**
 * Render a unified diff block for two token sequences.
 * DEC-019: start line always 1; count 0 for absent side.
 * DEC-012: emit block even for 0→0 (existence change).
 */
function renderTextBlock(
  oldHeader: string,
  newHeader: string,
  oldTokens: readonly string[],
  newTokens: readonly string[],
): string {
  const editScript: readonly DiffOp[] = diff(oldTokens, newTokens);
  let out = `--- ${oldHeader}\n+++ ${newHeader}\n`;
  out += `@@ -1,${oldTokens.length} +1,${newTokens.length} @@\n`;

  let oldPos = 0;
  for (const op of editScript) {
    if (op.type === "retain") {
      for (let i = 0; i < op.count; i++) {
        out += renderToken(" ", oldTokens[oldPos]!);
        oldPos++;
      }
    } else if (op.type === "delete") {
      for (let i = 0; i < op.count; i++) {
        out += renderToken("-", oldTokens[oldPos]!);
        oldPos++;
      }
    } else {
      for (const token of op.tokens) {
        out += renderToken("+", token);
      }
    }
  }
  return out;
}

/**
 * Render a diff between an old map (Tree or Map<string,Buffer>) and a new map.
 * oldGet: (path) → Buffer | undefined
 * newGet: (path) → Buffer | undefined
 * allPaths: sorted array of all paths to consider
 */
function renderDiffGeneric(
  allPaths: readonly string[],
  oldGet: (p: string) => Buffer | undefined,
  newGet: (p: string) => Buffer | undefined,
): string {
  let out = "";

  for (const path of allPaths) {
    const oldBytes = oldGet(path);
    const newBytes = newGet(path);

    // Unchanged
    if (oldBytes !== undefined && newBytes !== undefined && oldBytes.equals(newBytes)) {
      continue;
    }

    const oldLabel = oldBytes === undefined ? "/dev/null" : `a/${path}`;
    const newLabel = newBytes === undefined ? "/dev/null" : `b/${path}`;

    if (oldBytes === undefined && newBytes !== undefined && isText(newBytes)) {
      // New text file (or empty file)
      const tokens = tokenize(newBytes.toString("utf8"));
      out += renderTextBlock("/dev/null", `b/${path}`, [], tokens);
    } else if (oldBytes !== undefined && isText(oldBytes) && newBytes === undefined) {
      // Deleted text file
      const tokens = tokenize(oldBytes.toString("utf8"));
      out += renderTextBlock(`a/${path}`, "/dev/null", tokens, []);
    } else if (
      oldBytes !== undefined &&
      isText(oldBytes) &&
      newBytes !== undefined &&
      isText(newBytes)
    ) {
      // Text modified
      const oldTokens = tokenize(oldBytes.toString("utf8"));
      const newTokens = tokenize(newBytes.toString("utf8"));
      out += renderTextBlock(`a/${path}`, `b/${path}`, oldTokens, newTokens);
    } else {
      // Binary (created, deleted, or modified, or mixed text/binary)
      out += `Binary files ${oldLabel} and ${newLabel} differ\n`;
    }
  }

  return out;
}

function sortedUnionPaths(aKeys: readonly string[], bKeys: readonly string[]): string[] {
  const all = new Set<string>([...aKeys, ...bKeys]);
  return [...all].sort((a, b) => Buffer.from(a, "utf8").compare(Buffer.from(b, "utf8")));
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

export async function run(
  oldSpec: string | undefined,
  newSpec: string | undefined,
  repoUrl: string | undefined,
  cwd: string,
): Promise<SnapResult<number>> {
  if (oldSpec === undefined) {
    return runWorkingTreeDiff(cwd);
  }

  // Parse old version (syntax check)
  const parsedOld = parseVersionString(oldSpec);
  if (!parsedOld.ok) {
    return err(errInvalidVersion(oldSpec));
  }
  const oldVersion = parsedOld.value;

  if (newSpec === undefined) {
    return runVersionVsWorktreeDiff(oldVersion, oldSpec, cwd);
  }

  // Two-version diff: fully validate old (syntax already checked above) then new.
  // DEC-015: "diff old operand before new" — old must be fully checked (syntax + known)
  // before new is checked at all.
  return runTwoVersionDiff(oldVersion, oldSpec, newSpec, repoUrl, cwd);
}

function writeDiff(plain: string): void {
  if (plain.length === 0) return;
  if (colorMode(process.stdout)) {
    process.stdout.write(applyDiffColor(plain));
  } else {
    process.stdout.write(plain);
  }
}

async function runWorkingTreeDiff(cwd: string): Promise<SnapResult<number>> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) return err(errNotARepository());

  const repoResult = await readRepository(repoDir);
  if (!repoResult.ok) return err(repoResult.error);

  const replayed = replay(repoResult.value);
  if (!replayed.ok) return err(replayed.error);
  const currentTree = replayed.value.tree;

  const scanned = await scanWorktree(repoDir);
  if (!scanned.ok) return err(scanned.error);
  const entries = scanned.value;

  for (const entry of entries) {
    if (entry.type === "unsupported") return err(errUnsupportedEntry(entry.path));
  }

  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") worktreeMap.set(entry.path, entry.buf);
  }

  const paths = sortedUnionPaths(currentTree.paths(), [...worktreeMap.keys()]);
  const out = renderDiffGeneric(
    paths,
    (p) => currentTree.get(p),
    (p) => worktreeMap.get(p),
  );

  writeDiff(out);
  return ok(0);
}

async function runVersionVsWorktreeDiff(
  oldVersion: VersionVector,
  oldSpec: string,
  cwd: string,
): Promise<SnapResult<number>> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) return err(errNotARepository());

  const repoResult = await readRepository(repoDir);
  if (!repoResult.ok) return err(repoResult.error);
  const repo = repoResult.value;

  if (!isVersionKnown(oldVersion, repo)) return err(errUnknownVersion(oldSpec));

  const oldTreeResult = materializeVersion(oldVersion, repo);
  if (!oldTreeResult.ok) return err(oldTreeResult.error);
  const oldTree = oldTreeResult.value;

  const scanned = await scanWorktree(repoDir);
  if (!scanned.ok) return err(scanned.error);
  const entries = scanned.value;

  for (const entry of entries) {
    if (entry.type === "unsupported") return err(errUnsupportedEntry(entry.path));
  }

  const worktreeMap = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.type === "tracked") worktreeMap.set(entry.path, entry.buf);
  }

  const paths = sortedUnionPaths(oldTree.paths(), [...worktreeMap.keys()]);
  const out = renderDiffGeneric(
    paths,
    (p) => oldTree.get(p),
    (p) => worktreeMap.get(p),
  );

  writeDiff(out);
  return ok(0);
}

async function runTwoVersionDiff(
  oldVersion: VersionVector,
  oldSpec: string,
  newSpec: string,
  repoUrl: string | undefined,
  cwd: string,
): Promise<SnapResult<number>> {
  const repoDir = findRepository(cwd);
  if (repoDir === null) return err(errNotARepository());

  const localRepoResult = await readRepository(repoDir);
  if (!localRepoResult.ok) return err(localRepoResult.error);
  const localRepo = localRepoResult.value;

  // DEC-015: fully validate old operand (syntax already checked by caller; now check known)
  // before parsing or checking new operand.
  if (!isVersionKnown(oldVersion, localRepo)) return err(errUnknownVersion(oldSpec));

  const oldTreeResult = materializeVersion(oldVersion, localRepo);
  if (!oldTreeResult.ok) return err(oldTreeResult.error);
  const oldTree = oldTreeResult.value;

  // Now parse new version (syntax check)
  const parsedNew = parseVersionString(newSpec);
  if (!parsedNew.ok) {
    return err(errInvalidVersion(newSpec));
  }
  const newVersion = parsedNew.value;

  let newTree: Tree;

  if (repoUrl !== undefined) {
    const remoteRepoResult = await loadRemoteRepo(repoUrl, cwd);
    if (!remoteRepoResult.ok) return err(remoteRepoResult.error);
    const remoteRepo = remoteRepoResult.value;

    const dotsCheck = checkCrossRepoDots(localRepo, remoteRepo);
    if (!dotsCheck.ok) return err(dotsCheck.error);

    if (!isVersionKnown(newVersion, remoteRepo)) return err(errUnknownVersion(newSpec));

    const newTreeResult = materializeVersion(newVersion, remoteRepo);
    if (!newTreeResult.ok) return err(newTreeResult.error);
    newTree = newTreeResult.value;
  } else {
    if (!isVersionKnown(newVersion, localRepo)) return err(errUnknownVersion(newSpec));

    const newTreeResult = materializeVersion(newVersion, localRepo);
    if (!newTreeResult.ok) return err(newTreeResult.error);
    newTree = newTreeResult.value;
  }

  const paths = sortedUnionPaths(oldTree.paths(), newTree.paths());
  const out = renderDiffGeneric(
    paths,
    (p) => oldTree.get(p),
    (p) => newTree.get(p),
  );

  writeDiff(out);
  return ok(0);
}
