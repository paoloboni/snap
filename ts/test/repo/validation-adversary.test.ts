// Adversarial validation tests — Phase 3 Validation Adversary
// ROLE: Validation Adversary — write ≥1 failing test before filing each objection.
//
// Each section header cites the SPEC.md line range under audit.
// Tests marked [FAILS] expose confirmed implementation bugs.
// Tests marked [PASSES] establish correct baseline behavior.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseJSON, serializeRepository } from "../../src/repo/json.js";
import { validateRepository } from "../../src/repo/validate.js";
import { SnapError } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectSnapError(fn: () => unknown, substring: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
    assert.ok(
      e.message.includes(substring),
      `Expected message to include "${substring}", got: "${e.message}"`,
    );
    return true;
  });
}

// ---------------------------------------------------------------------------
// ADV-C-001 — parseJSON: duplicate key inside a deeply nested object
// SPEC §4.1 lines 188-190: "Valid input has unique object keys."
// The existing tests only cover top-level and one level of nesting.
// This test covers a duplicate key inside the `changes` array item, which is
// three levels deep: repository → patches[0] → changes[0].
// ---------------------------------------------------------------------------

void describe("ADV-C-001: parseJSON duplicate key in deeply nested change object [PASSES]", () => {
  // Confirms the scanner handles 3-level deep duplicates.
  void it("rejects duplicate key inside a change object (3 levels deep)", () => {
    // '{"type":"text","type":"put",...}' — type duplicated inside changes[0]
    const rawJson =
      '{"format":1,"frontier":[["a@x",1]],"patches":[' +
      '{"author":"a@x","revision":1,"base":[],"message":"test",' +
      '"changes":[{"type":"text","type":"put","path":"f","edit":[]}]}]}';
    assert.throws(
      () => parseJSON(rawJson),
      (e: unknown) => {
        assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
        assert.ok(
          e.message.includes("duplicate JSON key"),
          `Expected "duplicate JSON key" in: "${e.message}"`,
        );
        assert.ok(
          e.message.includes("type"),
          `Expected duplicate key name "type" in: "${e.message}"`,
        );
        return true;
      },
    );
  });

  // Confirms the scanner handles a duplicate key inside the patch object itself.
  void it("rejects duplicate key inside a patch object (2 levels deep)", () => {
    // '{"author":"a@x","author":"b@x",...}' — author duplicated inside patches[0]
    const rawJson =
      '{"format":1,"frontier":[["a@x",1]],"patches":[' +
      '{"author":"a@x","author":"b@x","revision":1,"base":[],"message":"test",' +
      '"changes":[{"type":"text","path":"f","edit":[]}]}]}';
    assert.throws(
      () => parseJSON(rawJson),
      (e: unknown) => {
        assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
        assert.ok(
          e.message.includes("duplicate JSON key"),
          `Expected "duplicate JSON key" in: "${e.message}"`,
        );
        assert.ok(
          e.message.includes("author"),
          `Expected duplicate key name "author" in: "${e.message}"`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// ADV-C-002 — validateRepository: patches unsorted by revision within one author
// SPEC §4.1 lines 195-196: "patches contains exactly the causal closure of
//   frontier, sorted by author and then numeric revision"
//
// [FAILS] The implementation throws errUnknownField("patches", "sort order"),
// producing "snap: patches has unknown field: sort order".
// Using errUnknownField for a sort-order violation is semantically wrong:
// sort order is not an unknown field, and the error message misleads callers.
// The error should NOT say "unknown field" for a sort-order violation.
// ---------------------------------------------------------------------------

void describe("ADV-C-002: validateRepository patches unsorted by revision", () => {
  // [FAILS] — tests the error message semantics for sort-order violations.
  void it("[FAILS] sort-order violation must not produce an 'unknown field' error", () => {
    // Patches for a@x with revision 2 before revision 1 — wrong order per SPEC §4.1.
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 2]],
          patches: [
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "second first",
              changes: [{ type: "text", path: "g", edit: [] }],
            },
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "first second",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => {
        assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
        // Sort-order violation must throw a SnapError — ✓
        // But the error message MUST NOT say "unknown field": that implies the
        // validator found an unexpected JSON key, which is not what happened.
        assert.ok(
          !e.message.includes("unknown field"),
          `Sort-order error should not say "unknown field", got: "${e.message}"`,
        );
        return true;
      },
    );
  });

  // [PASSES] — demonstrates that the sort violation IS detected (just with wrong message).
  void it("[PASSES] sort-order violation is detected (rev 2 before rev 1)", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 2]],
          patches: [
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "wrong order",
              changes: [{ type: "text", path: "g", edit: [] }],
            },
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "should be first",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  // [PASSES] — three patches for same author: 1, 3, 2 — the 3→2 inversion is caught.
  void it("[PASSES] sort-order violation is detected (1, 3, 2 order)", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 3]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "first",
              changes: [{ type: "text", path: "a", edit: [] }],
            },
            {
              author: "a@x",
              revision: 3,
              base: [["a@x", 2]],
              message: "third",
              changes: [{ type: "text", path: "b", edit: [] }],
            },
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "second",
              changes: [{ type: "text", path: "c", edit: [] }],
            },
          ],
        }),
      (e: unknown) => e instanceof SnapError,
    );
  });
});

