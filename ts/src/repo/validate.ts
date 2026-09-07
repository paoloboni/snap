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
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

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
 * Returns the first violation as an error value.
 */
export function validateRepository(data: unknown): SnapResult<Repository> {
  // Step 1: top-level structure
  const rawResult = requireObject(data);
  if (!rawResult.ok) return err(rawResult.error);
  const raw = rawResult.value;

  const unknownFields = checkUnknownFieldsRepo(raw);
  if (!unknownFields.ok) return err(unknownFields.error);

  // Step 2: format must be exactly the integer 1
  const format = raw["format"];
  if (!Number.isInteger(format) || (format as number) !== 1) {
    return err(errRevisionNotPositiveSafeInteger("format"));
  }

  // Step 3: frontier
  const frontierRaw = raw["frontier"];
  if (!Array.isArray(frontierRaw)) {
    return err(errFrontierNotCanonical());
  }
  const frontierResult = parseVersionVectorArray(frontierRaw, true);
  if (!frontierResult.ok) return err(frontierResult.error);
  const frontier = frontierResult.value;

  // Step 4: patches array
  const patchesRaw = raw["patches"];
  if (!Array.isArray(patchesRaw)) {
    return err(errInvalidJson());
  }

  // Parse all patches (static validation)
  const patches: Patch[] = [];
  for (const p of patchesRaw) {
    const patch = validatePatchStatic(p);
    if (!patch.ok) return err(patch.error);
    patches.push(patch.value);
  }

  // Step 5: patch sorting — by author (UTF-8 byte order) then numeric revision
  const sorting = checkPatchSorting(patches);
  if (!sorting.ok) return err(sorting.error);

  // Step 6: causal closure — every dot referenced in a base must exist in patches
  const patchMap = buildPatchMap(patches);
  const closure = checkCausalClosure(patches, patchMap);
  if (!closure.ok) return err(closure.error);

  // Step 7: no unreachable patches — every patch must be in causal closure of frontier
  const reachable = checkNoUnreachablePatches(patches, frontier);
  if (!reachable.ok) return err(reachable.error);

  // Step 8: revision contiguity (revision = base[author] + 1) and prior revisions exist
  const contiguity = checkRevisionContiguity(patches, patchMap);
  if (!contiguity.ok) return err(contiguity.error);

  // Step 9: dynamic replay-based validation
  const replayed = replayAndValidate(patches, patchMap);
  if (!replayed.ok) return err(replayed.error);

  return ok({
    format: 1,
    frontier,
    patches,
  });
}

// ---------------------------------------------------------------------------
// Structural helpers
// ---------------------------------------------------------------------------

function requireObject(v: unknown): SnapResult<Record<string, unknown>> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return err(errInvalidJson());
  }
  return ok(v as Record<string, unknown>);
}

function checkUnknownFieldsRepo(obj: Record<string, unknown>): SnapResult<void> {
  const allowed = new Set(["format", "frontier", "patches"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return err(errRepositoryHasUnknownField(key));
    }
  }
  return ok(undefined);
}

function checkUnknownFieldsPatch(obj: Record<string, unknown>): SnapResult<void> {
  const allowed = new Set(["author", "revision", "base", "message", "changes"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return err(errUnknownField("patch", key));
    }
  }
  return ok(undefined);
}

function checkUnknownFieldsChangePut(obj: Record<string, unknown>): SnapResult<void> {
  const allowed = new Set(["type", "path", "content"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return err(errUnknownField("change", key));
    }
  }
  return ok(undefined);
}

function checkUnknownFieldsChangeDelete(obj: Record<string, unknown>): SnapResult<void> {
  const allowed = new Set(["type", "path"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return err(errUnknownField("change", key));
    }
  }
  return ok(undefined);
}

