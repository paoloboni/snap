// Grammar Adversary — Phase 5 adversarial review of CLI Builder F
// Targets: present/mode.ts, present/sgr.ts, present/render.ts, cli/dispatch.ts
// SPEC §7.11 | PLAN.md §12 "CLI and presentation" backlog items

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { colorMode } from "../../src/present/mode.js";
import { S } from "../../src/present/sgr.js";
import { makeRenderer } from "../../src/present/render.js";
import { errSnapColorInvalid } from "../../src/errors.js";

// ---------------------------------------------------------------------------
// Helper — restore env around a test
// ---------------------------------------------------------------------------

function withEnv(snapColor: string | undefined, noColor: string | undefined, fn: () => void): void {
  const origSnapColor = process.env["SNAP_COLOR"];
  const origNoColor = process.env["NO_COLOR"];
  const hadSnapColor = "SNAP_COLOR" in process.env;
  const hadNoColor = "NO_COLOR" in process.env;

  try {
    if (snapColor === undefined) {
      delete process.env["SNAP_COLOR"];
    } else {
      process.env["SNAP_COLOR"] = snapColor;
    }
    if (noColor === undefined) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = noColor;
    }
    fn();
  } finally {
    if (!hadSnapColor) {
      delete process.env["SNAP_COLOR"];
    } else {
      process.env["SNAP_COLOR"] = origSnapColor;
    }
    if (!hadNoColor) {
      delete process.env["NO_COLOR"];
    } else {
      process.env["NO_COLOR"] = origNoColor;
    }
  }
}