// ---------------------------------------------------------------------------
// ADV-C-003 — validateRepository: forbidden control character in message
// SPEC §4.2 lines 220-221: "message is a nonempty UTF-8 string. It may contain
//   tab and LF but no other ASCII control character."
// PLAN.md §7.1 line 240: "snap: invalid commit message" is the pinned error
//   for message validation failures.
//
// [FAILS] The implementation throws errUnknownField("patch", "message control
//   character"), producing "snap: patch has unknown field: message control
//   character". This is semantically wrong: a message with a control character
//   is not an unknown field. Per PLAN.md §7.1, the error should contain
//   "invalid commit message".
// ---------------------------------------------------------------------------

void describe("ADV-C-003: validateRepository message with forbidden control character", () => {
  // [FAILS] — control char in message must not say "unknown field".
  // SPEC §4.2 lines 220-221 defines the message rule. The error should
  // describe a MESSAGE validation failure (e.g., "invalid commit message"),
  // NOT an "unknown field" (which describes a JSON schema violation).
  // Using errUnknownField for a semantic message constraint is semantically
  // incorrect: "unknown field: message control character" implies the
  // validator found an unexpected JSON key, which is not what happened.
  void it("[FAILS] SOH (\\x01) in message error must not say 'unknown field'", () => {
    // SOH = 0x01, a forbidden control character per SPEC §4.2.
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "bad\x01control",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => {
        assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
        // Must not say "unknown field" — that's for JSON schema violations, not
        // message content violations.
        assert.ok(
          !e.message.includes("unknown field"),
          `Control-char-in-message error must not say "unknown field", got: "${e.message}"`,
        );
        return true;
      },
    );
  });

  // [FAILS] — SUB (0x1A) control char also must not produce 'unknown field'.
  // Demonstrates the wrong-error-factory is not specific to SOH.
  void it("[FAILS] SUB (\\x1A) in message error must not say 'unknown field'", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "bad\x1acontrol",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => {
        assert.ok(e instanceof SnapError, `Expected SnapError, got ${String(e)}`);
        assert.ok(
          !e.message.includes("unknown field"),
          `Control-char-in-message error must not say "unknown field", got: "${e.message}"`,
        );
        return true;
      },
    );
  });

  // [PASSES] — rejects BEL (0x07) control character.
  void it("[PASSES] BEL (\\x07) in message is rejected", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "bad\x07bell",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  // [PASSES] — rejects ETX (0x03) control character.
  void it("[PASSES] ETX (\\x03) in message is rejected", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "bad\x03etx",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  // [PASSES] — DEL (0x7F) is a forbidden control character.
  void it("[PASSES] DEL (\\x7F) in message is rejected", () => {
    assert.throws(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "bad\x7fdel",
              changes: [{ type: "text", path: "f", edit: [] }],
            },
          ],
        }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  // [PASSES] — TAB is explicitly permitted.
  void it("[PASSES] TAB (\\x09) in message is accepted", () => {
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "col1\tcol2",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message, "col1\tcol2");
  });

  // [PASSES] — LF is explicitly permitted.
  void it("[PASSES] LF (\\x0A) in message is accepted", () => {
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "first\nsecond",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message, "first\nsecond");
  });
});

