// §4.5 ordered repository validation pipeline
// SPEC §4.5: validates schema, history, causal closure, and replay

import type { Repository, Patch, Change } from "./model.js";
import type { DiffOp } from "../core/diff.js";
import { validateContributorId } from "../core/contributor.js";
import { validatePath, comparePaths } from "../core/path.js";
import { isText, tokenize } from "../core/tokens.js";
import { validateEdit } from "../core/edit.js";
import {
  errRepositoryHasUnknownField,
  errUnknownField,
  errRevisionNotPositiveSafeInteger,
  errFrontierNotCanonical,
  errMissingPatch,
  errPatchMessageEmpty,
  errPatchChangesEmpty,
  errMustHaveOneOperation,
  errInsertIsEmpty,
  errPathIsInvalid,
  errNotCanonicalBase64,
  errUnreachablePatch,
  errTreePathsConflict,
  errCyclicOrIncompletePatchHistory,
  errDeleteOfAbsentPath,
  errNoOpChange,
  errAdjacentInsert,
  errInvalidContributorId,
  errInvalidCommitMessage,
  errInvalidJson,
} from "../errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER; // 9007199254740991

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Validate a parsed (unknown) JSON value as a Repository.
 * Implements §4.5 ordered validation pipeline.
 * Throws SnapError on the first violation.
 */
export function validateRepository(data: unknown): Repository {
  // Step 1: top-level structure
  const raw = requireObject(data);
  checkUnknownFieldsRepo(raw);

  // Step 2: format must be exactly the integer 1
  const format = raw["format"];
  if (!Number.isInteger(format) || (format as number) !== 1) {
    throw errRevisionNotPositiveSafeInteger("format");
  }

  // Step 3: frontier
  const frontierRaw = raw["frontier"];
  if (!Array.isArray(frontierRaw)) {
    throw errFrontierNotCanonical();
  }
  const frontier = parseVersionVectorArray(frontierRaw, true);

  // Step 4: patches array
  const patchesRaw = raw["patches"];
  if (!Array.isArray(patchesRaw)) {
    throw errInvalidJson();
  }

  // Parse all patches (static validation)
  const patches: Patch[] = [];
  for (const p of patchesRaw) {
    patches.push(validatePatchStatic(p));
  }

  // Step 5: patch sorting — by author (UTF-8 byte order) then numeric revision
  checkPatchSorting(patches);

  // Step 6: causal closure — every dot referenced in a base must exist in patches
  const patchMap = buildPatchMap(patches);
  checkCausalClosure(patches, patchMap);

  // Step 7: no unreachable patches — every patch must be in causal closure of frontier
  checkNoUnreachablePatches(patches, frontier);

  // Step 8: revision contiguity (revision = base[author] + 1) and prior revisions exist
  checkRevisionContiguity(patches, patchMap);

  // Step 9: dynamic replay-based validation
  replayAndValidate(patches, patchMap);

  return {
    format: 1,
    frontier,
    patches,
  };
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

function requireObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw errInvalidJson();
  }
  return v as Record<string, unknown>;
}

function checkUnknownFieldsRepo(obj: Record<string, unknown>): void {
  const allowed = new Set(["format", "frontier", "patches"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw errRepositoryHasUnknownField(key);
    }
  }
}

function checkUnknownFieldsPatch(obj: Record<string, unknown>): void {
  const allowed = new Set(["author", "revision", "base", "message", "changes"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw errUnknownField("patch", key);
    }
  }
}

function checkUnknownFieldsChangePut(obj: Record<string, unknown>): void {
  const allowed = new Set(["type", "path", "content"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw errUnknownField("change", key);
    }
  }
}

function checkUnknownFieldsChangeDelete(obj: Record<string, unknown>): void {
  const allowed = new Set(["type", "path"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw errUnknownField("change", key);
    }
  }
}