function checkUnknownFieldsChangeText(obj: Record<string, unknown>): SnapResult<void> {
  const allowed = new Set(["type", "path", "edit"]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      return err(errUnknownField("change", key));
    }
  }
  return ok(undefined);
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
): SnapResult<ReadonlyMap<string, number>> {
  const map = new Map<string, number>();
  let prevId: string | null = null;

  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      return err(errFrontierNotCanonical());
    }
    const [id, rev] = entry as [unknown, unknown];
    if (typeof id !== "string") {
      return err(errFrontierNotCanonical());
    }
    if (!Number.isInteger(rev) || (rev as number) <= 0 || (rev as number) > MAX_SAFE_INTEGER) {
      return err(errFrontierNotCanonical());
    }
    if (!validateContributorId(id).ok) {
      return err(errInvalidContributorId(id));
    }
    if (map.has(id)) {
      return err(errFrontierNotCanonical());
    }
    if (requireCanonical && prevId !== null) {
      const bufPrev = Buffer.from(prevId, "utf8");
      const bufCurr = Buffer.from(id, "utf8");
      if (bufPrev.compare(bufCurr) >= 0) {
        return err(errFrontierNotCanonical());
      }
    }
    map.set(id, rev as number);
    prevId = id;
  }
  return ok(map);
}

// ---------------------------------------------------------------------------
// Static patch validation
// ---------------------------------------------------------------------------

function validatePatchStatic(raw: unknown): SnapResult<Patch> {
  const pResult = requireObject(raw);
  if (!pResult.ok) return err(pResult.error);
  const p = pResult.value;

  const unknownFields = checkUnknownFieldsPatch(p);
  if (!unknownFields.ok) return err(unknownFields.error);

  // author
  const author = p["author"];
  if (typeof author !== "string") {
    return err(errInvalidContributorId(String(author)));
  }
  if (!validateContributorId(author).ok) {
    return err(errInvalidContributorId(author));
  }

  // revision
  const revision = p["revision"];
  if (
    !Number.isInteger(revision) ||
    (revision as number) <= 0 ||
    (revision as number) > MAX_SAFE_INTEGER
  ) {
    return err(errRevisionNotPositiveSafeInteger("revision"));
  }

  // base
  const baseRaw = p["base"];
  if (!Array.isArray(baseRaw)) {
    return err(errFrontierNotCanonical());
  }
  const baseResult = parseVersionVectorArray(baseRaw, true);
  if (!baseResult.ok) return err(baseResult.error);
  const base = baseResult.value;

  // message
  const message = p["message"];
  if (typeof message !== "string" || message.length === 0) {
    return err(errPatchMessageEmpty());
  }
  const messageCheck = validateMessage(message);
  if (!messageCheck.ok) return err(messageCheck.error);

  // changes
  const changesRaw = p["changes"];
  if (!Array.isArray(changesRaw) || changesRaw.length === 0) {
    return err(errPatchChangesEmpty());
  }
  const changes: Change[] = [];
  for (const c of changesRaw) {
    const change = validateChangeStatic(c);
    if (!change.ok) return err(change.error);
    changes.push(change.value);
  }

  // Changes must be sorted by path (UTF-8 byte order, no duplicates)
  for (let i = 1; i < changes.length; i++) {
    const prev = changes[i - 1]!;
    const curr = changes[i]!;
    if (comparePaths(prev.path, curr.path) >= 0) {
      // Out of order or duplicate path
      return err(errUnknownField("patch", "changes order"));
    }
  }

  return ok({
    author,
    revision: revision as number,
    base,
    message,
    changes,
  });
}

/**
 * Validate message: nonempty, no control chars except TAB and LF.
 * SPEC §4.2: "nonempty UTF-8 string; may contain tab and LF but no other ASCII control character"
 */
function validateMessage(message: string): SnapResult<void> {
  for (let idx = 0; idx < message.length; idx++) {
    const code = message.charCodeAt(idx);
    // Control chars: 0x00–0x1F and 0x7F
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      // Forbidden control character
      return err(errInvalidCommitMessage());
    }
  }
  return ok(undefined);
}

