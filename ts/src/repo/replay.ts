// §6.1/6.2/6.4 deterministic replay with heap ordering, OT, and warning collection
// SPEC.md §6.1–6.4, PLAN.md §7.4, §7.5 rules 2 and 5

import type { Repository, Patch, Change } from "./model.js";
import type { Tree } from "../core/tree.js";
import { emptyTree } from "../core/tree.js";
import { snapOrder, joinVectors, compareVectors, formatVersionString } from "../core/version.js";
import type { VersionVector } from "../core/version.js";
import type { DiffOp } from "../core/diff.js";
import { isText, tokenize } from "../core/tokens.js";
import { diff } from "../core/diff.js";
import { transform } from "../core/ot.js";
import { applyEdit } from "../core/edit.js";
import {
  errCyclicOrIncompletePatchHistory,
  errUnreachablePatch,
  errPatchCollision,
  errDeleteOfAbsentPath,
} from "../errors.js";

export type Warning = { readonly path: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Patch result vector computation
// ---------------------------------------------------------------------------

function patchResultVector(patch: Patch): VersionVector {
  const result = new Map<string, number>(patch.base);
  result.set(patch.author, patch.revision);
  return result;
}

// ---------------------------------------------------------------------------
// Check if all base dependencies of a patch are satisfied
// ---------------------------------------------------------------------------

function allBasesApplied(patch: Patch, appliedDots: Set<string>): boolean {
  // A patch's base is a version vector. We need every (author, revision) pair
  // where revision <= base[author] to be applied.
  // Since patches are validated to have causal closure, we just need to check
  // that for each author in the base vector, the patch at that revision has been applied.
  for (const [author, revision] of patch.base) {
    // Check all revisions 1..revision for this author are applied
    for (let r = 1; r <= revision; r++) {
      if (!appliedDots.has(`${author}@${r}`)) {
        return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// MinHeap for patch scheduling
// ---------------------------------------------------------------------------

type HeapEntry = {
  patch: Patch;
  resultVector: VersionVector;
};

function heapCompare(a: HeapEntry, b: HeapEntry): number {
  // Compare by snapOrder of result vectors first
  const so = snapOrder(a.resultVector, b.resultVector);
  if (so !== 0) return so;
  // Then by author (UTF-8 byte order)
  const aBuf = Buffer.from(a.patch.author, "utf8");
  const bBuf = Buffer.from(b.patch.author, "utf8");
  const ac = aBuf.compare(bBuf);
  if (ac !== 0) return ac;
  // Then by revision
  if (a.patch.revision < b.patch.revision) return -1;
  if (a.patch.revision > b.patch.revision) return 1;
  return 0;
}

class MinHeap {
  private data: HeapEntry[] = [];

  push(entry: HeapEntry): void {
    this.data.push(entry);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  get size(): number {
    return this.data.length;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heapCompare(this.data[i]!, this.data[parent]!) < 0) {
        const tmp = this.data[i]!;
        this.data[i] = this.data[parent]!;
        this.data[parent] = tmp;
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    let cur = i;
    for (;;) {
      let smallest = cur;
      const left = 2 * cur + 1;
      const right = 2 * cur + 2;
      if (left < n && heapCompare(this.data[left]!, this.data[smallest]!) < 0) {
        smallest = left;
      }
      if (right < n && heapCompare(this.data[right]!, this.data[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest !== cur) {
        const tmp = this.data[cur]!;
        this.data[cur] = this.data[smallest]!;
        this.data[smallest] = tmp;
        cur = smallest;
      } else {
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Materialize the exact base tree for a patch
// ---------------------------------------------------------------------------

/**
 * Given the history of applied patches (in integration order) and their
 * corresponding tree states, materialize the tree at exactly base vector B.
 *
 * A patch (author, revision) is in B iff revision <= B[author].
 * We replay from empty tree, applying only patches selected by B.
 */
function materializeBaseTree(appliedPatches: Patch[], base: VersionVector): Tree {
  // Select patches where result vector <= base
  const selected: Patch[] = [];
  for (const p of appliedPatches) {
    const result = patchResultVector(p);
    const cmp = compareVectors(result, base);
    if (cmp === -1 || cmp === 0) {
      selected.push(p);
    }
  }

  // Apply selected patches in integration order (they're already in order)
  let tree = emptyTree();
  for (const p of selected) {
    tree = applyPatchToTree(p, tree, tree).tree;
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Compute what T (authored result) would be for a change applied to base tree B
// ---------------------------------------------------------------------------

function computeT(change: Change, B: Tree): Buffer | undefined {
  switch (change.type) {
    case "put":
      return Buffer.from(change.content, "base64");
    case "delete":
      return undefined;
    case "text": {
      const existing = B.get(change.path);
      if (existing !== undefined && isText(existing)) {
        const baseTokens = tokenize(existing.toString("utf8"));
        const newTokens = applyEdit(baseTokens, change.edit);
        return Buffer.from(newTokens.join(""), "utf8");
      } else if (existing === undefined) {
        // Create from empty
        const newTokens = applyEdit([], change.edit);
        return Buffer.from(newTokens.join(""), "utf8");
      }
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Integration result for a single patch
// ---------------------------------------------------------------------------

type IntegrationResult = {
  tree: Tree;
  warnings: Warning[];
};

/**
 * Integrate patch P into current tree C.
 * B is the exact base tree for P.
 * appliedResultVectors: result vectors of all already-applied patches (for later-create-wins ordering)
 */
function applyPatchToTree(patch: Patch, C: Tree, B: Tree): IntegrationResult {
  const warnings: Warning[] = [];

  // --- Step 1: Resolve namespace conflicts (SPEC §6.2) ---
  // S = paths that P makes present (puts or creates via text/put, not deletes)
  // For namespace conflicts: a path in S has an ancestor/descendant already in C
  // (after removing paths that P authored as deletions from C).

  // Compute C' = C with every path that P authored as a deletion removed
  let Cprime = C;
  for (const change of patch.changes) {
    if (change.type === "delete") {
      Cprime = Cprime.delete(change.path);
    }
  }

  // S = paths that P makes present
  const S: string[] = [];
  for (const change of patch.changes) {
    if (change.type !== "delete") {
      S.push(change.path);
    }
  }

  // For each path in S, check for namespace conflicts in C'
  // A conflict exists if a path in S has a different ancestor or descendant in C'
  const namespaceWinsInstall = new Set<string>(); // paths from S to install (overriding conflicts)
  const namespaceWinsRemove = new Set<string>(); // current paths to remove from C

  for (const sPath of S) {
    // Check if sPath is an ancestor of any path in C' (C' has "sPath/xxx")
    const desc = Cprime.descendants(sPath);
    for (const d of desc) {
      if (d !== sPath) {
        // sPath/xxx exists in C' — namespace conflict: sPath wins
        namespaceWinsInstall.add(sPath);
        namespaceWinsRemove.add(d);
      }
    }

    // Check if any ancestor of sPath exists in C' as a file (not just as directory prefix)
    // i.e., check each prefix segment of sPath
    const segments = sPath.split("/");
    for (let i = 1; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join("/");
      if (Cprime.has(ancestor)) {
        // ancestor exists as a file in C' — namespace conflict: sPath wins
        namespaceWinsInstall.add(sPath);
        namespaceWinsRemove.add(ancestor);
      }
    }
  }

  // Emit namespace-wins warnings for removed current paths
  for (const removed of namespaceWinsRemove) {
    warnings.push({ path: removed, reason: "namespace-wins" });
  }

  // Start with C minus the namespace-conflict removals
  let resultTree = C;
  for (const removed of namespaceWinsRemove) {
    resultTree = resultTree.delete(removed);
  }

  // --- Step 2: Apply each change ---
  for (const change of patch.changes) {
    const path = change.path;
    const B_bytes = B.get(path);
    const C_bytes = C.get(path);

    // Compute T (authored result)
    const T_bytes = computeT(change, B);

    // If this path was settled by the namespace rule (it's being installed)
    if (namespaceWinsInstall.has(path)) {
      // Install the authored result directly
      if (T_bytes !== undefined) {
        resultTree = resultTree.set(path, T_bytes);
      } else {
        resultTree = resultTree.delete(path);
      }
      continue;
    }

    // Per-path rules (SPEC §6.2 and §6.4)
    // Rule 1: If B == C (identical in base and current), apply authored change directly
    const bEqualsC =
      B_bytes === undefined && C_bytes === undefined
        ? true
        : B_bytes !== undefined && C_bytes !== undefined
          ? B_bytes.equals(C_bytes)
          : false;

    if (bEqualsC) {
      // Apply the authored change directly
      if (T_bytes !== undefined) {
        resultTree = resultTree.set(path, T_bytes);
      } else {
        // delete: validate path exists in B
        if (B_bytes === undefined) {
          throw errDeleteOfAbsentPath(path);
        }
        resultTree = resultTree.delete(path);
      }
      continue;
    }

    // Check if C == T
    const cEqualsT =
      C_bytes === undefined && T_bytes === undefined
        ? true
        : C_bytes !== undefined && T_bytes !== undefined
          ? C_bytes.equals(T_bytes)
          : false;

    // Rule from SPEC §6.2 item 2: If C == T, keep unchanged (no warning)
    if (cEqualsT) {
      // No-op, C already equals the desired result
      continue;
    }

    // Now check OT conditions: B, C, T are all text and P is a text change
    if (
      change.type === "text" &&
      B_bytes !== undefined &&
      isText(B_bytes) &&
      C_bytes !== undefined &&
      isText(C_bytes) &&
      T_bytes !== undefined &&
      isText(T_bytes)
    ) {
      // OT path (SPEC §6.2 item 3):
      // Q = diff(B, C), P' = transform(P_edit, Q), apply P' to C
      const bTokens = tokenize(B_bytes.toString("utf8"));
      const cTokens = tokenize(C_bytes.toString("utf8"));
      const Q = diff(bTokens, cTokens);
      const Pprime = transform(change.edit, Q);
      const newTokens = applyEdit(cTokens, Pprime);
      const newContent = Buffer.from(newTokens.join(""), "utf8");
      resultTree = resultTree.set(path, newContent);
      continue;
    }

    // §6.4 path-level rules (apply in order):
    // Rule 1 already handled (B == C → apply directly)
    // Rule 2: C == T → keep unchanged (already handled above)
    // Rule 3: T is absent → incoming delete wins (delete-wins)
    if (T_bytes === undefined) {
      // delete-wins: the incoming delete wins
      // But only if C is present (otherwise it's already gone — no-op)
      if (C_bytes !== undefined) {
        warnings.push({ path, reason: "delete-wins" });
        resultTree = resultTree.delete(path);
      }
      // If C is absent and T is absent, effectively a no-op
      continue;
    }

    // Rule 4: B is present and C is absent → earlier concurrent delete wins (delete-wins)
    if (B_bytes !== undefined && C_bytes === undefined) {
      warnings.push({ path, reason: "delete-wins" });
      // C already has path absent, so no change needed
      continue;
    }

    // Rule 5: B is absent, C and T are present → later-create-wins
    // (T_bytes is known non-null here since T_bytes === undefined was handled above)
    if (B_bytes === undefined && C_bytes !== undefined) {
      // The canonically later create wins.
      // Integration order: P is being integrated AFTER C was built.
      // The "later" means the patch that comes later in canonical integration order.
      // Since we're integrating P now, P's create comes later than what's in C.
      // Per SPEC §6.4: "later always means canonical integration order"
      // P comes later in integration order (we're integrating it now, C was already there)
      // So P's result wins and C's create is the "earlier" one.
      // Wait - need to re-read carefully.
      //
      // SPEC §6.4 Rule 4: "If B is absent and C and T are present, the incoming
      // (canonically later) create wins (later-create-wins)"
      //
      // "incoming" = P's T wins. So install T, emit warning.
      warnings.push({ path, reason: "later-create-wins" });
      resultTree = resultTree.set(path, T_bytes);
      continue;
    }

    // Rule 6 (SPEC §6.4 rule 5): incoming change is put → later-put-wins
    if (change.type === "put") {
      warnings.push({ path, reason: "later-put-wins" });
      resultTree = resultTree.set(path, T_bytes);
      continue;
    }

    // Rule 7 (SPEC §6.4 rule 6): P is text but C is non-text → put-wins (C wins)
    // put-wins: the current non-text content wins
    warnings.push({ path, reason: "put-wins" });
    // C stays, no change to resultTree for this path
  }

  return { tree: resultTree, warnings };
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

/**
 * Replay all patches in snap order to produce the final tree.
 * SPEC §6.1–6.4
 */
export function replay(repo: Repository): { tree: Tree; warnings: readonly Warning[] } {
  const patches = repo.patches;
  const frontier = repo.frontier;

  // Select patches in causal closure of frontier
  // A patch (author, revision) is selected if revision <= frontier[author]
  const selectedPatches: Patch[] = [];
  for (const patch of patches) {
    const authorFrontier = frontier.get(patch.author) ?? 0;
    if (patch.revision <= authorFrontier) {
      selectedPatches.push(patch);
    }
  }

  // Check for unreachable patches (patches not in the causal closure of the frontier)
  // Per SPEC §4.1: "patches contains exactly the causal closure of frontier"
  // If a patch in the repo is NOT selected, it's unreachable
  for (const patch of patches) {
    const authorFrontier = frontier.get(patch.author) ?? 0;
    if (patch.revision > authorFrontier) {
      throw errUnreachablePatch(formatVersionString(patchResultVector(patch)));
    }
  }

  // Build dependency counter for each patch
  // A patch can be applied when all base dependencies are satisfied
  const appliedDots = new Set<string>(); // "author@revision" strings
  const appliedPatches: Patch[] = []; // in integration order
  let currentTree = emptyTree();
  const allWarnings: Warning[] = [];

  // Initialize the heap with patches that have no base dependencies (base = empty)
  const heap = new MinHeap();
  const remaining = new Set<Patch>(selectedPatches);

  // Initial ready patches: those with empty base
  for (const patch of selectedPatches) {
    if (allBasesApplied(patch, appliedDots)) {
      const resultVec = patchResultVector(patch);
      heap.push({ patch, resultVector: resultVec });
      remaining.delete(patch);
    }
  }

  while (heap.size > 0) {
    const entry = heap.pop()!;
    const patch = entry.patch;

    // Mark this patch as applied
    appliedDots.add(`${patch.author}@${patch.revision}`);

    // Materialize the exact base tree for this patch
    const B = materializeBaseTree(appliedPatches, patch.base);

    // Apply the patch with OT
    const result = applyPatchToTree(patch, currentTree, B);
    currentTree = result.tree;
    allWarnings.push(...result.warnings);

    appliedPatches.push(patch);

    // Check if any remaining patches are now ready
    for (const p of remaining) {
      if (allBasesApplied(p, appliedDots)) {
        const resultVec = patchResultVector(p);
        heap.push({ patch: p, resultVector: resultVec });
        remaining.delete(p);
      }
    }
  }

  // If there are still remaining patches, the history has a cycle or is incomplete
  if (remaining.size > 0) {
    throw errCyclicOrIncompletePatchHistory();
  }

  // Sort warnings by path, then reason
  allWarnings.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.reason < b.reason) return -1;
    if (a.reason > b.reason) return 1;
    return 0;
  });

  // Deduplicate warnings
  const uniqueWarnings: Warning[] = [];
  const seenWarnings = new Set<string>();
  for (const w of allWarnings) {
    const key = `${w.path}:${w.reason}`;
    if (!seenWarnings.has(key)) {
      seenWarnings.add(key);
      uniqueWarnings.push(w);
    }
  }

  return { tree: currentTree, warnings: uniqueWarnings };
}

// ---------------------------------------------------------------------------
// joinRepositories
// ---------------------------------------------------------------------------

/**
 * Merge two repositories.
 * SPEC §3.5, §6.5
 */
export function joinRepositories(
  local: Repository,
  remote: Repository,
): { repo: Repository; warnings: readonly Warning[] } {
  // Step 1: Check for patch collisions (same dot with different values)
  const localPatchMap = new Map<string, Patch>();
  for (const p of local.patches) {
    localPatchMap.set(`${p.author}@${p.revision}`, p);
  }

  for (const remotePatch of remote.patches) {
    const key = `${remotePatch.author}@${remotePatch.revision}`;
    const localPatch = localPatchMap.get(key);
    if (localPatch !== undefined) {
      // Check structural equality
      if (!patchesEqual(localPatch, remotePatch)) {
        throw errPatchCollision(remotePatch.author, remotePatch.revision);
      }
    }
  }

  // Step 2: Union of patches (set union by dot identity)
  const allPatchMap = new Map<string, Patch>(localPatchMap);
  for (const p of remote.patches) {
    const key = `${p.author}@${p.revision}`;
    if (!allPatchMap.has(key)) {
      allPatchMap.set(key, p);
    }
  }

  // Sort patches by author, then revision (SPEC §4.1)
  const allPatches = [...allPatchMap.values()].sort((a, b) => {
    const aBuf = Buffer.from(a.author, "utf8");
    const bBuf = Buffer.from(b.author, "utf8");
    const ac = aBuf.compare(bBuf);
    if (ac !== 0) return ac;
    return a.revision - b.revision;
  });

  // Step 3: Compute joined frontier
  const joinedFrontier = joinVectors(local.frontier, remote.frontier);

  // Step 4: Build merged repository
  const mergedRepo: Repository = {
    format: 1,
    frontier: joinedFrontier,
    patches: allPatches,
  };

  // Step 5: Replay to get final tree and warnings
  const { warnings } = replay(mergedRepo);

  return { repo: mergedRepo, warnings };
}

// ---------------------------------------------------------------------------
// Structural equality for patches (for collision detection)
// ---------------------------------------------------------------------------

function changesEqual(a: readonly Change[], b: readonly Change[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]!;
    const cb = b[i]!;
    if (ca.type !== cb.type || ca.path !== cb.path) return false;
    if (ca.type === "put" && cb.type === "put") {
      if (ca.content !== cb.content) return false;
    } else if (ca.type === "text" && cb.type === "text") {
      if (!editScriptsEqual(ca.edit, cb.edit)) return false;
    }
    // delete: just type + path, already checked
  }
  return true;
}

function editScriptsEqual(a: readonly DiffOp[], b: readonly DiffOp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const oa = a[i]!;
    const ob = b[i]!;
    if (oa.type !== ob.type) return false;
    if (oa.type === "retain" && ob.type === "retain") {
      if (oa.count !== ob.count) return false;
    } else if (oa.type === "delete" && ob.type === "delete") {
      if (oa.count !== ob.count) return false;
    } else if (oa.type === "insert" && ob.type === "insert") {
      if (oa.tokens.length !== ob.tokens.length) return false;
      for (let j = 0; j < oa.tokens.length; j++) {
        if (oa.tokens[j] !== ob.tokens[j]) return false;
      }
    }
  }
  return true;
}

function vectEqual(a: VersionVector, b: VersionVector): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

function patchesEqual(a: Patch, b: Patch): boolean {
  if (a.author !== b.author) return false;
  if (a.revision !== b.revision) return false;
  if (!vectEqual(a.base, b.base)) return false;
  if (a.message !== b.message) return false;
  if (!changesEqual(a.changes, b.changes)) return false;
  return true;
}
