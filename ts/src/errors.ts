// SnapError class and full message catalogue
// Every factory function corresponds to a §7.1–§7.4 pinned string.

export class SnapError extends Error {
  constructor(
    message: string,
    public readonly exitCode: 1 | 2 = 1,
  ) {
    super(message);
    this.name = "SnapError";
  }
}

// ---------------------------------------------------------------------------
// §7.1 Byte-exact stderr lines
// ---------------------------------------------------------------------------

export function errWorkingTreeClean(): SnapError {
  return new SnapError("snap: working tree is clean");
}

export function errWorkingTreeDirty(): SnapError {
  return new SnapError("snap: working tree is dirty");
}

export function errTargetTreeAlreadyCurrent(): SnapError {
  return new SnapError("snap: target tree is already current");
}

export function errUnsupportedEntry(path: string): SnapError {
  return new SnapError(`snap: unsupported working tree entry: ${path}`);
}

export function errNotARepository(): SnapError {
  return new SnapError("snap: not a Snap repository");
}

export function errInvalidCommandOrArguments(): SnapError {
  return new SnapError("snap: invalid command or arguments");
}

export function errInvalidPort(port: number | string): SnapError {
  return new SnapError(`snap: invalid port: ${port}`);
}

export function errUnknownVersion(version: string): SnapError {
  return new SnapError(`snap: unknown version: ${version}`);
}

export function errContributorIdRequired(): SnapError {
  return new SnapError("snap: contributor.id is required; configure it locally or globally");
}

export function errInvalidCommitMessage(): SnapError {
  return new SnapError("snap: invalid commit message");
}

export function errRepositoryHasUnknownField(field: string): SnapError {
  return new SnapError(`snap: repository has unknown field: ${field}`);
}

export function errDeleteOfAbsentPath(path: string): SnapError {
  return new SnapError(`snap: delete of absent path: ${path}`);
}

export function errSnapColorInvalid(): SnapError {
  return new SnapError("snap: SNAP_COLOR must be auto, always, or never");
}

// ---------------------------------------------------------------------------
// §7.2 Anchored single-line regex patterns
// ---------------------------------------------------------------------------

export function errFrontierNotCanonical(): SnapError {
  return new SnapError("snap: frontier is not canonically sorted");
}

export function errRevisionNotPositiveSafeInteger(context: string = "revision"): SnapError {
  return new SnapError(`snap: ${context} must be a positive safe integer`);
}

export function errUnreachablePatch(version: string): SnapError {
  return new SnapError(`snap: unreachable patch: ${version}`);
}

export function errPatchMessageEmpty(): SnapError {
  return new SnapError("snap: patch message is empty");
}

export function errPatchChangesEmpty(): SnapError {
  return new SnapError("snap: patch changes is empty");
}

export function errUnknownField(context: string, field: string): SnapError {
  return new SnapError(`snap: ${context} has unknown field: ${field}`);
}

export function errMustHaveOneOperation(): SnapError {
  return new SnapError("snap: change must have one operation");
}

export function errInsertIsEmpty(): SnapError {
  return new SnapError("snap: edit insert is empty");
}

export function errConsumesBeeyondOldContent(): SnapError {
  return new SnapError("snap: edit consumes beyond old content");
}

export function errUsageDiff(): SnapError {
  return new SnapError("snap: usage: snap diff <old> [<new>] [--repo <url>]");
}

export function errDuplicateJsonKey(key: string): SnapError {
  return new SnapError(`snap: duplicate JSON key ${key}`);
}

export function errInvalidContributorId(id: string): SnapError {
  return new SnapError(`snap: invalid contributor id: ${id}`);
}

export function errInvalidVersion(v: string): SnapError {
  return new SnapError(`snap: invalid version: ${v}`);
}

// ---------------------------------------------------------------------------
// §7.3 Required substrings
// ---------------------------------------------------------------------------

export function errRepositoryAlreadyExists(): SnapError {
  return new SnapError("snap: repository already exists");
}

export function errCannotInitializeInsideRepository(): SnapError {
  return new SnapError("snap: cannot initialize inside repository");
}

export function errInvalidJson(): SnapError {
  return new SnapError("snap: invalid JSON");
}

export function errHttpRedirect(status: number): SnapError {
  return new SnapError(`snap: HTTP ${status}: unexpected redirect`);
}

export function errMissingPatch(version: string, revision: number): SnapError {
  return new SnapError(`snap: missing ${version} revision ${revision}`);
}

export function errPathIsInvalid(path: string): SnapError {
  return new SnapError(`snap: path is invalid: ${path}`);
}

export function errNotCanonicalBase64(): SnapError {
  return new SnapError("snap: edit is not canonical base64");
}

export function errDoesNotConsumeOldContent(): SnapError {
  return new SnapError("snap: edit does not consume old content");
}

export function errTreePathsConflict(a: string, b: string): SnapError {
  return new SnapError(`snap: tree paths conflict: ${a} and ${b}`);
}

export function errCyclicOrIncompletePatchHistory(): SnapError {
  return new SnapError("snap: cyclic or incomplete patch history");
}

export function errNoOpChange(): SnapError {
  return new SnapError("snap: no-op change");
}

export function errAdjacentInsert(): SnapError {
  return new SnapError("snap: adjacent insert");
}

export function errPatchCollision(author: string, revision: number): SnapError {
  return new SnapError(`snap: patch collision: ${author} revision ${revision}`);
}

// ---------------------------------------------------------------------------
// Exit code 2 — unexpected internal failure
// ---------------------------------------------------------------------------

export function errInternalError(e: unknown): SnapError {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "internal error";
  return new SnapError(`snap: internal error: ${msg}`, 2);
}