function validateChangeStatic(raw: unknown): SnapResult<Change> {
  const cResult = requireObject(raw);
  if (!cResult.ok) return err(cResult.error);
  const c = cResult.value;

  const type = c["type"];
  if (typeof type !== "string") {
    return err(errMustHaveOneOperation());
  }

  switch (type) {
    case "put": {
      const unknownFields = checkUnknownFieldsChangePut(c);
      if (!unknownFields.ok) return err(unknownFields.error);
      const path = requireValidPath(c["path"]);
      if (!path.ok) return err(path.error);
      const content = c["content"];
      if (typeof content !== "string") {
        return err(errNotCanonicalBase64());
      }
      const base64Check = validateBase64(content);
      if (!base64Check.ok) return err(base64Check.error);
      return ok({ type: "put", path: path.value, content });
    }
    case "delete": {
      const unknownFields = checkUnknownFieldsChangeDelete(c);
      if (!unknownFields.ok) return err(unknownFields.error);
      const path = requireValidPath(c["path"]);
      if (!path.ok) return err(path.error);
      return ok({ type: "delete", path: path.value });
    }
    case "text": {
      const unknownFields = checkUnknownFieldsChangeText(c);
      if (!unknownFields.ok) return err(unknownFields.error);
      const path = requireValidPath(c["path"]);
      if (!path.ok) return err(path.error);
      const edit = validateEditStatic(c["edit"]);
      if (!edit.ok) return err(edit.error);
      return ok({ type: "text", path: path.value, edit: edit.value });
    }
    default:
      return err(errMustHaveOneOperation());
  }
}

function requireValidPath(raw: unknown): SnapResult<string> {
  if (typeof raw !== "string") {
    return err(errPathIsInvalid(String(raw)));
  }
  if (!validatePath(raw).ok) {
    return err(errPathIsInvalid(raw));
  }
  return ok(raw);
}

/**
 * Validate base64: standard padded RFC 4648.
 * Re-encode to verify canonicality.
 */
function validateBase64(content: string): SnapResult<void> {
  if (content.length % 4 !== 0) {
    return err(errNotCanonicalBase64());
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    return err(errNotCanonicalBase64());
  }
  const decoded = Buffer.from(content, "base64");
  const reEncoded = decoded.toString("base64");
  if (reEncoded !== content) {
    return err(errNotCanonicalBase64());
  }
  return ok(undefined);
}

/**
 * Validate an edit script structurally (schema, types, adjacent-same-kind).
 * Does NOT check consumption count (that requires knowing base token count).
 */
function validateEditStatic(raw: unknown): SnapResult<readonly DiffOp[]> {
  if (!Array.isArray(raw)) {
    return err(errMustHaveOneOperation());
  }
  const ops: DiffOp[] = [];
  let prevType: string | null = null;

  for (const opRaw of raw) {
    const opResult = requireObject(opRaw);
    if (!opResult.ok) return err(opResult.error);
    const op = opResult.value;
    const keys = Object.keys(op);

    if (keys.length !== 1) {
      return err(errMustHaveOneOperation());
    }

    const key = keys[0]!;
    const val = op[key];

    let typedOp: DiffOp;
    if (key === "retain") {
      if (!Number.isInteger(val) || (val as number) <= 0 || (val as number) > MAX_SAFE_INTEGER) {
        return err(errRevisionNotPositiveSafeInteger("retain count"));
      }
      typedOp = { type: "retain", count: val as number };
    } else if (key === "delete") {
      if (!Number.isInteger(val) || (val as number) <= 0 || (val as number) > MAX_SAFE_INTEGER) {
        return err(errRevisionNotPositiveSafeInteger("delete count"));
      }
      typedOp = { type: "delete", count: val as number };
    } else if (key === "insert") {
      if (!Array.isArray(val) || val.length === 0) {
        return err(errInsertIsEmpty());
      }
      const tokens: string[] = [];
      for (const tok of val) {
        if (typeof tok !== "string" || tok.length === 0) {
          return err(errInsertIsEmpty());
        }
        tokens.push(tok);
      }
      typedOp = { type: "insert", tokens };
    } else {
      return err(errMustHaveOneOperation());
    }

    // Adjacent same-kind check
    if (typedOp.type === prevType) {
      return err(errAdjacentInsert());
    }
    prevType = typedOp.type;

    ops.push(typedOp);
  }

  return ok(ops);
}

// ---------------------------------------------------------------------------
// Sorting and structural checks
// ---------------------------------------------------------------------------

