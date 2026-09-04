// Text detection, LF tokenization, and canonicality checks for file content

export type Tokens = readonly string[];

// Detect if bytes are text (valid UTF-8, no null bytes, LF-terminated)
export function isText(_buf: Buffer): boolean {
  throw new Error("not implemented");
}

// Tokenize text into lines (each token ends with \n)
export function tokenize(_text: string): Tokens {
  throw new Error("not implemented");
}

// Check if a token sequence is canonical (each token ends with \n)
export function isCanonical(_tokens: Tokens): boolean {
  throw new Error("not implemented");
}
