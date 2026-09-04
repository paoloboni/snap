/**
 * Tests for core/tokens.ts
 * SPEC.md §4.4: text detection, LF tokenization, canonicality
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isText, tokenize, isCanonical } from "../../src/core/tokens.js";

// ---------------------------------------------------------------------------
// isText
// ---------------------------------------------------------------------------

void describe("isText", () => {
  void test("empty buffer is text", () => {
    assert.equal(isText(Buffer.alloc(0)), true);
  });

  void test("plain ASCII is text", () => {
    assert.equal(isText(Buffer.from("hello world\n", "utf8")), true);
  });

  void test("valid UTF-8 multi-byte is text", () => {
    // café in UTF-8
    assert.equal(isText(Buffer.from("café\n", "utf8")), true);
  });

  void test("NUL byte makes non-text", () => {
    assert.equal(isText(Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x00])), false);
  });

  void test("NUL byte in middle is non-text", () => {
    assert.equal(isText(Buffer.from([0x61, 0x00, 0x62])), false);
  });

  void test("NUL byte at start is non-text", () => {
    assert.equal(isText(Buffer.from([0x00, 0x61, 0x62])), false);
  });

  void test("invalid UTF-8 byte sequence is non-text", () => {
    // 0xFF is not valid UTF-8
    assert.equal(isText(Buffer.from([0xff, 0x61])), false);
  });

  void test("invalid UTF-8 continuation byte alone is non-text", () => {
    // 0x80 alone is not valid UTF-8 (continuation byte without leading byte)
    assert.equal(isText(Buffer.from([0x80])), false);
  });

  void test("overlong UTF-8 encoding is non-text", () => {
    // Overlong encoding of 'A' (U+0041): 0xC1 0x81 - invalid
    assert.equal(isText(Buffer.from([0xc1, 0x81])), false);
  });

  void test("valid CRLF text is text", () => {
    assert.equal(isText(Buffer.from("line\r\n", "utf8")), true);
  });

  void test("binary-like content with NUL is non-text", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]); // PNG-like with NUL
    assert.equal(isText(buf), false);
  });

  void test("text with LF only is text", () => {
    assert.equal(isText(Buffer.from("a\nb\nc\n", "utf8")), true);
  });

  void test("UTF-8 BOM is text (BOM has no NUL and is valid UTF-8)", () => {
    // BOM = EF BB BF
    assert.equal(isText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x65, 0x6c, 0x6c, 0x6f])), true);
  });
});

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

void describe("tokenize", () => {
  void test("empty string produces empty tokens", () => {
    assert.deepEqual(tokenize(""), []);
  });

  void test("single LF produces one token", () => {
    assert.deepEqual(tokenize("\n"), ["\n"]);
  });

  void test("single line with LF", () => {
    assert.deepEqual(tokenize("hello\n"), ["hello\n"]);
  });

  void test("two lines with LF", () => {
    assert.deepEqual(tokenize("a\nb\n"), ["a\n", "b\n"]);
  });

  void test("text without final LF", () => {
    assert.deepEqual(tokenize("a\nb"), ["a\n", "b"]);
  });

  void test("single line without LF", () => {
    assert.deepEqual(tokenize("hello"), ["hello"]);
  });

  void test("CRLF line endings — CR stays in token, only LF splits", () => {
    assert.deepEqual(tokenize("a\r\n"), ["a\r\n"]);
  });

  void test("CRLF multiline", () => {
    assert.deepEqual(tokenize("a\r\nb\r\n"), ["a\r\n", "b\r\n"]);
  });

  void test("CRLF without trailing LF", () => {
    assert.deepEqual(tokenize("a\r\nb"), ["a\r\n", "b"]);
  });

  void test("multiple blank lines (multiple LFs)", () => {
    assert.deepEqual(tokenize("\n\n\n"), ["\n", "\n", "\n"]);
  });

  void test("LF at start produces empty-like prefix token", () => {
    // \nhello\n → ["\n", "hello\n"]
    assert.deepEqual(tokenize("\nhello\n"), ["\n", "hello\n"]);
  });

  void test("three lines all with LF", () => {
    assert.deepEqual(tokenize("a\nb\na\n"), ["a\n", "b\n", "a\n"]);
  });

  void test("repeated lines", () => {
    const result = tokenize("a\na\na\n");
    assert.deepEqual(result, ["a\n", "a\n", "a\n"]);
  });

  void test("five lines from test-22 base", () => {
    assert.deepEqual(tokenize("0\n1\n2\n3\n4\n"), ["0\n", "1\n", "2\n", "3\n", "4\n"]);
  });
});

// ---------------------------------------------------------------------------
// isCanonical
// ---------------------------------------------------------------------------

void describe("isCanonical", () => {
  void test("empty array is canonical", () => {
    assert.equal(isCanonical([]), true);
  });

  void test("single token ending in LF is canonical", () => {
    assert.equal(isCanonical(["hello\n"]), true);
  });

  void test("single token NOT ending in LF is canonical (last token may lack LF)", () => {
    assert.equal(isCanonical(["hello"]), true);
  });

  void test("multiple tokens all ending in LF is canonical", () => {
    assert.equal(isCanonical(["a\n", "b\n", "c\n"]), true);
  });

  void test("last token without LF, rest with LF is canonical", () => {
    assert.equal(isCanonical(["a\n", "b\n", "c"]), true);
  });

  void test("middle token without LF is NOT canonical", () => {
    assert.equal(isCanonical(["a", "b\n"]), false);
  });

  void test("first token without LF (two tokens) is NOT canonical", () => {
    assert.equal(isCanonical(["hello", "world\n"]), false);
  });

  void test("token with LF in middle (not at end) is NOT canonical", () => {
    assert.equal(isCanonical(["a\nb\n"]), false);
  });

  void test("token with LF before final char is NOT canonical", () => {
    assert.equal(isCanonical(["a\nb"]), false);
  });

  void test("empty string token is NOT canonical", () => {
    assert.equal(isCanonical([""]), false);
  });

  void test("empty string token in middle is NOT canonical", () => {
    assert.equal(isCanonical(["a\n", "", "b\n"]), false);
  });

  void test("result of tokenize('a\\nb\\n') is canonical", () => {
    assert.equal(isCanonical(tokenize("a\nb\n")), true);
  });

  void test("result of tokenize('a\\nb') is canonical", () => {
    assert.equal(isCanonical(tokenize("a\nb")), true);
  });

  void test("result of tokenize('') is canonical", () => {
    assert.equal(isCanonical(tokenize("")), true);
  });
});
