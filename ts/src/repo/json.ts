// Duplicate-key-rejecting JSON parser and canonical repository serializer
// SPEC §4.1: "Valid input has unique object keys."
// DEC-011: canonical serialization is JSON.stringify(v, null, 2) + "\n"

import { errDuplicateJsonKey, errInvalidJson } from "../errors.js";
import type { Repository, Patch, Change } from "./model.js";
import type { DiffOp } from "../core/diff.js";

// ---------------------------------------------------------------------------
// Duplicate-key-detecting JSON parser
// ---------------------------------------------------------------------------

/**
 * Parse JSON text, rejecting duplicate keys at any nesting level.
 * Uses a state-machine tokenizer to scan raw text for object key tokens
 * and tracks per-depth sets of keys.
 *
 * Throws errDuplicateJsonKey(key) on duplicate, errInvalidJson() on malformed JSON.
 */
export function parseJSON(text: string): unknown {
  // First do the duplicate-key check via a raw scan
  checkDuplicateKeys(text);

  // Then do the actual parse (JSON.parse is fine now that we've validated uniqueness)
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errInvalidJson();
  }
}

/**
 * Scan raw JSON text and throw on the first duplicate key found at any depth.
 * Uses a simple state machine:
 *   - Track nesting depth via a stack of Sets (one Set per object depth).
 *   - When we see `{`, push a new Set.
 *   - When we see `}`, pop the current Set.
 *   - When we see a string token followed by `:`, it's an object key — check for duplicates.
 * Strings are parsed fully to handle escaped quotes.
 */
function checkDuplicateKeys(text: string): void {
  const n = text.length;
  let i = 0;

  // Stack of Sets: each Set holds the keys seen at that object depth.
  // We only push onto this stack when inside an object (not an array).
  // We also need to track whether each nesting level is an object or array.
  const kindStack: Array<"object" | "array"> = [];
  const keyStack: Array<Set<string>> = [];

  function skipWhitespace(): void {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) {
      i++;
    }
  }

  /**
   * Read a JSON string starting at position i (which must be `"`).
   * Returns the decoded string value. Advances i past the closing `"`.
   */
  function readString(): string {
    if (text[i] !== '"') {
      throw errInvalidJson();
    }
    i++; // skip opening "
    let result = "";
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        i++; // skip closing "
        return result;
      }
      if (ch === "\\") {
        i++;
        if (i >= n) throw errInvalidJson();
        const esc = text[i];
        if (esc === '"') {
          result += '"';
        } else if (esc === "\\") {
          result += "\\";
        } else if (esc === "/") {
          result += "/";
        } else if (esc === "b") {
          result += "\b";
        } else if (esc === "f") {
          result += "\f";
        } else if (esc === "n") {
          result += "\n";
        } else if (esc === "r") {
          result += "\r";
        } else if (esc === "t") {
          result += "\t";
        } else if (esc === "u") {
          // Read 4 hex digits
          if (i + 4 >= n) throw errInvalidJson();
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw errInvalidJson();
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          throw errInvalidJson();
        }
        i++;
      } else {
        result += ch;
        i++;
      }
    }
    throw errInvalidJson(); // unterminated string
  }

  /**
   * Skip over a complete JSON value (without tracking keys — used for values
   * in non-object contexts and for non-string values). Actually we DO need to
   * track keys inside nested objects/arrays, so we call scanValue recursively.
   */
  function scanValue(): void {
    skipWhitespace();
    if (i >= n) throw errInvalidJson();
    const ch = text[i];

    if (ch === "{") {
      scanObject();
    } else if (ch === "[") {
      scanArray();
    } else if (ch === '"') {
      readString(); // discard value
    } else if (ch === "t") {
      // true
      if (text.slice(i, i + 4) !== "true") throw errInvalidJson();
      i += 4;
    } else if (ch === "f") {
      // false
      if (text.slice(i, i + 5) !== "false") throw errInvalidJson();
      i += 5;
    } else if (ch === "n") {
      // null
      if (text.slice(i, i + 4) !== "null") throw errInvalidJson();
      i += 4;
    } else if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      // number
      if (ch === "-") i++;
      // integer part
      if (i >= n) throw errInvalidJson();
      const digitCh = text[i];
      if (digitCh === "0") {
        i++;
      } else if (digitCh !== undefined && digitCh >= "1" && digitCh <= "9") {
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      } else {
        throw errInvalidJson();
      }
      // optional fraction
      if (i < n && text[i] === ".") {
        i++;
        if (i >= n || text[i]! < "0" || text[i]! > "9") throw errInvalidJson();
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
      // optional exponent
      if (i < n && (text[i] === "e" || text[i] === "E")) {
        i++;
        if (i < n && (text[i] === "+" || text[i] === "-")) i++;
        if (i >= n || text[i]! < "0" || text[i]! > "9") throw errInvalidJson();
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
    } else {
      throw errInvalidJson();
    }
  }

  function scanObject(): void {
    if (text[i] !== "{") throw errInvalidJson();
    i++; // skip {
    kindStack.push("object");
    const keys = new Set<string>();
    keyStack.push(keys);
    skipWhitespace();
    if (i < n && text[i] === "}") {
      i++;
      kindStack.pop();
      keyStack.pop();
      return;
    }
    // parse key-value pairs
    for (;;) {
      skipWhitespace();
      if (i >= n || text[i] !== '"') throw errInvalidJson();
      const key = readString();
      // Check for duplicate
      if (keys.has(key)) {
        throw errDuplicateJsonKey(key);
      }
      keys.add(key);
      skipWhitespace();
      const colonCh = text[i];
      if (i >= n || colonCh !== ":") throw errInvalidJson();
      i++; // skip :
      scanValue();
      skipWhitespace();
      if (i >= n) throw errInvalidJson();
      const afterValCh = text[i];
      if (afterValCh === "}") {
        i++;
        kindStack.pop();
        keyStack.pop();
        return;
      }
      if (afterValCh !== ",") throw errInvalidJson();
      i++; // skip ,
    }
  }

  function scanArray(): void {
    if (text[i] !== "[") throw errInvalidJson();
    i++; // skip [
    kindStack.push("array");
    skipWhitespace();
    if (i < n && text[i] === "]") {
      i++;
      kindStack.pop();
      return;
    }
    for (;;) {
      scanValue();
      skipWhitespace();
      if (i >= n) throw errInvalidJson();
      const afterArrayCh = text[i];
      if (afterArrayCh === "]") {
        i++;
        kindStack.pop();
        return;
      }
      if (afterArrayCh !== ",") throw errInvalidJson();
      i++; // skip ,
    }
  }

  // Top-level scan
  scanValue();
  skipWhitespace();
  if (i < n) {
    // trailing content — JSON.parse will catch this
    // but we should also fail here to match behavior
    throw errInvalidJson();
  }
}