function checkPatchSorting(patches: readonly Patch[]): SnapResult<void> {
  for (let i = 1; i < patches.length; i++) {
    const prev = patches[i - 1]!;
    const curr = patches[i]!;
    const bufPrev = Buffer.from(prev.author, "utf8");
    const bufCurr = Buffer.from(curr.author, "utf8");
    const authorCmp = bufPrev.compare(bufCurr);
    if (authorCmp > 0 || (authorCmp === 0 && prev.revision >= curr.revision)) {
      return err(errFrontierNotCanonical());
    }
  }
  return ok(undefined);
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

function checkCausalClosure(
  patches: readonly Patch[],
  patchMap: Map<string, number>,
): SnapResult<void> {
  for (const patch of patches) {
    for (const [author, revision] of patch.base) {
      if (!patchMap.has(dotKey(author, revision))) {
        return err(errMissingPatch(author, revision));
      }
    }
  }
  return ok(undefined);
}

function checkNoUnreachablePatches(
  patches: readonly Patch[],
  frontier: ReadonlyMap<string, number>,
): SnapResult<void> {
  for (const patch of patches) {
    const frontierRev = frontier.get(patch.author) ?? 0;
    if (patch.revision > frontierRev) {
      const dot = `${patch.author}->${patch.revision}`;
      return err(errUnreachablePatch(dot));
    }
  }
  return ok(undefined);
}

function checkRevisionContiguity(
  patches: readonly Patch[],
  patchMap: Map<string, number>,
): SnapResult<void> {
  for (const patch of patches) {
    const expectedBaseRev = patch.base.get(patch.author) ?? 0;
    if (patch.revision !== expectedBaseRev + 1) {
      return err(errRevisionNotPositiveSafeInteger("revision sequence"));
    }
    // All revisions up to revision-1 must exist for this author
    if (patch.revision > 1) {
      if (!patchMap.has(dotKey(patch.author, patch.revision - 1))) {
        return err(errMissingPatch(patch.author, patch.revision - 1));
      }
    }
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Dynamic replay-based validation
// ---------------------------------------------------------------------------

type SimpleTree = Map<string, Buffer>;

/**
 * Check if a result tree is prefix-free.
 * Two paths conflict if one is an ancestor of the other.
 */
function checkTreePrefixFree(tree: SimpleTree): SnapResult<void> {
  const paths = [...tree.keys()].sort();
  for (let i = 0; i < paths.length - 1; i++) {
    const a = paths[i]!;
    const b = paths[i + 1]!;
    if (b.startsWith(a + "/")) {
      return err(errTreePathsConflict(a, b));
    }
  }
  return ok(undefined);
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
function validateResultTokens(tokens: string[]): SnapResult<void> {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.length === 0) {
      return err(errInsertIsEmpty());
    }
    const lfIdx = tok.indexOf("\n");
    if (lfIdx !== -1 && lfIdx !== tok.length - 1) {
      // Mid-token LF — not a valid token
      return err(errInsertIsEmpty());
    }
    if (i < tokens.length - 1 && tok[tok.length - 1] !== "\n") {
      // Non-last token must end in LF
      return err(errInsertIsEmpty());
    }
  }
  return ok(undefined);
}

/**
 * Validate and apply a single change against the base tree, writing to result tree.
 */
function validateAndApplyChange(
  change: Change,
  baseTree: SimpleTree,
  resultTree: SimpleTree,
): SnapResult<void> {
  const baseBytes = baseTree.get(change.path);
  const baseExists = baseBytes !== undefined;

  switch (change.type) {
    case "put": {
      const newBytes = Buffer.from(change.content, "base64");
      if (baseExists && baseBytes.equals(newBytes)) {
        return err(errNoOpChange());
      }
      // SPEC §4.3: put creation requires path absent; put replacement requires present.
      // But actually both are allowed by PUT (it's "atomic create or replacement").
      // The no-op check above covers the case where bytes don't change.
      resultTree.set(change.path, newBytes);
      break;
    }

    case "delete": {
      if (!baseExists) {
        return err(errDeleteOfAbsentPath(change.path));
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
            return err(errUnknownField("change", "text change on binary base"));
          }
          const baseText = baseBytes.toString("utf8");
          const baseTokens = tokenize(baseText);
          // Empty edit, non-empty base → does not consume old content
          const editCheck = validateEdit(baseTokens, []);
          if (!editCheck.ok) return err(editCheck.error);
          // If base is empty text (0 tokens) + empty edit → no-op
          // Empty text file + empty edit = no-op change (bytes unchanged = empty)
          if (baseBytes.length === 0) {
            return err(errNoOpChange());
          }
          // (shouldn't reach here since validateEdit would fail for non-empty base)
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
            return err(errUnknownField("change", "text change on binary base"));
          }
          const baseText = baseBytes.toString("utf8");
          const baseTokens = tokenize(baseText);
          // This may yield errDoesNotConsumeOldContent or errConsumesBeeyondOldContent
          const editCheck = validateEdit(baseTokens, change.edit);
          if (!editCheck.ok) return err(editCheck.error);
          const resultTokens = applyEditTokens(baseTokens, change.edit);
          const tokenCheck = validateResultTokens(resultTokens);
          if (!tokenCheck.ok) return err(tokenCheck.error);
          const resultBytes = Buffer.from(resultTokens.join(""), "utf8");
          if (baseBytes.equals(resultBytes)) {
            return err(errNoOpChange());
          }
          resultTree.set(change.path, resultBytes);
        } else {
          // Creating new file via text edit
          // Base tokens = [] (empty)
          // retain/delete on empty base → errConsumesBeeyondOldContent
          const editCheck = validateEdit([], change.edit);
          if (!editCheck.ok) return err(editCheck.error);
          const resultTokens = applyEditTokens([], change.edit);
          const tokenCheck = validateResultTokens(resultTokens);
          if (!tokenCheck.ok) return err(tokenCheck.error);
          const resultBytes = Buffer.from(resultTokens.join(""), "utf8");
          resultTree.set(change.path, resultBytes);
        }
      }
      break;
    }
  }

  return ok(undefined);
}