function checkUnknownFieldsChangeText(obj: Record<string, unknown>): void {
  const allowed = new Set(["type", "path", "edit"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw errUnknownField("change", key);
    }
  }
}

// ---------------------------------------------------------------------------
// Version vector parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw [[id, revision], ...] JSON array into a version vector Map.
 * If requireCanonical, also verifies strict UTF-8 byte-order ascending sorting of IDs.
 */
function parseVersionVectorArray(
  raw: unknown[],
  requireCanonical: boolean,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  let prevId: string | null = null;

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw errFrontierNotCanonical();
    }
    const [id, rev] = entry as [unknown, unknown];
    if (typeof id !== "string") {
      throw errFrontierNotCanonical();
    }
    if (!Number.isInteger(rev) || (rev as number) <= 0 || (rev as number) > MAX_SAFE_INTEGER) {
      throw errFrontierNotCanonical();
    }
    try {
      validateContributorId(id);
    } catch {
      throw errInvalidContributorId(id);
    }
    if (map.has(id)) {
      throw errFrontierNotCanonical();
    }
    if (requireCanonical && prevId !== null) {
      const bufPrev = Buffer.from(prevId, "utf8");
      const bufCurr = Buffer.from(id, "utf8");
      if (bufPrev.compare(bufCurr) >= 0) {
        throw errFrontierNotCanonical();
      }
    }
    map.set(id, rev as number);
    prevId = id;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Static patch validation
// ---------------------------------------------------------------------------

function validatePatchStatic(raw: unknown): Patch {
  const p = requireObject(raw);
  checkUnknownFieldsPatch(p);

  // author
  const author = p["author"];
  if (typeof author !== "string") {
    throw errInvalidContributorId(String(author));
  }
  try {
    validateContributorId(author);
  } catch {
    throw errInvalidContributorId(author);
  }

  // revision
  const revision = p["revision"];
  if (
    !Number.isInteger(revision) ||
    (revision as number) <= 0 ||
    (revision as number) > MAX_SAFE_INTEGER
  ) {
    throw errRevisionNotPositiveSafeInteger("revision");
  }

  // base
  const baseRaw = p["base"];
  if (!Array.isArray(baseRaw)) {
    throw errFrontierNotCanonical();
  }
  const base = parseVersionVectorArray(baseRaw, true);

  // message
  const message = p["message"];
  if (typeof message !== "string" || message.length === 0) {
    throw errPatchMessageEmpty();
  }
  validateMessage(message);

  // changes
  const changesRaw = p["changes"];
  if (!Array.isArray(changesRaw) || changesRaw.length === 0) {
    throw errPatchChangesEmpty();
  }
  const changes: Change[] = [];
  for (const c of changesRaw) {
    changes.push(validateChangeStatic(c));
  }

  // Changes must be sorted by path (UTF-8 byte order, no duplicates)
  for (let i = 1; i < changes.length; i++) {
    const prev = changes[i - 1]!;
    const curr = changes[i]!;
    if (comparePaths(prev.path, curr.path) >= 0) {
      // Out of order or duplicate path
      throw errUnknownField("patch", "changes order");
    }
  }

  return {
    author,
    revision: revision as number,
    base,
    message,
    changes,
  };
}

/**
 * Validate message: nonempty, no control chars except TAB and LF.
 * SPEC §4.2: "nonempty UTF-8 string; may contain tab and LF but no other ASCII control character"
 */
function validateMessage(message: string): void {
  for (let idx = 0; idx < message.length; idx++) {
    const code = message.charCodeAt(idx);
    // Control chars: 0x00–0x1F and 0x7F
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      // Forbidden control character
      throw errInvalidCommitMessage();
    }
  }
}