// ---------------------------------------------------------------------------
// Canonical repository serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a Repository to canonical JSON bytes.
 * DEC-011: JSON.stringify(v, null, 2) + "\n"
 * Key order (per PLAN.md §7.5 rule 2 and DEC-011):
 *   Top-level: format, frontier, patches
 *   Per patch: author, revision, base, message, changes
 *   Per change: type, path, then edit (text) or content (put)
 *   Edit ops: retain/delete/insert key only (already single-key objects)
 *   Frontier and base: sorted arrays of [id, revision] pairs
 */
export function serializeRepository(repo: Repository): string {
  const obj = buildRepositoryObject(repo);
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Convert a version vector Map to a sorted [[id, revision]] array.
 * SPEC §3.2: sorted by unsigned UTF-8 byte order of the full "id->revision" entry string.
 * Wait — in JSON, the version vector is sorted by the full entry string per §3.3.
 * Re-reading §3.2: "A nonempty version sorts contributors by unsigned UTF-8 bytes".
 * The JSON form is [[id, rev], ...] sorted by unsigned UTF-8 bytes of... the ID?
 * Looking at test 26 and 27 examples: frontier: [["a@x", 1], ["b@x", 1]] — sorted by ID.
 * Actually §3.2 says sorted contributors; the full entry string sort from parseVersionString
 * sorts by "id->revision" string. But for JSON pairs, there's no "->" so sort by ID bytes.
 * Let's look at the SPEC §3.2: "sorts contributors by unsigned UTF-8 bytes" — that's the ID.
 */
function versionVectorToArray(v: ReadonlyMap<string, number>): [string, number][] {
  const entries: [string, number][] = [...v.entries()];
  // Sort by UTF-8 byte order of contributor ID
  entries.sort(([a], [b]) => {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    return bufA.compare(bufB);
  });
  return entries;
}

function buildChangeObject(change: Change): Record<string, unknown> {
  switch (change.type) {
    case "put":
      return { type: change.type, path: change.path, content: change.content };
    case "delete":
      return { type: change.type, path: change.path };
    case "text":
      return { type: change.type, path: change.path, edit: buildEditArray(change.edit) };
  }
}

function buildEditArray(edit: readonly DiffOp[]): unknown[] {
  return edit.map((op) => {
    if (op.type === "retain") {
      return { retain: op.count };
    } else if (op.type === "delete") {
      return { delete: op.count };
    } else {
      return { insert: [...op.tokens] };
    }
  });
}

function buildPatchObject(patch: Patch): Record<string, unknown> {
  return {
    author: patch.author,
    revision: patch.revision,
    base: versionVectorToArray(patch.base),
    message: patch.message,
    changes: patch.changes.map(buildChangeObject),
  };
}

function buildRepositoryObject(repo: Repository): Record<string, unknown> {
  return {
    format: repo.format,
    frontier: versionVectorToArray(repo.frontier),
    patches: repo.patches.map(buildPatchObject),
  };
}
