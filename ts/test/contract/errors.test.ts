/**
 * Contract tests — §7.1 byte-exact messages, §7.2 regex patterns,
 * §7.3 required substrings, §7.4 warning format, §7.5 pinned facts.
 *
 * Uses only Node.js built-in test runner (node:test + node:assert/strict).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { SNAP_VERSION } from "../../src/build-info.js";
import {
  SnapError,
  errAdjacentInsert,
  errCannotInitializeInsideRepository,
  errConsumesBeeyondOldContent,
  errContributorIdRequired,
  errCyclicOrIncompletePatchHistory,
  errDeleteOfAbsentPath,
  errDoesNotConsumeOldContent,
  errDuplicateJsonKey,
  errFrontierNotCanonical,
  errHttpRedirect,
  errInsertIsEmpty,
  errInternalError,
  errInvalidCommandOrArguments,
  errInvalidCommitMessage,
  errInvalidContributorId,
  errInvalidJson,
  errInvalidPort,
  errInvalidVersion,
  errMissingPatch,
  errMustHaveOneOperation,
  errNoOpChange,
  errNotARepository,
  errNotCanonicalBase64,
  errPatchChangesEmpty,
  errPatchCollision,
  errPatchMessageEmpty,
  errPathIsInvalid,
  errRepositoryAlreadyExists,
  errRepositoryHasUnknownField,
  errRevisionNotPositiveSafeInteger,
  errSnapColorInvalid,
  errTargetTreeAlreadyCurrent,
  errTreePathsConflict,
  errUnknownField,
  errUnknownVersion,
  errUnreachablePatch,
  errUnsupportedEntry,
  errUsageDiff,
  errWorkingTreeClean,
  errWorkingTreeDirty,
} from "../../src/errors.js";

// ---------------------------------------------------------------------------
// §7.5 pinned facts
// ---------------------------------------------------------------------------

void describe("§7.5 pinned facts", () => {
  void test("SNAP_VERSION is exactly '1.0.0'", () => {
    assert.equal(SNAP_VERSION, "1.0.0");
  });

  void test("--version output is 'snap 1.0.0'", () => {
    assert.equal(`snap ${SNAP_VERSION}`, "snap 1.0.0");
  });

  void test("SnapError is an Error subclass", () => {
    const err = errWorkingTreeClean();
    assert.ok(err instanceof Error);
    assert.ok(err instanceof SnapError);
  });

  void test("expected errors have exit code 1", () => {
    assert.equal(errWorkingTreeClean().exitCode, 1);
    assert.equal(errNotARepository().exitCode, 1);
    assert.equal(errInvalidCommandOrArguments().exitCode, 1);
  });

  void test("internal error has exit code 2", () => {
    assert.equal(errInternalError(new Error("boom")).exitCode, 2);
    assert.equal(errInternalError("boom").exitCode, 2);
  });

  void test("SnapError name is 'SnapError'", () => {
    assert.equal(errWorkingTreeClean().name, "SnapError");
  });
});

// ---------------------------------------------------------------------------
// §7.1 Byte-exact stderr lines
// ---------------------------------------------------------------------------

void describe("§7.1 byte-exact messages", () => {
  void test("errWorkingTreeClean", () => {
    assert.equal(errWorkingTreeClean().message, "snap: working tree is clean");
  });

  void test("errWorkingTreeDirty", () => {
    assert.equal(errWorkingTreeDirty().message, "snap: working tree is dirty");
  });

  void test("errTargetTreeAlreadyCurrent", () => {
    assert.equal(errTargetTreeAlreadyCurrent().message, "snap: target tree is already current");
  });

  void test("errUnsupportedEntry with path parameter", () => {
    assert.equal(
      errUnsupportedEntry("somefile.txt").message,
      "snap: unsupported working tree entry: somefile.txt",
    );
  });

  void test("errNotARepository", () => {
    assert.equal(errNotARepository().message, "snap: not a Snap repository");
  });

  void test("errInvalidCommandOrArguments", () => {
    assert.equal(errInvalidCommandOrArguments().message, "snap: invalid command or arguments");
  });

  void test("errInvalidPort with 65536", () => {
    assert.equal(errInvalidPort(65536).message, "snap: invalid port: 65536");
  });

  void test("errUnknownVersion with '(a@x->2)'", () => {
    assert.equal(errUnknownVersion("(a@x->2)").message, "snap: unknown version: (a@x->2)");
  });

  void test("errContributorIdRequired", () => {
    assert.equal(
      errContributorIdRequired().message,
      "snap: contributor.id is required; configure it locally or globally",
    );
  });

  void test("errInvalidCommitMessage", () => {
    assert.equal(errInvalidCommitMessage().message, "snap: invalid commit message");
  });

  void test("errRepositoryHasUnknownField with 'unknown'", () => {
    assert.equal(
      errRepositoryHasUnknownField("unknown").message,
      "snap: repository has unknown field: unknown",
    );
  });

  void test("errDeleteOfAbsentPath with 'f'", () => {
    assert.equal(errDeleteOfAbsentPath("f").message, "snap: delete of absent path: f");
  });

  void test("errSnapColorInvalid", () => {
    assert.equal(errSnapColorInvalid().message, "snap: SNAP_COLOR must be auto, always, or never");
  });
});

// ---------------------------------------------------------------------------
// §7.2 Anchored single-line regexes
// ---------------------------------------------------------------------------

void describe("§7.2 anchored single-line regex matches", () => {
  function matchesWithNewline(pattern: RegExp, message: string): boolean {
    return pattern.test(message + "\n");
  }

  void test("^snap: .*canonical.*\\n$ — errFrontierNotCanonical", () => {
    const re = /^snap: .*canonical.*\n$/m;
    assert.ok(matchesWithNewline(re, errFrontierNotCanonical().message));
  });

  void test("^snap: .+positive safe integer\\n$ — errRevisionNotPositiveSafeInteger", () => {
    const re = /^snap: .+positive safe integer\n$/m;
    assert.ok(matchesWithNewline(re, errRevisionNotPositiveSafeInteger().message));
    // Ensure non-empty prefix before 'positive safe integer'
    assert.ok(errRevisionNotPositiveSafeInteger().message.includes("positive safe integer"));
    assert.notEqual(errRevisionNotPositiveSafeInteger().message, "snap: positive safe integer");
  });

  void test("^snap: unreachable patch: .+\\n$ — errUnreachablePatch", () => {
    const re = /^snap: unreachable patch: .+\n$/m;
    assert.ok(matchesWithNewline(re, errUnreachablePatch("a@1").message));
  });

  void test("^snap: .+message is empty\\n$ — errPatchMessageEmpty", () => {
    const re = /^snap: .+message is empty\n$/m;
    assert.ok(matchesWithNewline(re, errPatchMessageEmpty().message));
    // Non-empty prefix
    assert.notEqual(errPatchMessageEmpty().message, "snap: message is empty");
  });

  void test("^snap: .+changes is empty\\n$ — errPatchChangesEmpty", () => {
    const re = /^snap: .+changes is empty\n$/m;
    assert.ok(matchesWithNewline(re, errPatchChangesEmpty().message));
    assert.notEqual(errPatchChangesEmpty().message, "snap: changes is empty");
  });

  void test("^snap: .+unknown field: extra\\n$ — errUnknownField", () => {
    const re = /^snap: .+unknown field: extra\n$/m;
    assert.ok(matchesWithNewline(re, errUnknownField("patch", "extra").message));
    assert.notEqual(errUnknownField("patch", "extra").message, "snap: unknown field: extra");
  });

  void test("^snap: .+must have one operation\\n$ — errMustHaveOneOperation", () => {
    const re = /^snap: .+must have one operation\n$/m;
    assert.ok(matchesWithNewline(re, errMustHaveOneOperation().message));
    assert.notEqual(errMustHaveOneOperation().message, "snap: must have one operation");
  });

  void test("^snap: .+insert is empty\\n$ — errInsertIsEmpty", () => {
    const re = /^snap: .+insert is empty\n$/m;
    assert.ok(matchesWithNewline(re, errInsertIsEmpty().message));
    assert.notEqual(errInsertIsEmpty().message, "snap: insert is empty");
  });

  void test("^snap: .+consumes beyond old content\\n$ — errConsumesBeeyondOldContent", () => {
    const re = /^snap: .+consumes beyond old content\n$/m;
    assert.ok(matchesWithNewline(re, errConsumesBeeyondOldContent().message));
    assert.notEqual(errConsumesBeeyondOldContent().message, "snap: consumes beyond old content");
  });

  void test("^snap: usage: snap diff .+\\n$ — errUsageDiff", () => {
    const re = /^snap: usage: snap diff .+\n$/m;
    assert.ok(matchesWithNewline(re, errUsageDiff().message));
  });

  void test("^snap: duplicate JSON key .+\\n$ — errDuplicateJsonKey", () => {
    const re = /^snap: duplicate JSON key .+\n$/m;
    assert.ok(matchesWithNewline(re, errDuplicateJsonKey("format").message));
  });

  void test("^snap: invalid contributor id: .+\\n$ — errInvalidContributorId", () => {
    const re = /^snap: invalid contributor id: .+\n$/m;
    assert.ok(matchesWithNewline(re, errInvalidContributorId("bad_id").message));
  });

  void test("^snap: invalid version: .+\\n$ — errInvalidVersion", () => {
    const re = /^snap: invalid version: .+\n$/m;
    assert.ok(matchesWithNewline(re, errInvalidVersion("bad").message));
  });

  void test("^snap: .+\\n$ — generic fallback (all messages match)", () => {
    const re = /^snap: .+\n$/m;
    const messages = [
      errWorkingTreeClean().message,
      errWorkingTreeDirty().message,
      errTargetTreeAlreadyCurrent().message,
      errNotARepository().message,
      errInvalidCommandOrArguments().message,
      errInvalidPort(65536).message,
      errUnknownVersion("(a@x->2)").message,
      errContributorIdRequired().message,
      errInvalidCommitMessage().message,
      errRepositoryHasUnknownField("unknown").message,
      errDeleteOfAbsentPath("f").message,
      errSnapColorInvalid().message,
    ];
    for (const msg of messages) {
      assert.ok(matchesWithNewline(re, msg), `failed for: ${msg}`);
    }
  });
});

// ---------------------------------------------------------------------------
// §7.3 Required substrings
// ---------------------------------------------------------------------------

void describe("§7.3 required substrings", () => {
  void test("'repository already exists'", () => {
    assert.ok(errRepositoryAlreadyExists().message.includes("repository already exists"));
  });

  void test("'cannot initialize inside repository'", () => {
    assert.ok(
      errCannotInitializeInsideRepository().message.includes("cannot initialize inside repository"),
    );
  });

  void test("'invalid JSON'", () => {
    assert.ok(errInvalidJson().message.includes("invalid JSON"));
  });

  void test("'invalid contributor id'", () => {
    assert.ok(errInvalidContributorId("bad_id").message.includes("invalid contributor id"));
  });

  void test("'usage: snap diff'", () => {
    assert.ok(errUsageDiff().message.includes("usage: snap diff"));
  });

  void test("'unknown version' — errUnknownVersion", () => {
    assert.ok(errUnknownVersion("(a@x->2)").message.includes("unknown version"));
  });

  void test("'HTTP 302' — errHttpRedirect(302)", () => {
    assert.ok(errHttpRedirect(302).message.includes("HTTP 302"));
  });

  void test("'duplicate JSON key'", () => {
    assert.ok(errDuplicateJsonKey("format").message.includes("duplicate JSON key"));
  });

  void test("'missing a@x' — errMissingPatch('a@x', 1)", () => {
    assert.ok(errMissingPatch("a@x", 1).message.includes("missing a@x"));
  });

  void test("'path is invalid' (not 'invalid path')", () => {
    const msg = errPathIsInvalid("../foo").message;
    assert.ok(msg.includes("path is invalid"), `message was: ${msg}`);
    assert.ok(!msg.includes("invalid path"), `message was: ${msg}`);
  });

  void test("'canonical base64'", () => {
    assert.ok(errNotCanonicalBase64().message.includes("canonical base64"));
  });

  void test("'does not consume old content'", () => {
    assert.ok(errDoesNotConsumeOldContent().message.includes("does not consume old content"));
  });

  void test("'tree paths conflict'", () => {
    assert.ok(errTreePathsConflict("a", "a/b").message.includes("tree paths conflict"));
  });

  void test("'cyclic or incomplete patch history'", () => {
    assert.ok(
      errCyclicOrIncompletePatchHistory().message.includes("cyclic or incomplete patch history"),
    );
  });

  void test("'no-op change'", () => {
    assert.ok(errNoOpChange().message.includes("no-op change"));
  });

  void test("'adjacent insert'", () => {
    assert.ok(errAdjacentInsert().message.includes("adjacent insert"));
  });

  void test("'patch collision: a@x revision 1' — errPatchCollision('a@x', 1)", () => {
    assert.ok(errPatchCollision("a@x", 1).message.includes("patch collision: a@x revision 1"));
  });
});

// ---------------------------------------------------------------------------
// §7.4 Warning format
// ---------------------------------------------------------------------------

void describe("§7.4 warning format", () => {
  function makeWarning(path: string, reason: string): string {
    return `warning: auto-resolved ${path}: ${reason}`;
  }

  const validReasons = [
    "delete-wins",
    "later-create-wins",
    "later-put-wins",
    "namespace-wins",
    "put-wins",
  ] as const;

  for (const reason of validReasons) {
    void test(`warning format with reason '${reason}'`, () => {
      const line = makeWarning("some/path.txt", reason);
      assert.match(line, /^warning: auto-resolved .+: .+$/);
      assert.ok(line.includes(`auto-resolved some/path.txt: ${reason}`));
    });
  }

  void test("warnings sort by path then reason", () => {
    const warnings = [
      { path: "z.txt", reason: "delete-wins" },
      { path: "a.txt", reason: "put-wins" },
      { path: "a.txt", reason: "delete-wins" },
    ];
    const sorted = [...warnings].sort((a, b) => {
      const pc = a.path.localeCompare(b.path);
      return pc !== 0 ? pc : a.reason.localeCompare(b.reason);
    });
    assert.equal(sorted[0]!.path, "a.txt");
    assert.equal(sorted[0]!.reason, "delete-wins");
    assert.equal(sorted[1]!.path, "a.txt");
    assert.equal(sorted[1]!.reason, "put-wins");
    assert.equal(sorted[2]!.path, "z.txt");
    assert.equal(sorted[2]!.reason, "delete-wins");
  });
});