function validateChangeStatic(raw: unknown): Change {
  const c = requireObject(raw);

  const type = c["type"];
  if (typeof type !== "string") {
    throw errMustHaveOneOperation();
  }

  switch (type) {
    case "put": {
      checkUnknownFieldsChangePut(c);
      const path = requireValidPath(c["path"]);
      const content = c["content"];
      if (typeof content !== "string") {
        throw errNotCanonicalBase64();
      }
      validateBase64(content);
      return { type: "put", path, content };
    }
    case "delete": {
      checkUnknownFieldsChangeDelete(c);
      const path = requireValidPath(c["path"]);
      return { type: "delete", path };
    }
    case "text": {
      checkUnknownFieldsChangeText(c);
      const path = requireValidPath(c["path"]);
      const edit = validateEditStatic(c["edit"]);
      return { type: "text", path, edit };
    }
    default:
      throw errMustHaveOneOperation();
  }
}

function requireValidPath(raw: unknown): string {
  if (typeof raw !== "string") {
    throw errPathIsInvalid(String(raw));
  }
  try {
    validatePath(raw);
  } catch {
    throw errPathIsInvalid(raw);
  }
  return raw;
}

/**
 * Validate base64: standard padded RFC 4648.
 * Re-encode to verify canonicality.
 */
function validateBase64(content: string): void {
  if (content.length % 4 !== 0) {
    throw errNotCanonicalBase64();
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw errNotCanonicalBase64();
  }
  const decoded = Buffer.from(content, "base64");
  const reEncoded = decoded.toString("base64");
  if (reEncoded !== content) {
    throw errNotCanonicalBase64();
  }
}

/**
 * Validate an edit script structurally (schema, types, adjacent-same-kind).
 * Does NOT check consumption count (that requires knowing base token count).
 */
