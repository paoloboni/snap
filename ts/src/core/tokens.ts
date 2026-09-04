// Text detection, LF tokenization, and canonicality checks for file content
// SPEC.md §4.4

export type Tokens = readonly string[];

/**
 * A file is text when its bytes are valid UTF-8 AND contain no NUL byte.
 * SPEC.md §4.4: "A file is text when its bytes are valid UTF-8 and contain no NUL."
 */
export function isText(buf: Buffer): boolean {
  // Check for NUL byte first (fast path)
  if (buf.includes(0)) return false;
  // Validate UTF-8 by attempting to decode and re-encode
  // Node's Buffer.toString('utf8') is lenient (replaces invalid bytes),
  // so we must check that re-encoding gives the same bytes.
  const str = buf.toString("utf8");
  const reEncoded = Buffer.from(str, "utf8");
  return buf.equals(reEncoded);
}

/**
 * Tokenize a UTF-8 text string into tokens by splitting immediately after every LF byte.
 * SPEC.md §4.4: "Split it immediately after every LF byte, retaining LF in the token."
 *
 * Examples:
 *   "a\nb\n"  → ["a\n", "b\n"]
 *   "a\nb"   → ["a\n", "b"]
 *   "\n"     → ["\n"]
 *   ""       → []
 *   "a\r\n"  → ["a\r\n"]  (only LF triggers split; \r stays in token)
 */
export function tokenize(text: string): Tokens {
  if (text.length === 0) return [];
  const tokens: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      tokens.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  // If there's a trailing non-LF suffix, include it as the final token
  if (start < text.length) {
    tokens.push(text.slice(start));
  }
  return tokens;
}

/**
 * A token sequence is CANONICAL if every token except possibly the last ends in LF.
 * SPEC.md §4.4: "every token except possibly the final one ends in LF,
 * and no token contains LF before its final byte."
 *
 * Additionally, no token may contain LF before its final byte (i.e., a mid-token LF).
 * An empty array is canonical.
 */
export function isCanonical(tokens: Tokens): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token.length === 0) return false;
    // No token may contain LF before its final byte
    const lfIdx = token.indexOf("\n");
    if (lfIdx !== -1 && lfIdx !== token.length - 1) return false;
    // Every token except possibly the last must end in LF
    if (i < tokens.length - 1 && token[token.length - 1] !== "\n") return false;
  }
  return true;
}
