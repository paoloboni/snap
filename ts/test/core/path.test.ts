/**
 * Unit tests for core/path.ts
 * Node.js built-in test runner (node:test + node:assert/strict)
 * SPEC §2 path rules
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validatePath, comparePaths, isPrefix } from "../../src/core/path.js";
import { SnapError } from "../../src/errors.js";

function throwsSnapError(fn: () => void): void {
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    assert.ok(e instanceof SnapError, `expected SnapError, got ${String(e)}`);
  }
  assert.ok(threw, "expected function to throw SnapError");
}

// ---------------------------------------------------------------------------
// validatePath — valid paths
// ---------------------------------------------------------------------------

void describe("validatePath — valid paths", () => {
  void test("simple filename", () => {
    assert.doesNotThrow(() => validatePath("hello.txt"));
  });

  void test("nested path", () => {
    assert.doesNotThrow(() => validatePath("src/main.ts"));
  });

  void test("deeply nested", () => {
    assert.doesNotThrow(() => validatePath("a/b/c/d.txt"));
  });

  void test("unicode filename (non-ASCII chars)", () => {
    assert.doesNotThrow(() => validatePath("docs/résumé.pdf"));
  });

  void test("file at root with emoji", () => {
    assert.doesNotThrow(() => validatePath("😀.txt"));
  });

  void test("dotfile (not .snap)", () => {
    assert.doesNotThrow(() => validatePath(".gitignore"));
  });

  void test("hidden dir / file", () => {
    assert.doesNotThrow(() => validatePath(".config/settings.json"));
  });

  void test("path with dots in filename (not . or ..)", () => {
    assert.doesNotThrow(() => validatePath("some.lib.ts"));
  });
});

// ---------------------------------------------------------------------------
// validatePath — invalid paths
// ---------------------------------------------------------------------------

void describe("validatePath — invalid paths", () => {
  void test("empty string", () => {
    throwsSnapError(() => validatePath(""));
  });

  void test("leading slash", () => {
    throwsSnapError(() => validatePath("/absolute/path"));
  });

  void test("trailing slash", () => {
    throwsSnapError(() => validatePath("a/b/"));
  });

  void test("double slash (empty component)", () => {
    throwsSnapError(() => validatePath("a//b"));
  });

  void test("dot component in middle", () => {
    throwsSnapError(() => validatePath("a/./b"));
  });

  void test("dot-dot component in middle", () => {
    throwsSnapError(() => validatePath("a/../b"));
  });

  void test("solo dot component", () => {
    throwsSnapError(() => validatePath("."));
  });

  void test("solo dot-dot component", () => {
    throwsSnapError(() => validatePath(".."));
  });

  void test("leading dot-dot", () => {
    throwsSnapError(() => validatePath("../foo"));
  });

  void test("first segment is .snap", () => {
    throwsSnapError(() => validatePath(".snap/config.json"));
  });

  void test("just .snap", () => {
    throwsSnapError(() => validatePath(".snap"));
  });

  void test("null byte in path", () => {
    throwsSnapError(() => validatePath("a\x00b"));
  });

  void test("control character 0x01 in path", () => {
    throwsSnapError(() => validatePath("a\x01b"));
  });

  void test("control character 0x1F in path", () => {
    throwsSnapError(() => validatePath("a\x1fb"));
  });

  void test("backslash in path", () => {
    throwsSnapError(() => validatePath("a\\b"));
  });

  void test("single slash", () => {
    throwsSnapError(() => validatePath("/"));
  });
});

// ---------------------------------------------------------------------------
// validatePath — error type and message
// ---------------------------------------------------------------------------

void describe("validatePath — error type", () => {
  void test("throws SnapError with 'path is invalid' substring", () => {
    let err: unknown;
    try {
      validatePath(".snap/x");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SnapError);
    assert.ok(
      (err as SnapError).message.includes("path is invalid"),
      `message was: ${(err as SnapError).message}`,
    );
  });

  void test("error message does not say 'invalid path' (wrong word order)", () => {
    let err: unknown;
    try {
      validatePath("../foo");
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SnapError);
    assert.ok(
      !(err as SnapError).message.includes("invalid path"),
      `message was: ${(err as SnapError).message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// comparePaths — UTF-8 byte order
// ---------------------------------------------------------------------------

void describe("comparePaths — UTF-8 byte order", () => {
  void test("identical paths return 0", () => {
    assert.equal(comparePaths("a/b", "a/b"), 0);
  });

  void test("shorter path before longer with same prefix", () => {
    // "a" < "aa" in byte order
    assert.equal(comparePaths("a", "aa"), -1);
    assert.equal(comparePaths("aa", "a"), 1);
  });

  void test("ASCII ordering: 'a' < 'b'", () => {
    assert.equal(comparePaths("a", "b"), -1);
    assert.equal(comparePaths("b", "a"), 1);
  });

  void test("'z' (0x7A) < 'é' (U+00E9, UTF-8: 0xC3 0xA9)", () => {
    // 'z' is 0x7A in UTF-8; 'é' starts with 0xC3 > 0x7A
    assert.equal(comparePaths("z", "é"), -1);
    assert.equal(comparePaths("é", "z"), 1);
  });

  void test("'é' (U+00E9) < '😀' (U+1F600, UTF-8: 0xF0 0x9F 0x98 0x80)", () => {
    // 'é' starts with 0xC3; '😀' starts with 0xF0 > 0xC3
    assert.equal(comparePaths("é", "😀"), -1);
    assert.equal(comparePaths("😀", "é"), 1);
  });

  void test("multi-byte comparison: 'zz' > 'é' since 'z'(0x7A) < 'é'(0xC3...)", () => {
    assert.equal(comparePaths("zz", "é"), -1);
  });

  void test("path comparison with slashes", () => {
    // '/' is 0x2F; letters start at 0x41 (uppercase) or 0x61 (lowercase)
    // "a/z" vs "b/a": first byte 'a'(0x61) < 'b'(0x62)
    assert.equal(comparePaths("a/z", "b/a"), -1);
  });

  void test("symmetry: comparePaths(a,b) = -comparePaths(b,a)", () => {
    const pairs = [
      ["foo", "bar"],
      ["hello.txt", "world.txt"],
      ["z", "é"],
    ] as const;
    for (const [a, b] of pairs) {
      const ab = comparePaths(a, b);
      const ba = comparePaths(b, a);
      assert.equal(ab, -ba as -1 | 0 | 1, `symmetric for ${a}, ${b}`);
    }
  });

  void test("transitivity: a < b < c => a < c", () => {
    // "a" < "b" < "é" in UTF-8 byte order
    assert.equal(comparePaths("a", "b"), -1);
    assert.equal(comparePaths("b", "é"), -1);
    assert.equal(comparePaths("a", "é"), -1);
  });
});

// ---------------------------------------------------------------------------
// isPrefix
// ---------------------------------------------------------------------------

void describe("isPrefix", () => {
  void test("same path is a prefix of itself", () => {
    assert.ok(isPrefix("a/b", "a/b"));
  });

  void test("parent is prefix of child", () => {
    assert.ok(isPrefix("a", "a/b"));
    assert.ok(isPrefix("a/b", "a/b/c"));
  });

  void test("sibling is not a prefix", () => {
    assert.ok(!isPrefix("a/b", "a/bc"));
    assert.ok(!isPrefix("a/bc", "a/b"));
  });

  void test("parent is not a prefix of sibling subtree", () => {
    assert.ok(!isPrefix("a/b", "a/c/d"));
  });

  void test("empty string: prefix of everything? — actually validatePath forbids empty, but isPrefix itself", () => {
    // isPrefix("", "a") should be false since "" + "/" = "/" which "a" doesn't start with
    // and "" !== "a"
    assert.ok(!isPrefix("", "a"));
  });

  void test("'a' is NOT a prefix of 'ab' (no slash boundary)", () => {
    assert.ok(!isPrefix("a", "ab"));
  });

  void test("'src' is prefix of 'src/main.ts'", () => {
    assert.ok(isPrefix("src", "src/main.ts"));
  });

  void test("'src/core' is prefix of 'src/core/version.ts'", () => {
    assert.ok(isPrefix("src/core", "src/core/version.ts"));
  });

  void test("'src/core' is NOT prefix of 'src/coretypes.ts'", () => {
    assert.ok(!isPrefix("src/core", "src/coretypes.ts"));
  });

  void test("path is NOT a prefix of a shorter path", () => {
    assert.ok(!isPrefix("a/b/c", "a/b"));
  });

  void test("'a/b' is NOT prefix of 'a/b-extra'", () => {
    assert.ok(!isPrefix("a/b", "a/b-extra"));
  });
});