function validateEditStatic(raw: unknown): readonly DiffOp[] {
  if (!Array.isArray(raw)) {
    throw errMustHaveOneOperation();
  }
  const ops: DiffOp[] = [];
  let prevType: string | null = null;

  for (const opRaw of raw) {
    const op = requireObject(opRaw);
    const keys = Object.keys(op);

    if (keys.length !== 1) {
      throw errMustHaveOneOperation();
    }

    const key = keys[0]!;
    const val = op[key];

    let typedOp: DiffOp;
    if (key === "retain") {
      if (!Number.isInteger(val) || (val as number) <= 0 || (val as number) > MAX_SAFE_INTEGER) {
        throw errRevisionNotPositiveSafeInteger("retain count");
      }
      typedOp = { type: "retain", count: val as number };
    } else if (key === "delete") {
      if (!Number.isInteger(val) || (val as number) <= 0 || (val as number) > MAX_SAFE_INTEGER) {
        throw errRevisionNotPositiveSafeInteger("delete count");
      }
      typedOp = { type: "delete", count: val as number };
    } else if (key === "insert") {
      if (!Array.isArray(val) || val.length === 0) {
        throw errInsertIsEmpty();
      }
      const tokens: string[] = [];
      for (const tok of val) {
        if (typeof tok !== "string" || tok.length === 0) {
          throw errInsertIsEmpty();
        }
        tokens.push(tok);
      }
      typedOp = { type: "insert", tokens };
    } else {
      throw errMustHaveOneOperation();
    }

    // Adjacent same-kind check
    if (typedOp.type === prevType) {
      throw errAdjacentInsert();
    }
    prevType = typedOp.type;

    ops.push(typedOp);
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Sorting and structural checks
// ---------------------------------------------------------------------------

function checkPatchSorting(patches: readonly Patch[]): void {
  for (let i = 1; i < patches.length; i++) {
    const prev = patches[i - 1]!;
    const curr = patches[i]!;
    const bufPrev = Buffer.from(prev.author, "utf8");
    const bufCurr = Buffer.from(curr.author, "utf8");
    const authorCmp = bufPrev.compare(bufCurr);
    if (authorCmp > 0 || (authorCmp === 0 && prev.revision >= curr.revision)) {
      throw errFrontierNotCanonical();
    }
  }
}

function buildPatchMap(patches: readonly Patch[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i]!;
    map.set(dotKey(p.author, p.revision), i);
  }
  return map;
}

function dotKey(author: string, revision: number): string {
  return `${author}:${revision}`;
}

function checkCausalClosure(patches: readonly Patch[], patchMap: Map<string, number>): void {
  for (const patch of patches) {
    for (const [author, revision] of patch.base) {
      if (!patchMap.has(dotKey(author, revision))) {
        throw errMissingPatch(author, revision);
      }
    }
  }
}

function checkNoUnreachablePatches(
  patches: readonly Patch[],
  frontier: ReadonlyMap<string, number>,
): void {
  for (const patch of patches) {
    const frontierRev = frontier.get(patch.author) ?? 0;
    if (patch.revision > frontierRev) {
      const dot = `${patch.author}->${patch.revision}`;
      throw errUnreachablePatch(dot);
    }
  }
}

function checkRevisionContiguity(patches: readonly Patch[], patchMap: Map<string, number>): void {
  for (const patch of patches) {
    const expectedBaseRev = patch.base.get(patch.author) ?? 0;
    if (patch.revision !== expectedBaseRev + 1) {
      throw errRevisionNotPositiveSafeInteger("revision sequence");
    }
    // All revisions up to revision-1 must exist for this author
    if (patch.revision > 1) {
      if (!patchMap.has(dotKey(patch.author, patch.revision - 1))) {
        throw errMissingPatch(patch.author, patch.revision - 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic replay-based validation
// ---------------------------------------------------------------------------

type SimpleTree = Map<string, Buffer>;

/**
 * Check if a result tree is prefix-free.
 * Two paths conflict if one is an ancestor of the other.
 */
function checkTreePrefixFree(tree: SimpleTree): void {
  const paths = [...tree.keys()].sort();
  for (let i = 0; i < paths.length - 1; i++) {
    const a = paths[i]!;
    const b = paths[i + 1]!;
    if (b.startsWith(a + "/")) {
      throw errTreePathsConflict(a, b);
    }
  }
}

/**
 * Compute the Snap-order key for a patch's result version.
 * Returns a number array for comparison (same as snapOrder but produces sortable keys).
 */
function snapOrderPatches(a: Patch, b: Patch): number {
  const aResult = new Map(a.base);
  aResult.set(a.author, a.revision);
  const bResult = new Map(b.base);
  bResult.set(b.author, b.revision);

  const allKeys = [...new Set([...aResult.keys(), ...bResult.keys()])];
  allKeys.sort((x, y) => Buffer.from(x, "utf8").compare(Buffer.from(y, "utf8")));

  for (const key of allKeys) {
    const av = aResult.get(key) ?? 0;
    const bv = bResult.get(key) ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  // Tiebreak by author, then revision
  const authorCmp = Buffer.from(a.author, "utf8").compare(Buffer.from(b.author, "utf8"));
  if (authorCmp !== 0) return authorCmp;
  return a.revision - b.revision;
}

/**
 * Apply an edit script to base tokens, returning result tokens.
 */
function applyEditTokens(baseTokens: readonly string[], edit: readonly DiffOp[]): string[] {
  const result: string[] = [];
  let pos = 0;
  for (const op of edit) {
    if (op.type === "retain") {
      for (let k = 0; k < op.count; k++) {
        result.push(baseTokens[pos]!);
        pos++;
      }
    } else if (op.type === "delete") {
      pos += op.count;
    } else {
      for (const tok of op.tokens) {
        result.push(tok);
      }
    }
  }
  return result;
}

/**
 * Validate token canonicality for the result of an insert.
 * SPEC §4.4: every token except possibly the final one ends in LF,
 * and no token contains LF before its final byte.
 */
function validateResultTokens(tokens: string[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.length === 0) {
      throw errInsertIsEmpty();
    }
    const lfIdx = tok.indexOf("\n");
    if (lfIdx !== -1 && lfIdx !== tok.length - 1) {
      // Mid-token LF — not a valid token
      throw errInsertIsEmpty();
    }
    if (i < tokens.length - 1 && tok[tok.length - 1] !== "\n") {
      // Non-last token must end in LF
      throw errInsertIsEmpty();
    }
  }
}

/**
 * Validate and apply a single change against the base tree, writing to result tree.
 */
function validateAndApplyChange(
  change: Change,
  baseTree: SimpleTree,
  resultTree: SimpleTree,
): void {
  const baseBytes = baseTree.get(change.path);
  const baseExists = baseBytes !== undefined;

  switch (change.type) {
    case "put": {
      const newBytes = Buffer.from(change.content, "base64");
      if (baseExists && baseBytes.equals(newBytes)) {
        throw errNoOpChange();
      }
      // SPEC §4.3: put creation requires path absent; put replacement requires present.
      // But actually both are allowed by PUT (it's "atomic create or replacement").
      // The no-op check above covers the case where bytes don't change.
      resultTree.set(change.path, newBytes);
      break;
    }

    case "delete": {
      if (!baseExists) {
        throw errDeleteOfAbsentPath(change.path);
      }
      resultTree.delete(change.path);
      break;
    }

    case "text": {
      if (change.edit.length === 0) {
        // Empty edit: valid only for creating an empty text file (base absent or empty)
        if (baseExists) {
          // Text edit on existing path with empty edit
          if (!isText(baseBytes)) {
            // DEC-018: text change on binary base is a validation error
            throw errUnknownField("change", "text change on binary base");
          }
          const baseText = baseBytes.toString("utf8");
          const baseTokens = tokenize(baseText);
          // Empty edit, non-empty base → does not consume old content
          validateEdit(baseTokens, []); // will throw errDoesNotConsumeOldContent if baseTokens.length > 0
          // If base is empty text (0 tokens) + empty edit → no-op
          // Empty text file + empty edit = no-op change (bytes unchanged = empty)
          if (baseBytes.length === 0) {
            throw errNoOpChange();
          }
          // (shouldn't reach here since validateEdit would throw for non-empty base)
          resultTree.set(change.path, Buffer.alloc(0));
        } else {
          // Create empty file
          resultTree.set(change.path, Buffer.alloc(0));
        }
      } else {
        // Non-empty edit
        if (baseExists) {
          if (!isText(baseBytes)) {
            // DEC-018: text change on binary base is validation error
            throw errUnknownField("change", "text change on binary base");
          }
          const baseText = baseBytes.toString("utf8");
          const baseTokens = tokenize(baseText);
          // This may throw errDoesNotConsumeOldContent or errConsumesBeeyondOldContent
          validateEdit(baseTokens, change.edit);
          const resultTokens = applyEditTokens(baseTokens, change.edit);
          validateResultTokens(resultTokens);
          const resultBytes = Buffer.from(resultTokens.join(""), "utf8");
          if (baseBytes.equals(resultBytes)) {
            throw errNoOpChange();
          }
          resultTree.set(change.path, resultBytes);
        } else {
          // Creating new file via text edit
          // Base tokens = [] (empty)
          validateEdit([], change.edit); // retain/delete on empty base → errConsumesBeeyondOldContent
          const resultTokens = applyEditTokens([], change.edit);
          validateResultTokens(resultTokens);
          const resultBytes = Buffer.from(resultTokens.join(""), "utf8");
          resultTree.set(change.path, resultBytes);
        }
      }
      break;
    }
  }
}

/**
 * Full replay-based validation using topological sort with Snap-order tie-breaking.
 * SPEC §6.1: repeatedly find ready patches (bases fully integrated), choose least by Snap order.
 */
function replayAndValidate(patches: readonly Patch[], patchMap: Map<string, number>): void {
  const integrated = new Set<string>();
  const treeCache = new Map<string, SimpleTree>();
  let currentTree: SimpleTree = new Map();

  // Build a set of all patch keys
  const allKeys = new Set<string>(patches.map((p) => dotKey(p.author, p.revision)));

  while (integrated.size < patches.length) {
    // Find ready patches: all base dependencies are integrated
    const ready: Patch[] = [];
    for (const key of allKeys) {
      if (integrated.has(key)) continue;
      const idx = patchMap.get(key);
      if (idx === undefined) continue;
      const patch = patches[idx]!;

      let allBaseReady = true;
      for (const [author, rev] of patch.base) {
        // All revisions 1..rev must be integrated
        for (let r = 1; r <= rev; r++) {
          if (!integrated.has(dotKey(author, r))) {
            allBaseReady = false;
            break;
          }
        }
        if (!allBaseReady) break;
      }
      if (allBaseReady) {
        ready.push(patch);
      }
    }

    if (ready.length === 0) {
      throw errCyclicOrIncompletePatchHistory();
    }

    // Sort by Snap order of result version, then author, then revision
    ready.sort(snapOrderPatches);

    // Pick the least ready patch
    const patch = ready[0]!;
    const key = dotKey(patch.author, patch.revision);

    // Build the base tree for this patch
    // The base tree is the result tree after applying all patches in patch.base
    // Since we maintain currentTree in integration order, we need the exact base
    // (only patches with (c, n) where n <= base[c]).
    // For the exact base tree, we need to re-materialize from scratch or use treeCache.
    const baseTree = materializeBaseTree(patch.base, patches, patchMap, treeCache);

    // Validate and apply changes to result tree
    const resultTree = new Map(baseTree);
    for (const change of patch.changes) {
      validateAndApplyChange(change, baseTree, resultTree);
    }

    // Check prefix-free
    checkTreePrefixFree(resultTree);

    // Cache
    treeCache.set(key, resultTree);
    currentTree = resultTree;
    void currentTree; // currentTree is used conceptually but we use treeCache for base lookups

    integrated.add(key);
  }
}

/**
 * Materialize the exact tree for a version vector by replaying patches in Snap order.
 * Uses treeCache to avoid redundant work.
 */
function materializeBaseTree(
  base: ReadonlyMap<string, number>,
  patches: readonly Patch[],
  patchMap: Map<string, number>,
  treeCache: Map<string, SimpleTree>,
): SimpleTree {
  if (base.size === 0) {
    return new Map();
  }

  // Collect patches selected by base (revision <= base[author])
  const selected: Patch[] = [];
  for (const p of patches) {
    const baseRev = base.get(p.author) ?? 0;
    if (p.revision <= baseRev) {
      selected.push(p);
    }
  }

  if (selected.length === 0) {
    return new Map();
  }

  // The last patch in Snap-order integration gives the result tree
  // (since we've already validated all patches before calling this on subsequent ones,
  // the result tree for any patch in the base should be in treeCache)
  // Sort by Snap order
  selected.sort(snapOrderPatches);
  const last = selected[selected.length - 1]!;
  const lastKey = dotKey(last.author, last.revision);

  if (treeCache.has(lastKey)) {
    const cached = treeCache.get(lastKey);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Not cached yet — shouldn't happen if we process in order, but handle gracefully
  // by building it from scratch
  let tree: SimpleTree = new Map();
  const localIntegrated = new Set<string>();

  // Process in Snap order
  for (const patch of selected) {
    const key = dotKey(patch.author, patch.revision);
    if (localIntegrated.has(key)) continue;

    if (treeCache.has(key)) {
      const cached = treeCache.get(key);
      if (cached !== undefined) {
        tree = new Map(cached);
      }
      localIntegrated.add(key);
      continue;
    }

    const patchBase = materializeBaseTree(patch.base, patches, patchMap, treeCache);
    const resultTree = new Map(patchBase);
    for (const change of patch.changes) {
      validateAndApplyChange(change, patchBase, resultTree);
    }
    treeCache.set(key, resultTree);
    tree = resultTree;
    localIntegrated.add(key);
  }

  return tree;
}
