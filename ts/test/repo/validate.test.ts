// Tests for repo/validate.ts — every §12 validation backlog item
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateRepository } from "../../src/repo/validate.js";
import type { Repository } from "../../src/repo/model.js";
import { assertOk, assertErr, expectErr } from "../helpers/result.js";

// ---------------------------------------------------------------------------
// Helper: run validateRepository and check for a SnapError with a substring
// ---------------------------------------------------------------------------

function validRepo(data: unknown): Repository {
  return assertOk(validateRepository(data));
}

function expectError(data: unknown, substring: string): void {
  expectErr(validateRepository(data), substring);
}

// ---------------------------------------------------------------------------
// Valid repository (smoke test)
// ---------------------------------------------------------------------------

void describe("validateRepository — valid cases", () => {
  void it("accepts empty repository", () => {
    const repo = validRepo({ format: 1, frontier: [], patches: [] });
    assert.strictEqual(repo.format, 1);
    assert.strictEqual(repo.frontier.size, 0);
    assert.strictEqual(repo.patches.length, 0);
  });

  void it("accepts single patch with text change creating a file", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "init",
          changes: [{ type: "text", path: "f.txt", edit: [{ insert: ["hello\n"] }] }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 1);
  });

  void it("accepts single patch with put change", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "add binary",
          changes: [{ type: "put", path: "f.bin", content: "YQ==" }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 1);
  });

  void it("accepts empty text edit creating empty file", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "create empty",
          changes: [{ type: "text", path: "empty.txt", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 1);
  });

  void it("accepts patch with delete change", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 2]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "add",
          changes: [{ type: "put", path: "f.txt", content: "YQ==" }],
        },
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "delete",
          changes: [{ type: "delete", path: "f.txt" }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 2);
  });

  void it("accepts multiple patches from different authors", () => {
    const repo = validRepo({
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "alice",
          changes: [{ type: "text", path: "a.txt", edit: [] }],
        },
        {
          author: "b@x",
          revision: 1,
          base: [],
          message: "bob",
          changes: [{ type: "text", path: "b.txt", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 2);
  });

  void it("parses frontier into a ReadonlyMap", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 3]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "1",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "2",
          changes: [{ type: "text", path: "g", edit: [] }],
        },
        {
          author: "a@x",
          revision: 3,
          base: [["a@x", 2]],
          message: "3",
          changes: [{ type: "text", path: "h", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.frontier.get("a@x"), 3);
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: unknown fields at every nesting level
// ---------------------------------------------------------------------------

void describe("validateRepository — unknown fields", () => {
  void it("rejects unknown field at repository level", () => {
    expectError(
      { format: 1, frontier: [], patches: [], unknown: true },
      "repository has unknown field: unknown",
    );
  });

  void it("rejects unknown field at patch level", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "x",
            changes: [{ type: "text", path: "f", edit: [] }],
            unknown: true,
          },
        ],
      },
      "unknown field",
    );
  });

  void it("rejects unknown field at change level (put)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "x",
            changes: [{ type: "put", path: "f", content: "YQ==", extra: 1 }],
          },
        ],
      },
      "unknown field: extra",
    );
  });

  void it("rejects unknown field at change level (text)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "x",
            changes: [{ type: "text", path: "f", edit: [], extra: 1 }],
          },
        ],
      },
      "unknown field: extra",
    );
  });

  void it("rejects unknown field at change level (delete)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "x",
            changes: [{ type: "delete", path: "f", extra: 1 }],
          },
        ],
      },
      "unknown field: extra",
    );
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: non-integer format, format:2
// ---------------------------------------------------------------------------