// ---------------------------------------------------------------------------
// ADV-C-004 — validateRepository: message length boundary (4096 vs 4097 bytes)
// SPEC §4.2 lines 221-223: "snap commit limits user-supplied messages to 4096
//   bytes; generated revert messages may be longer because they contain a
//   complete version."
// validateRepository must NOT enforce the 4096-byte limit (revert messages
// stored in history may exceed it).
//
// [PASSES] — Both 4096 and 4097 byte messages must be accepted by
// validateRepository (the limit is only at the CLI commit layer).
// ---------------------------------------------------------------------------

void describe("ADV-C-004: message length boundary", () => {
  void it("[PASSES] message exactly 4096 bytes is accepted by validateRepository", () => {
    const msg = "x".repeat(4096);
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: msg,
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message.length, 4096);
  });

  void it("[PASSES] message of 4097 bytes is accepted by validateRepository", () => {
    // SPEC §4.2: revert-generated messages may exceed 4096 bytes.
    const msg = "x".repeat(4097);
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: msg,
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message.length, 4097);
  });

  void it("[PASSES] message of 1 byte is accepted", () => {
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "x",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message, "x");
  });
});

// ---------------------------------------------------------------------------
// ADV-C-005 — validateRepository: `put` of identical bytes (no-op)
// SPEC §4.3 lines 248-250: "A change that does not alter path existence or
//   bytes is invalid, except that an empty text edit may create an empty file."
//
// [PASSES] — put replacement with the same bytes must be caught as a no-op.
// ---------------------------------------------------------------------------

void describe("ADV-C-005: put of identical bytes is a no-op", () => {
  void it("[PASSES] put of identical bytes to an existing path is rejected", () => {
    // Base64("a") = "YQ=="
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 2]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "create",
              changes: [{ type: "put", path: "f", content: "YQ==" }],
            },
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "no-op replace",
              changes: [{ type: "put", path: "f", content: "YQ==" }],
            },
          ],
        }),
      "no-op change",
    );
  });

  void it("[PASSES] put of different bytes to an existing path is valid (replacement)", () => {
    // Base64("a") = "YQ==" vs Base64("b") = "Yg=="
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 2]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "create",
          changes: [{ type: "put", path: "f", content: "YQ==" }],
        },
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "replace",
          changes: [{ type: "put", path: "f", content: "Yg==" }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 2);
  });

  void it("[PASSES] put creation of absent path is always valid (non-no-op)", () => {
    // A put to a path that does not yet exist is a creation — never a no-op.
    const repo = validateRepository({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "create",
          changes: [{ type: "put", path: "new.bin", content: "YQ==" }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// ADV-C-006 — validateRepository: format validation
// SPEC §4.1 line 194: "Unknown fields, non-integer numbers, and invalid typed
//   values are errors."
// The format field must be exactly the integer 1.
//
// [PASSES] — format: 2 (unsupported but well-formed) must be rejected.
// [PASSES] — format: 1.5 (non-integer) must be rejected.
// [PASSES] — format: "1" (string) must be rejected.
// ---------------------------------------------------------------------------

void describe("ADV-C-006: format field validation", () => {
  void it("[PASSES] format: 2 (unsupported version) is rejected", () => {
    assert.throws(
      () => validateRepository({ format: 2, frontier: [], patches: [] }),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        // Must be a SnapError — spec says unknown format is an error.
        return true;
      },
    );
  });

  void it("[PASSES] format: 1.5 (non-integer) is rejected with 'positive safe integer'", () => {
    expectSnapError(
      () => validateRepository({ format: 1.5, frontier: [], patches: [] }),
      "positive safe integer",
    );
  });

  void it("[PASSES] format: '1' (string) is rejected", () => {
    assert.throws(
      () => validateRepository({ format: "1", frontier: [], patches: [] }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  void it("[PASSES] format: 0 is rejected", () => {
    assert.throws(
      () => validateRepository({ format: 0, frontier: [], patches: [] }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  void it("[PASSES] format: -1 is rejected", () => {
    assert.throws(
      () => validateRepository({ format: -1, frontier: [], patches: [] }),
      (e: unknown) => e instanceof SnapError,
    );
  });

  void it("[PASSES] format: 1 is accepted", () => {
    const repo = validateRepository({ format: 1, frontier: [], patches: [] });
    assert.strictEqual(repo.format, 1);
  });
});

// ---------------------------------------------------------------------------
// ADV-C-007 — validateRepository: unknown field inside a patch object
// SPEC §4.1 line 194: "Unknown fields, non-integer numbers, and invalid typed
//   values are errors."
//
// [PASSES] — unknown field inside a patches[n] object must be rejected.
// The PLAN.md §7.2 pattern is '^snap: .+unknown field: extra\n$'.
// ---------------------------------------------------------------------------

void describe("ADV-C-007: unknown field inside a patch object", () => {
  void it("[PASSES] unknown field 'extra' in patch is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "test",
              changes: [{ type: "text", path: "f", edit: [] }],
              extra: true,
            },
          ],
        }),
      "unknown field: extra",
    );
  });

  void it("[PASSES] unknown field 'tag' in patch is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "test",
              changes: [{ type: "text", path: "f", edit: [] }],
              tag: "release",
            },
          ],
        }),
      "unknown field: tag",
    );
  });
});

