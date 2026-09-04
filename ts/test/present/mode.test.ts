// TTY-auto unit tests for SNAP_COLOR / NO_COLOR / per-stream TTY selection
// These are YAML-inexpressible because the harness always uses pipes (no PTY).
// SPEC §7.11 | PLAN.md §8 "YAML-inexpressible → ts/test/"

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { colorMode } from "../../src/present/mode.js";
import { S } from "../../src/present/sgr.js";

// ---------------------------------------------------------------------------
// Helper — mock write stream with controllable isTTY
// ---------------------------------------------------------------------------

function makeMockStream(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

/**
 * Run fn with controlled SNAP_COLOR and NO_COLOR environment variables,
 * then restore the original values.
 */
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

// ---------------------------------------------------------------------------
// S(n, text) function
// ---------------------------------------------------------------------------

void describe("S(n, text)", () => {
  void test("wraps text with ESC[nm...ESC[0m for each code", () => {
    assert.strictEqual(S(32, "hello"), "\x1b[32mhello\x1b[0m");
    assert.strictEqual(S(1, "bold"), "\x1b[1mbold\x1b[0m");
    assert.strictEqual(S(2, "dim"), "\x1b[2mdim\x1b[0m");
    assert.strictEqual(S(31, "red"), "\x1b[31mred\x1b[0m");
    assert.strictEqual(S(33, "yellow"), "\x1b[33myellow\x1b[0m");
    assert.strictEqual(S(35, "magenta"), "\x1b[35mmagenta\x1b[0m");
    assert.strictEqual(S(36, "cyan"), "\x1b[36mcyan\x1b[0m");
  });

  void test("handles empty text", () => {
    assert.strictEqual(S(32, ""), "\x1b[32m\x1b[0m");
  });
});

// ---------------------------------------------------------------------------
// colorMode — auto (SNAP_COLOR unset or "auto")
// ---------------------------------------------------------------------------

void describe("colorMode — auto (SNAP_COLOR unset)", () => {
  void test("returns false for a non-TTY stream (no TTY, no NO_COLOR)", () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("returns true for a TTY stream (no NO_COLOR)", () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("returns false for a TTY stream when NO_COLOR is set to '1'", () => {
    withEnv(undefined, "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });

  void test("returns false for a TTY stream when NO_COLOR is set to '' (empty value)", () => {
    withEnv(undefined, "", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });

  void test("returns false for a non-TTY stream when NO_COLOR is set", () => {
    withEnv(undefined, "1", () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });
});

void describe('colorMode — SNAP_COLOR="auto"', () => {
  void test("returns false for a non-TTY stream", () => {
    withEnv("auto", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("returns true for a TTY stream (no NO_COLOR)", () => {
    withEnv("auto", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("returns false for a TTY stream when NO_COLOR is present", () => {
    withEnv("auto", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });
});

// ---------------------------------------------------------------------------
// colorMode — SNAP_COLOR="always"
// ---------------------------------------------------------------------------

void describe('colorMode — SNAP_COLOR="always"', () => {
  void test("returns true for a non-TTY stream", () => {
    withEnv("always", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), true);
    });
  });

  void test("returns true for a TTY stream", () => {
    withEnv("always", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("returns true even when NO_COLOR is present (overrides NO_COLOR)", () => {
    withEnv("always", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(false)), true);
    });
  });
});

// ---------------------------------------------------------------------------
// colorMode — SNAP_COLOR="never"
// ---------------------------------------------------------------------------

void describe('colorMode — SNAP_COLOR="never"', () => {
  void test("returns false for a non-TTY stream", () => {
    withEnv("never", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("returns false for a TTY stream (overrides TTY)", () => {
    withEnv("never", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });

  void test("returns false even without NO_COLOR", () => {
    withEnv("never", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });
});

// ---------------------------------------------------------------------------
// colorMode — stdout and stderr independently
// PLAN.md §8: "auto TTY selection for stdout and stderr independently"
// The harness always uses pipes (not TTY) so auto mode → plain in YAML tests.
// These unit tests use mock streams to verify the per-stream behavior.
// ---------------------------------------------------------------------------

void describe("colorMode — stdout and stderr independently", () => {
  void test("returns different results for TTY vs non-TTY streams with auto mode", () => {
    withEnv(undefined, undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("both return false when SNAP_COLOR=never regardless of TTY", () => {
    withEnv("never", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("both return true when SNAP_COLOR=always regardless of TTY", () => {
    withEnv("always", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
      assert.strictEqual(colorMode(makeMockStream(false)), true);
    });
  });
});

// ---------------------------------------------------------------------------
// colorMode — invalid SNAP_COLOR is NOT validated by colorMode
// (validation is done by checkSnapColor() in dispatch.ts)
// colorMode treats unknown values as "auto".
// ---------------------------------------------------------------------------

void describe("colorMode — invalid SNAP_COLOR treated as auto (colorMode does not throw)", () => {
  void test("returns false for non-TTY stream with invalid SNAP_COLOR", () => {
    withEnv("sometimes", undefined, () => {
      // colorMode doesn't throw; treats non-"always"/"never" as auto
      assert.strictEqual(colorMode(makeMockStream(false)), false);
    });
  });

  void test("returns true for TTY stream with invalid SNAP_COLOR and no NO_COLOR", () => {
    withEnv("sometimes", undefined, () => {
      assert.strictEqual(colorMode(makeMockStream(true)), true);
    });
  });

  void test("returns false for TTY stream with invalid SNAP_COLOR when NO_COLOR is present", () => {
    withEnv("sometimes", "1", () => {
      assert.strictEqual(colorMode(makeMockStream(true)), false);
    });
  });
});
