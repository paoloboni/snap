/**
 * Unit tests for core/contributor.ts
 * Node.js built-in test runner (node:test + node:assert/strict)
 * SPEC §3.1 contributor ID rules
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateContributorId } from "../../src/core/contributor.js";
import { assertOk, assertErr, expectErr } from "../helpers/result.js";

const throws = assertErr;

void describe("validateContributorId — valid IDs", () => {
  void test("simple valid email", () => {
    assertOk(validateContributorId("alice@example.com"));
  });

  void test("numbers and dots", () => {
    assertOk(validateContributorId("u123@host.io"));
  });

  void test("exactly 254 bytes (valid boundary)", () => {
    // Build a 254-byte ID: {local}@{domain}
    // local = 'a' * (254 - 1 - 5) = 248 chars, domain = 'x.io' (4 chars + 1 for @)
    // Actually just: local = 'a' * 240, '@', domain = 'x' * 12 + '.c' => 240+1+12+2 = 255, too long
    // Let's compute: need total = 254, with '@' and at least 1 char each side
    // local(k) + 1(@) + domain(d) = 254
    // Use local = 'a' * 123, '@', domain = 'b' * 130 = 123+1+130 = 254 ✓
    const id = "a".repeat(123) + "@" + "b".repeat(130);
    assert.equal(Buffer.byteLength(id, "utf8"), 254);
    assertOk(validateContributorId(id));
  });

  void test("special printable ASCII characters (not forbidden ones)", () => {
    // Valid chars in range 0x21-0x7E excluding ',', '(', ')', and no '->'
    assertOk(validateContributorId("user+tag@host.org"));
    assertOk(validateContributorId("user.name@sub.domain.com"));
    assertOk(validateContributorId("user_name@host.io"));
  });

  void test("single char local and domain", () => {
    assertOk(validateContributorId("a@b"));
  });
});

void describe("validateContributorId — invalid IDs", () => {
  void test("empty string", () => {
    throws(validateContributorId(""));
  });

  void test("no @ symbol", () => {
    throws(validateContributorId("noemail"));
  });

  void test("two @ symbols", () => {
    throws(validateContributorId("a@b@c"));
  });

  void test("@ at start (empty local)", () => {
    throws(validateContributorId("@domain.com"));
  });

  void test("@ at end (empty domain)", () => {
    throws(validateContributorId("user@"));
  });

  void test("contains comma", () => {
    throws(validateContributorId("a,b@host.com"));
  });

  void test("contains open parenthesis", () => {
    throws(validateContributorId("a(b@host.com"));
  });

  void test("contains close parenthesis", () => {
    throws(validateContributorId("a)b@host.com"));
  });

  void test("contains arrow substring '->'", () => {
    throws(validateContributorId("a->b@host.com"));
  });

  void test("contains space (0x20)", () => {
    throws(validateContributorId("a b@host.com"));
  });

  void test("contains tab (0x09)", () => {
    throws(validateContributorId("a\tb@host.com"));
  });

  void test("contains newline (0x0A)", () => {
    throws(validateContributorId("a\nb@host.com"));
  });

  void test("contains carriage return (0x0D)", () => {
    throws(validateContributorId("a\rb@host.com"));
  });

  void test("contains null byte (0x00)", () => {
    throws(validateContributorId("a\x00b@host.com"));
  });

  void test("contains control character (0x01)", () => {
    throws(validateContributorId("a\x01b@host.com"));
  });

  void test("contains DEL (0x7F)", () => {
    throws(validateContributorId("a\x7fb@host.com"));
  });

  void test("exactly 255 bytes (over limit)", () => {
    // 124 + 1 + 130 = 255
    const id = "a".repeat(124) + "@" + "b".repeat(130);
    assert.equal(Buffer.byteLength(id, "utf8"), 255);
    throws(validateContributorId(id));
  });

  void test("non-ASCII character (byte > 0x7E)", () => {
    // 'é' is U+00E9, encodes as 2 bytes in UTF-8
    throws(validateContributorId("héllo@host.com"));
  });

  void test("only arrow, no @", () => {
    throws(validateContributorId("a->b"));
  });

  void test("arrow with @", () => {
    throws(validateContributorId("a->b@c"));
  });
});

void describe("validateContributorId — error type and message", () => {
  void test("returns SnapError with 'invalid contributor id' message", () => {
    expectErr(validateContributorId("no-at-sign"), "invalid contributor id");
  });

  void test("error message includes the bad ID", () => {
    expectErr(validateContributorId("bad@@id"), "bad@@id");
  });
});