// ---------------------------------------------------------------------------
// ADV-C-008 — validateRepository: unknown field inside a change object
// SPEC §4.1 line 194: "Unknown fields, non-integer numbers, and invalid typed
//   values are errors."
//
// [PASSES] — unknown field inside changes[n] must be rejected.
// ---------------------------------------------------------------------------

void describe("ADV-C-008: unknown field inside a change object", () => {
  void it("[PASSES] unknown field inside a put change is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "test",
              changes: [{ type: "put", path: "f", content: "YQ==", extra: 1 }],
            },
          ],
        }),
      "unknown field: extra",
    );
  });

  void it("[PASSES] unknown field inside a text change is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "test",
              changes: [{ type: "text", path: "f", edit: [], extra: 42 }],
            },
          ],
        }),
      "unknown field: extra",
    );
  });

  void it("[PASSES] unknown field inside a delete change is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "test",
              changes: [{ type: "delete", path: "f", extra: "bad" }],
            },
          ],
        }),
      "unknown field: extra",
    );
  });
});

// ---------------------------------------------------------------------------
// ADV-C-009 — validateRepository: adjacent same-kind edit operations
// SPEC §4.4 lines 265-266: "Adjacent operations of the same kind are forbidden."
//
// Note: the error thrown is errAdjacentInsert() → "snap: adjacent insert".
// This is the pinned string from PLAN.md §7.3 line 266.
// It is semantically misleading for retain/retain and delete/delete cases,
// but is pinned by the test contract. Tests verify the behavior is consistent.
//
// [PASSES] — adjacent retain/retain is rejected (with "adjacent insert" message).
// [PASSES] — adjacent delete/delete is rejected (with "adjacent insert" message).
// ---------------------------------------------------------------------------