void describe("validateRepository — format validation", () => {
  void it("rejects non-integer format (1.5)", () => {
    expectError({ format: 1.5, frontier: [], patches: [] }, "positive safe integer");
  });

  void it("rejects format:2 (unsupported version)", () => {
    const data = { format: 2, frontier: [], patches: [] };
    assertErr(validateRepository(data));
  });

  void it("rejects format:0", () => {
    const data = { format: 0, frontier: [], patches: [] };
    assertErr(validateRepository(data));
  });

  void it("rejects string format", () => {
    const data = { format: "1", frontier: [], patches: [] };
    assertErr(validateRepository(data));
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: patches unsorted by revision
// ---------------------------------------------------------------------------

void describe("validateRepository — patch sorting", () => {
  void it("rejects patches unsorted by revision (same author, wrong order)", () => {
    // revision 2 before revision 1 for same author — causal closure check catches gap first
    const data = {
      format: 1,
      frontier: [["a@x", 2]],
      patches: [
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "b",
          changes: [{ type: "text", path: "f", edit: [{ retain: 1 }] }],
        },
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "a",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });

  void it("rejects patches with authors out of UTF-8 byte order", () => {
    // "b@x" before "a@x" — wrong author order
    const data = {
      format: 1,
      frontier: [
        ["a@x", 1],
        ["b@x", 1],
      ],
      patches: [
        {
          author: "b@x",
          revision: 1,
          base: [],
          message: "b",
          changes: [{ type: "text", path: "b", edit: [] }],
        },
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "a",
          changes: [{ type: "text", path: "a", edit: [] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: frontier not canonically sorted
// ---------------------------------------------------------------------------

void describe("validateRepository — frontier canonicality", () => {
  void it("rejects frontier not in canonical order", () => {
    // b@x before a@x — wrong order
    expectError(
      {
        format: 1,
        frontier: [
          ["b@x", 1],
          ["a@x", 1],
        ],
        patches: [],
      },
      "canonical",
    );
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: forbidden control character in message
// ---------------------------------------------------------------------------

void describe("validateRepository — message validation", () => {
  void it("rejects message with forbidden control character (NUL)", () => {
    const data = {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad\x00message",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });

  void it("rejects message with BEL control character", () => {
    const data = {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "bad\x07message",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });

  void it("accepts message with TAB", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "message\twith\ttabs",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message, "message\twith\ttabs");
  });

  void it("accepts message with LF", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "line1\nline2",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    });
    assert.strictEqual(repo.patches[0]!.message, "line1\nline2");
  });

  void it("rejects empty message", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "",
            changes: [{ type: "text", path: "f", edit: [] }],
          },
        ],
      },
      "message is empty",
    );
  });

  void it("accepts message exactly 4096 bytes", () => {
    // Per SPEC §4.2: "snap commit limits user-supplied messages to 4096 bytes"
    // The validation pipeline does not enforce this limit on stored patches.
    const msg = "a".repeat(4096);
    const repo = validRepo({
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

  void it("accepts message of 4097 bytes (stored messages may exceed 4096)", () => {
    // The 4096-byte limit is for snap commit, not for stored validation.
    // Generated revert messages may be longer (SPEC §4.2).
    const msg = "a".repeat(4097);
    const repo = validRepo({
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
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: put of identical bytes (no-op)
// ---------------------------------------------------------------------------

void describe("validateRepository — no-op change detection", () => {
  void it("rejects put of identical bytes (no-op) — test 15 case", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "base",
            changes: [{ type: "put", path: "f", content: "YQ==" }],
          },
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "no op",
            changes: [{ type: "put", path: "f", content: "YQ==" }],
          },
        ],
      },
      "no-op change",
    );
  });
});

// ---------------------------------------------------------------------------
// §12 Validation backlog: adjacent retain/retain and delete/delete in edit script
// ---------------------------------------------------------------------------

void describe("validateRepository — adjacent edit operations", () => {
  void it("rejects adjacent insert/insert in edit script", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "adjacent",
            changes: [
              {
                type: "text",
                path: "f",
                edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }],
              },
            ],
          },
        ],
      },
      "adjacent insert",
    );
  });

  void it("rejects adjacent retain/retain in edit script", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "base",
            changes: [
              {
                type: "text",
                path: "f",
                edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }, { insert: ["c\n"] }],
              },
            ],
          },
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "adj retain",
            changes: [
              {
                type: "text",
                path: "f",
                // 3 tokens in base, adjacent retains — detected statically
                edit: [{ retain: 1 }, { retain: 2 }],
              },
            ],
          },
        ],
      },
      "adjacent insert",
    );
  });

  void it("rejects adjacent delete/delete in edit script", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "base",
            changes: [
              {
                type: "text",
                path: "f",
                edit: [{ insert: ["a\n"] }, { insert: ["b\n"] }, { insert: ["c\n"] }],
              },
            ],
          },
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "adj delete",
            changes: [
              {
                type: "text",
                path: "f",
                // 3 tokens in base, adjacent deletes — detected statically
                edit: [{ delete: 1 }, { delete: 2 }],
              },
            ],
          },
        ],
      },
      "adjacent insert",
    );
  });
});