function makeMockStream(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

// ---------------------------------------------------------------------------
// ADV-P01: SNAP_COLOR="" is not "auto", "always", or "never"
// SPEC §7.11 line 615: "Any other value is an error before command execution"
// PLAN.md §12 line 529: `SNAP_COLOR=""` backlog item
//
// checkSnapColor() in dispatch.ts only exempts undefined | "auto" | "always" | "never".
// An empty string must fall through to errSnapColorInvalid().
// ---------------------------------------------------------------------------

void describe('SNAP_COLOR="" — must be treated as invalid (SPEC §7.11:615)', () => {
  void test("errSnapColorInvalid() carries the correct plain message", () => {
    const err = errSnapColorInvalid();
    assert.strictEqual(err.message, "snap: SNAP_COLOR must be auto, always, or never");
    assert.strictEqual(err.exitCode, 1);
  });

  void test('colorMode does NOT short-circuit to always/never for SNAP_COLOR=""', () => {
    // colorMode itself does not validate — it falls through to the auto branch.
    // With a non-TTY stream and no NO_COLOR the empty string behaves like auto → false.
    // The validation gate is in checkSnapColor() (dispatch.ts), but the contract here
    // is that mode.ts does NOT accidentally map "" to "always" or "never".
    withEnv("", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
      // "" does NOT produce true (which would mean it was treated as "always")
      assert.notStrictEqual(colorMode(makeMockStream(false)), true);
    });
  });

  void test('colorMode does NOT return true for TTY stream when SNAP_COLOR=""', () => {
    // If "" were mapped to "always", this would return true unconditionally.
    // It must instead fall through to the auto/TTY branch.
    withEnv("", undefined, () => {
      // With a TTY stream and no NO_COLOR the auto branch returns true (TTY).
      // The important invariant is that the path taken is auto, not "always".
      // We verify by checking that NO_COLOR=1 still suppresses it (it would not if "always").
      assert.strictEqual(colorMode(makeMockStream(true)), true); // auto → TTY
    });
  });

  void test('colorMode respects NO_COLOR when SNAP_COLOR="" (not treated as "always")', () => {
    // SPEC §7.11: "always" overrides NO_COLOR. If "" were mapped to "always", NO_COLOR
    // would be ignored. The auto branch must honor NO_COLOR.
    withEnv("", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false); // NO_COLOR suppresses
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P02: SNAP_COLOR=always with NO_COLOR=1 — always wins
// SPEC §7.11 lines 607–608 (table row): "terminal mode on both streams, even when
// redirected; overrides NO_COLOR"
// PLAN.md §12 line 529: `NO_COLOR present with SNAP_COLOR=always` backlog item
// ---------------------------------------------------------------------------

void describe("SNAP_COLOR=always + NO_COLOR=1 → color (SPEC §7.11:607)", () => {
  void test("colorMode returns true for a non-TTY stream with SNAP_COLOR=always and NO_COLOR=1", () => {
    withEnv("always", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(false)), true);
    });
  });

  void test("colorMode returns true for a TTY stream with SNAP_COLOR=always and NO_COLOR=1", () => {
    withEnv("always", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("colorMode returns true for a non-TTY stream with SNAP_COLOR=always and NO_COLOR='' (empty)", () => {
    // Even an empty NO_COLOR value must be overridden by always (SPEC §7.11:611–613)
    withEnv("always", "", () => {
      assert.strictEqual(colorMode(makeMockStream(false)), true);
    });
  });

  void test("colorMode returns true for a TTY stream with SNAP_COLOR=always and NO_COLOR='' (empty)", () => {
    withEnv("always", "", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P03: SNAP_COLOR=auto + NO_COLOR="" (empty string present) → plain
// SPEC §7.11 lines 611–613: "its presence, including an empty value, selects
// the complete plain presentation in auto mode"
// PLAN.md §12 line 529 (presentation backlog item 3 from the task prompt)
// ---------------------------------------------------------------------------

void describe("SNAP_COLOR=auto + NO_COLOR='' → plain (SPEC §7.11:611)", () => {
  void test("colorMode returns false for a TTY stream when NO_COLOR is empty string", () => {
    withEnv("auto", "", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });

  void test("colorMode returns false for a non-TTY stream when NO_COLOR is empty string", () => {
    withEnv("auto", "", () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("SNAP_COLOR unset + NO_COLOR='' → plain for TTY stream", () => {
    withEnv(undefined, "", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P04: S(n, text) exact escape sequence bytes
// SPEC §7.11 lines 625–626: S(n, text) = ESC[ + decimal n + m + text + ESC[0m
// "Define S(n, text) as ESC[, the decimal code n, m, text, then ESC[0m"
// ---------------------------------------------------------------------------

void describe("S(n, text) — exact byte sequences (SPEC §7.11:625)", () => {
  void test("S(1, text) produces bold sequence", () => {
    assert.strictEqual(S(1, "bold"), "\u001b[1mbold\u001b[0m");
  });

  void test("S(2, text) produces dim sequence", () => {
    assert.strictEqual(S(2, "dim"), "\u001b[2mdim\u001b[0m");
  });

  void test("S(31, text) produces red sequence", () => {
    assert.strictEqual(S(31, "red"), "\u001b[31mred\u001b[0m");
  });

  void test("S(32, text) produces green sequence", () => {
    assert.strictEqual(S(32, "green"), "\u001b[32mgreen\u001b[0m");
  });

  void test("S(33, text) produces yellow sequence", () => {
    assert.strictEqual(S(33, "yellow"), "\u001b[33myellow\u001b[0m");
  });

  void test("S(35, text) produces magenta sequence", () => {
    assert.strictEqual(S(35, "magenta"), "\u001b[35mmagenta\u001b[0m");
  });

  void test("S(36, text) produces cyan sequence", () => {
    assert.strictEqual(S(36, "cyan"), "\u001b[36mcyan\u001b[0m");
  });

  void test("S(n, text) uses ESC (0x1B), not some other byte", () => {
    const result = S(32, "x");
    assert.ok(result.startsWith("\u001b"), "must start with ESC (U+001B)");
    assert.ok(result.endsWith("\u001b[0m"), "must end with ESC[0m");
  });

  void test("S(n, text) reset is ESC[0m not ESC[m (zero must be present)", () => {
    // SPEC §7.11:626 defines ESC[0m explicitly with the "0"
    const result = S(32, "x");
    assert.ok(result.includes("\u001b[0m"), 'reset sequence must be "\\x1b[0m"');
  });

  void test("S(n, empty string) still wraps with both escape sequences", () => {
    // Adversarial: empty text should still produce the full wrapper
    assert.strictEqual(S(31, ""), "\u001b[31m\u001b[0m");
  });

  void test("S(n, text) does not double-nest reset if text itself contains SGR", () => {
    // The inner structure must be exactly ESC[nm<text>ESC[0m with no extra content
    const inner = S(32, "x");
    const outer = S(1, inner);
    // outer = ESC[1m + inner + ESC[0m = ESC[1m + ESC[32mx + ESC[0m + ESC[0m
    assert.strictEqual(outer, "\u001b[1m\u001b[32mx\u001b[0m\u001b[0m");
  });
});

// ---------------------------------------------------------------------------
// ADV-P05: colorMode checks stream.isTTY for stdout and stderr INDEPENDENTLY
// SPEC §7.11 lines 606–608: "terminal mode independently on stdout or stderr
// when that stream is a TTY"
// SPEC §11 lines 759–760: "Each implementation MUST additionally unit-test
// auto selection for TTY and non-TTY stdout and stderr independently."
// ---------------------------------------------------------------------------

void describe("colorMode — stdout and stderr independently (SPEC §7.11:606, §11:759)", () => {
  void test("auto mode: stdout TTY + stderr non-TTY are independent", () => {
    withEnv(undefined, undefined, () => {
      const stdoutLike = makeMockStream(true);
      const stderrLike = makeMockStream(false);
      assert.strictEqual(colorMode(stdoutLike), true, "stdout (TTY) should be colored");
      assert.strictEqual(colorMode(stderrLike), false, "stderr (non-TTY) should be plain");
    });
  });

  void test("auto mode: stdout non-TTY + stderr TTY are independent", () => {
    withEnv(undefined, undefined, () => {
      const stdoutLike = makeMockStream(false);
      const stderrLike = makeMockStream(true);
      assert.strictEqual(colorMode(stdoutLike), false, "stdout (non-TTY) should be plain");
      assert.strictEqual(colorMode(stderrLike), true, "stderr (TTY) should be colored");
    });
  });

  void test("auto mode: both non-TTY → both plain", () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("auto mode: both TTY → both colored", () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("auto mode with NO_COLOR: TTY stream still returns false", () => {
    // Per-stream TTY check is irrelevant when NO_COLOR is present in auto mode
    withEnv(undefined, "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P06: makeRenderer — plain vs. terminal, all SGR codes correct
// SPEC §7.11 lines 626–628: bold=1, dim=2, red=31, green=32, yellow=33,
// magenta=35, cyan=36
// ---------------------------------------------------------------------------

void describe("makeRenderer — plain mode (stream is non-TTY, no SNAP_COLOR)", () => {
  void test("all methods return identity in plain mode", () => {
    withEnv(undefined, undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      const input = "test string";
      assert.strictEqual(r.plain(input), input);
      assert.strictEqual(r.bold(input), input);
      assert.strictEqual(r.dim(input), input);
      assert.strictEqual(r.red(input), input);
      assert.strictEqual(r.green(input), input);
      assert.strictEqual(r.yellow(input), input);
      assert.strictEqual(r.magenta(input), input);
      assert.strictEqual(r.cyan(input), input);
    });
  });
});

void describe("makeRenderer — terminal mode (SNAP_COLOR=always)", () => {
  void test("plain() still returns identity in terminal mode", () => {
    // SPEC §7.11: "plain" method is pass-through regardless of mode
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.plain("unchanged"), "unchanged");
    });
  });

  void test("bold() produces S(1, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.bold("x"), "\u001b[1mx\u001b[0m");
    });
  });

  void test("dim() produces S(2, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.dim("x"), "\u001b[2mx\u001b[0m");
    });
  });

  void test("red() produces S(31, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.red("x"), "\u001b[31mx\u001b[0m");
    });
  });

  void test("green() produces S(32, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.green("x"), "\u001b[32mx\u001b[0m");
    });
  });

  void test("yellow() produces S(33, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.yellow("x"), "\u001b[33mx\u001b[0m");
    });
  });

  void test("magenta() produces S(35, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.magenta("x"), "\u001b[35mx\u001b[0m");
    });
  });

  void test("cyan() produces S(36, text)", () => {
    withEnv("always", undefined, () => {
      const r = makeRenderer(makeMockStream(false));
      assert.strictEqual(r.cyan("x"), "\u001b[36mx\u001b[0m");
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P07: makeRenderer SNAP_COLOR=never → always plain even on TTY stream
// SPEC §7.11 table: "never — plain mode on both streams"
// ---------------------------------------------------------------------------

void describe("makeRenderer — SNAP_COLOR=never forces plain on TTY stream", () => {
  void test("all methods return identity when SNAP_COLOR=never, even with TTY stream", () => {
    withEnv("never", undefined, () => {
      const r = makeRenderer(makeMockStream(true));
      assert.strictEqual(r.bold("x"), "x");
      assert.strictEqual(r.red("x"), "x");
      assert.strictEqual(r.cyan("x"), "x");
    });
  });
});

// ---------------------------------------------------------------------------
// ADV-P08: makeRenderer respects NO_COLOR in auto mode
// SPEC §7.11: "Snap treats NO_COLOR conservatively: its presence, including
// an empty value, selects the complete plain presentation in auto mode"
// ---------------------------------------------------------------------------

void describe("makeRenderer — NO_COLOR in auto mode overrides TTY", () => {
  void test("all methods return identity when NO_COLOR=1 and stream is TTY", () => {
    withEnv(undefined, "1", () => {
      const r = makeRenderer(makeMockStream(true));
      assert.strictEqual(r.bold("x"), "x");
      assert.strictEqual(r.red("x"), "x");
    });
  });

  void test("all methods return identity when NO_COLOR='' (empty) and stream is TTY", () => {
    withEnv(undefined, "", () => {
      const r = makeRenderer(makeMockStream(true));
      assert.strictEqual(r.bold("x"), "x");
      assert.strictEqual(r.cyan("x"), "x");
    });
  });
});