void describe("ADV-C-009: adjacent same-kind edit operations", () => {
  void it("[PASSES] adjacent retain/retain is rejected", () => {
    // Build a base with 3 tokens, then use retain 1 + retain 2 — forbidden.
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 2]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "base with 3 tokens",
              changes: [
                {
                  type: "text",
                  path: "f",
                  edit: [{ insert: ["one\n", "two\n", "three\n"] }],
                },
              ],
            },
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "adjacent retain",
              changes: [
                {
                  type: "text",
                  path: "f",
                  // 3 tokens in base; adjacent retain 1 + retain 2 = forbidden
                  edit: [{ retain: 1 }, { retain: 2 }],
                },
              ],
            },
          ],
        }),
      "adjacent insert",
    );
  });

  void it("[PASSES] adjacent delete/delete is rejected", () => {
    // Build a base with 3 tokens, then delete 1 + delete 2 — forbidden.
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 2]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "base with 3 tokens",
              changes: [
                {
                  type: "text",
                  path: "f",
                  edit: [{ insert: ["one\n", "two\n", "three\n"] }],
                },
              ],
            },
            {
              author: "a@x",
              revision: 2,
              base: [["a@x", 1]],
              message: "adjacent delete",
              changes: [
                {
                  type: "text",
                  path: "f",
                  // delete 1 + delete 2 = adjacent delete/delete — forbidden
                  edit: [{ delete: 1 }, { delete: 2 }],
                },
              ],
            },
          ],
        }),
      "adjacent insert",
    );
  });

  // This was the original adjacent insert/insert test (baseline).
  void it("[PASSES] adjacent insert/insert is rejected", () => {
    expectSnapError(
      () =>
        validateRepository({
          format: 1,
          frontier: [["a@x", 1]],
          patches: [
            {
              author: "a@x",
              revision: 1,
              base: [],
              message: "adjacent insert",
              changes: [
                {
                  type: "text",
                  path: "f",
                  edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }],
                },
              ],
            },
          ],
        }),
      "adjacent insert",
    );
  });
});

// ---------------------------------------------------------------------------
// ADV-C-010 — serializeRepository: exact byte-level key order
// SPEC §4.1 lines 167-186: example shows exact key ordering.
// PLAN.md §7.5 rule 2: "key order format, frontier, patches / author, revision,
//   base, message, changes / type, path, edit (or content)"
//
// This test verifies the EXACT serialized string character by character,
// not just JSON-parsed key arrays.
//
// [PASSES] — the serializer produces the correct indentation and key ordering.
// ---------------------------------------------------------------------------