/**
 * Full replay-based validation using topological sort with Snap-order tie-breaking.
 * SPEC §6.1: repeatedly find ready patches (bases fully integrated), choose least by Snap order.
 */
function replayAndValidate(
  patches: readonly Patch[],
  patchMap: Map<string, number>,
): SnapResult<void> {
  const integrated = new Set<string>();
  const treeCache = new Map<string, SimpleTree>();

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
      return err(errCyclicOrIncompletePatchHistory());
    }

    // Sort by Snap order of result version, then author, then revision
    ready.sort(snapOrderPatches);

    // Pick the least ready patch
    const patch = ready[0]!;
    const key = dotKey(patch.author, patch.revision);

    // Build the base tree for this patch
    // The base tree is the result tree after applying all patches in patch.base
    // (only patches with (c, n) where n <= base[c]).
    const baseTreeResult = materializeBaseTree(patch.base, patches, patchMap, treeCache);
    if (!baseTreeResult.ok) return err(baseTreeResult.error);
    const baseTree = baseTreeResult.value;

    // Validate and apply changes to result tree
    const resultTree = new Map(baseTree);
    for (const change of patch.changes) {
      const applied = validateAndApplyChange(change, baseTree, resultTree);
      if (!applied.ok) return err(applied.error);
    }

    // Check prefix-free
    const prefixFree = checkTreePrefixFree(resultTree);
    if (!prefixFree.ok) return err(prefixFree.error);

    // Cache
    treeCache.set(key, resultTree);

    integrated.add(key);
  }

  return ok(undefined);
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
): SnapResult<SimpleTree> {
  if (base.size === 0) {
    return ok(new Map());
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
    return ok(new Map());
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
      return ok(cached);
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

    const patchBaseResult = materializeBaseTree(patch.base, patches, patchMap, treeCache);
    if (!patchBaseResult.ok) return err(patchBaseResult.error);
    const patchBase = patchBaseResult.value;

    const resultTree = new Map(patchBase);
    for (const change of patch.changes) {
      const applied = validateAndApplyChange(change, patchBase, resultTree);
      if (!applied.ok) return err(applied.error);
    }
    treeCache.set(key, resultTree);
    tree = resultTree;
    localIntegrated.add(key);
  }

  return ok(tree);
}