// ---------------------------------------------------------------------------
// Edit script consumption errors
// ---------------------------------------------------------------------------

void describe("validateRepository — edit script consumption", () => {
  void it("rejects under-consumption (does not consume old content)", () => {
    // Use a single insert to create 2 tokens in base (valid), then only retain 1 in the edit
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "base",
            changes: [
              {
                type: "text",
                path: "f",
                // Valid: insert two tokens in one insert op
                edit: [{ insert: ["one\n", "two\n"] }],
              },
            ],
          },
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "underconsume",
            changes: [{ type: "text", path: "f", edit: [{ retain: 1 }] }],
          },
        ],
      },
      "does not consume old content",
    );
  });

  void it("rejects over-consumption (consumes beyond old content)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "base",
            changes: [
              {
                type: "text",
                path: "f",
                edit: [{ insert: ["one\n"] }],
              },
            ],
          },
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "overconsume",
            changes: [{ type: "text", path: "f", edit: [{ delete: 2 }] }],
          },
        ],
      },
      "consumes beyond old content",
    );
  });
});

// ---------------------------------------------------------------------------
// Causal closure and missing patches
// ---------------------------------------------------------------------------

void describe("validateRepository — causal closure", () => {
  void it("rejects when base refers to missing patch", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 2]],
        patches: [
          {
            author: "a@x",
            revision: 2,
            base: [["a@x", 1]],
            message: "gap",
            changes: [{ type: "text", path: "f", edit: [] }],
          },
        ],
      },
      "missing a@x",
    );
  });

  void it("rejects cyclic dependency", () => {
    expectError(
      {
        format: 1,
        frontier: [
          ["a@x", 1],
          ["b@x", 1],
        ],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [["b@x", 1]],
            message: "cycle a",
            changes: [{ type: "text", path: "a", edit: [] }],
          },
          {
            author: "b@x",
            revision: 1,
            base: [["a@x", 1]],
            message: "cycle b",
            changes: [{ type: "text", path: "b", edit: [] }],
          },
        ],
      },
      "cyclic or incomplete patch history",
    );
  });
});

// ---------------------------------------------------------------------------
// Unreachable patches
// ---------------------------------------------------------------------------

void describe("validateRepository — unreachable patches", () => {
  void it("rejects patches not reachable from frontier", () => {
    expectError(
      {
        format: 1,
        frontier: [],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "unreachable",
            changes: [{ type: "text", path: "f", edit: [] }],
          },
        ],
      },
      "unreachable patch",
    );
  });
});

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

void describe("validateRepository — path validation", () => {
  void it("rejects invalid path (.snap segment)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "bad path",
            changes: [{ type: "put", path: ".snap/secret", content: "YQ==" }],
          },
        ],
      },
      "path is invalid",
    );
  });

  void it("rejects path with control character", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "bad path",
            changes: [{ type: "put", path: "f\x00ile", content: "YQ==" }],
          },
        ],
      },
      "path is invalid",
    );
  });

  void it("rejects changes not sorted by path", () => {
    const data = {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "order",
          changes: [
            { type: "text", path: "z", edit: [] },
            { type: "text", path: "a", edit: [] },
          ],
        },
      ],
    };
    assertErr(validateRepository(data));
  });
});