void describe("ADV-C-010: serializeRepository exact byte-level output", () => {
  void it("[PASSES] top-level keys appear in format/frontier/patches order", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>([["a@x", 1]]),
      patches: [] as never[],
    };
    const s = serializeRepository(repo);
    // format must appear before frontier, frontier before patches
    const formatIdx = s.indexOf('"format"');
    const frontierIdx = s.indexOf('"frontier"');
    const patchesIdx = s.indexOf('"patches"');
    assert.ok(formatIdx < frontierIdx, "format must precede frontier");
    assert.ok(frontierIdx < patchesIdx, "frontier must precede patches");
  });

  void it("[PASSES] patch keys appear in author/revision/base/message/changes order", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map<string, number>(),
          message: "init",
          changes: [{ type: "text" as const, path: "f", edit: [] }],
        },
      ],
    };
    const s = serializeRepository(repo);
    const authorIdx = s.indexOf('"author"');
    const revisionIdx = s.indexOf('"revision"');
    const baseIdx = s.indexOf('"base"');
    const messageIdx = s.indexOf('"message"');
    const changesIdx = s.indexOf('"changes"');
    assert.ok(authorIdx < revisionIdx, "author must precede revision");
    assert.ok(revisionIdx < baseIdx, "revision must precede base");
    assert.ok(baseIdx < messageIdx, "base must precede message");
    assert.ok(messageIdx < changesIdx, "message must precede changes");
  });

  void it("[PASSES] put change keys appear in type/path/content order (exact bytes)", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map<string, number>(),
          message: "add",
          changes: [{ type: "put" as const, path: "f", content: "YQ==" }],
        },
      ],
    };
    const s = serializeRepository(repo);
    const typeIdx = s.indexOf('"type"');
    const pathIdx = s.indexOf('"path"');
    const contentIdx = s.indexOf('"content"');
    assert.ok(typeIdx < pathIdx, "type must precede path in put change");
    assert.ok(pathIdx < contentIdx, "path must precede content in put change");
    // edit must NOT appear for a put change
    assert.ok(!s.includes('"edit"'), "put change must not have 'edit' key");
  });

  void it("[PASSES] text change keys appear in type/path/edit order (exact bytes)", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map<string, number>(),
          message: "add",
          changes: [
            {
              type: "text" as const,
              path: "f",
              edit: [{ type: "insert" as const, tokens: ["hello\n"] }],
            },
          ],
        },
      ],
    };
    const s = serializeRepository(repo);
    const typeIdx = s.indexOf('"type"');
    const pathIdx = s.indexOf('"path"');
    const editIdx = s.indexOf('"edit"');
    assert.ok(typeIdx < pathIdx, "type must precede path in text change");
    assert.ok(pathIdx < editIdx, "path must precede edit in text change");
    // content must NOT appear for a text change
    assert.ok(!s.includes('"content"'), "text change must not have 'content' key");
  });

  void it("[PASSES] output uses two-space indentation and ends with LF", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>(),
      patches: [] as never[],
    };
    const s = serializeRepository(repo);
    assert.ok(s.endsWith("\n"), "output must end with LF");
    // Two-space indentation: the frontier line must start with exactly two spaces.
    const lines = s.split("\n");
    const frontierLine = lines.find((l) => l.includes('"frontier"'));
    assert.ok(frontierLine !== undefined, "frontier line must exist");
    assert.ok(frontierLine.startsWith("  "), "frontier must be indented with two spaces");
    assert.ok(!frontierLine.startsWith("   "), "frontier must not have more than two spaces");
  });

  void it("[PASSES] full exact serialization of minimal repository", () => {
    // Verify the complete output character by character against the canonical form.
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>(),
      patches: [] as never[],
    };
    const s = serializeRepository(repo);
    const expected = `{
  "format": 1,
  "frontier": [],
  "patches": []
}\n`;
    assert.strictEqual(s, expected);
  });

  void it("[PASSES] serialization of a single-patch repository matches expected bytes", () => {
    const repo = {
      format: 1 as const,
      frontier: new Map<string, number>([["a@x", 1]]),
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: new Map<string, number>(),
          message: "init",
          changes: [{ type: "put" as const, path: "f", content: "YQ==" }],
        },
      ],
    };
    const s = serializeRepository(repo);
    const expected = `{
  "format": 1,
  "frontier": [
    [
      "a@x",
      1
    ]
  ],
  "patches": [
    {
      "author": "a@x",
      "revision": 1,
      "base": [],
      "message": "init",
      "changes": [
        {
          "type": "put",
          "path": "f",
          "content": "YQ=="
        }
      ]
    }
  ]
}\n`;
    assert.strictEqual(s, expected);
  });
});

// ---------------------------------------------------------------------------
// ADV-C-011 — parseJSON: duplicate key inside the base array structure
// SPEC §4.1 lines 188-190: "Valid input has unique object keys."
// Base is an array of [id, rev] pairs (not objects), so no duplicate key
// issue — but a base array containing object entries with duplicate keys
// should still be caught.
//
// [PASSES] — a base entry that is an object with duplicate keys (malformed
// repository.json) is caught by the parser.
// ---------------------------------------------------------------------------

void describe("ADV-C-011: parseJSON in full repository context", () => {
  void it("[PASSES] duplicate key in frontier pair object is caught", () => {
    // Frontier entries are arrays [id, rev], not objects — but a malformed
    // JSON where frontier contains an object with duplicate keys must be caught.
    const rawJson = '{"format":1,"frontier":[{"id":"a@x","id":"b@x"}],"patches":[]}';
    assert.throws(
      () => parseJSON(rawJson),
      (e: unknown) => {
        assert.ok(e instanceof SnapError);
        assert.ok(e.message.includes("duplicate JSON key"));
        return true;
      },
    );
  });

  void it("[PASSES] valid repository JSON without duplicate keys parses correctly", () => {
    const rawJson = JSON.stringify({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "init",
          changes: [{ type: "put", path: "f", content: "YQ==" }],
        },
      ],
    });
    const result = parseJSON(rawJson);
    assert.ok(typeof result === "object" && result !== null);
  });
});