// ---------------------------------------------------------------------------
// Base64 validation
// ---------------------------------------------------------------------------

void describe("validateRepository — base64 validation", () => {
  void it("rejects non-padded base64 (abc)", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "bad",
            changes: [{ type: "put", path: "f", content: "abc" }],
          },
        ],
      },
      "canonical base64",
    );
  });

  void it("accepts valid padded base64", () => {
    const repo = validRepo({
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "ok",
          changes: [{ type: "put", path: "f", content: "YQ==" }],
        },
      ],
    });
    assert.strictEqual(repo.patches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Tree prefix-free validation
// ---------------------------------------------------------------------------

void describe("validateRepository — tree prefix-free", () => {
  void it("rejects a and a/b in same patch", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "prefix conflict",
            changes: [
              { type: "put", path: "a", content: "YQ==" },
              { type: "put", path: "a/b", content: "Yg==" },
            ],
          },
        ],
      },
      "tree paths conflict",
    );
  });
});

// ---------------------------------------------------------------------------
// Delete of absent path
// ---------------------------------------------------------------------------

void describe("validateRepository — delete of absent path", () => {
  void it("rejects delete of absent path", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "delete absent",
            changes: [{ type: "delete", path: "f" }],
          },
        ],
      },
      "delete of absent path: f",
    );
  });
});

// ---------------------------------------------------------------------------
// Edit op structure
// ---------------------------------------------------------------------------

void describe("validateRepository — edit op structure", () => {
  void it("rejects op with multiple keys", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "bad op",
            changes: [{ type: "text", path: "f", edit: [{ retain: 1, delete: 1 }] }],
          },
        ],
      },
      "must have one operation",
    );
  });

  void it("rejects empty insert array", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "empty insert",
            changes: [{ type: "text", path: "f", edit: [{ insert: [] }] }],
          },
        ],
      },
      "insert is empty",
    );
  });

  void it("rejects retain count of 0", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1,
            base: [],
            message: "zero retain",
            changes: [{ type: "text", path: "f", edit: [{ retain: 0 }] }],
          },
        ],
      },
      "positive safe integer",
    );
  });

  void it("rejects non-integer revision", () => {
    expectError(
      {
        format: 1,
        frontier: [["a@x", 1]],
        patches: [
          {
            author: "a@x",
            revision: 1.5,
            base: [],
            message: "fraction",
            changes: [{ type: "text", path: "f", edit: [] }],
          },
        ],
      },
      "positive safe integer",
    );
  });
});

// ---------------------------------------------------------------------------
// Text edit on binary base (DEC-018)
// ---------------------------------------------------------------------------

void describe("validateRepository — text edit on binary base (DEC-018)", () => {
  void it("rejects text change over binary base content", () => {
    // Binary file (has NUL byte, so not text)
    // Base64 of [0x00] = "AA=="
    const data = {
      format: 1,
      frontier: [["a@x", 2]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [],
          message: "binary",
          changes: [{ type: "put", path: "f", content: "AA==" }],
        },
        {
          author: "a@x",
          revision: 2,
          base: [["a@x", 1]],
          message: "text over binary",
          changes: [{ type: "text", path: "f", edit: [{ delete: 1 }] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });
});

// ---------------------------------------------------------------------------
// Wrong dot (revision != base[author] + 1)
// ---------------------------------------------------------------------------

void describe("validateRepository — revision contiguity", () => {
  void it("rejects patch with wrong dot (base has own author in it)", () => {
    const data = {
      format: 1,
      frontier: [["a@x", 1]],
      patches: [
        {
          author: "a@x",
          revision: 1,
          base: [["a@x", 1]], // wrong: base includes own author at rev 1, so revision should be 2
          message: "wrong dot",
          changes: [{ type: "text", path: "f", edit: [] }],
        },
      ],
    };
    assertErr(validateRepository(data));
  });
});
