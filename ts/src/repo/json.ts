// Duplicate-key-rejecting JSON parser and canonical repository serializer
// SPEC §4.1: "Valid input has unique object keys."
// DEC-011: canonical serialization is JSON.stringify(v, null, 2) + "\n"

import { errDuplicateJsonKey, errInvalidJson } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attempt } from "../result.js";
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
 * Returns errDuplicateJsonKey(key) on duplicate, errInvalidJson() on malformed JSON.
 */
export function parseJSON(text: string): SnapResult<unknown> {
  // First do the duplicate-key check via a raw scan
  const dupCheck = checkDuplicateKeys(text);
  if (!dupCheck.ok) {
    return err(dupCheck.error);
  }

  // Then do the actual parse (JSON.parse is fine now that we've validated uniqueness)
  return attempt(
    () => JSON.parse(text) as unknown,
    () => errInvalidJson(),
  );
}

/**
 * Scan raw JSON text and return an error on the first duplicate key found at any depth.
 * Uses a simple state machine:
 *   - Track nesting depth via a stack of Sets (one Set per object depth).
 *   - When we see `{`, push a new Set.
 *   - When we see `}`, pop the current Set.
 *   - When we see a string token followed by `:`, it's an object key — check for duplicates.
 * Strings are parsed fully to handle escaped quotes.
 */
function checkDuplicateKeys(text: string): SnapResult<void> {
  const n = text.length;
  let i = 0;

  // Stack of Sets: each Set holds the keys seen at that object depth.
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
  function readString(): SnapResult<string> {
    if (text[i] !== '"') {
      return err(errInvalidJson());
    }
    i++; // skip opening "
    let result = "";
    while (i < n) {
      const ch = text[i];
      if (ch === '"') {
        i++; // skip closing "
        return ok(result);
      }
      if (ch === "\\") {
        i++;
        if (i >= n) return err(errInvalidJson());
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
          if (i + 4 >= n) return err(errInvalidJson());
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return err(errInvalidJson());
          result += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          return err(errInvalidJson());
        }
        i++;
      } else {
        result += ch;
        i++;
      }
    }
    return err(errInvalidJson()); // unterminated string
  }

  /**
   * Scan over a complete JSON value, recursing into nested objects and arrays
   * so that keys at every depth are checked.
   */
  function scanValue(): SnapResult<void> {
    skipWhitespace();
    if (i >= n) return err(errInvalidJson());
    const ch = text[i];

    if (ch === "{") {
      return scanObject();
    } else if (ch === "[") {
      return scanArray();
    } else if (ch === '"') {
      const s = readString(); // discard value
      if (!s.ok) return err(s.error);
      return ok(undefined);
    } else if (ch === "t") {
      // true
      if (text.slice(i, i + 4) !== "true") return err(errInvalidJson());
      i += 4;
    } else if (ch === "f") {
      // false
      if (text.slice(i, i + 5) !== "false") return err(errInvalidJson());
      i += 5;
    } else if (ch === "n") {
      // null
      if (text.slice(i, i + 4) !== "null") return err(errInvalidJson());
      i += 4;
    } else if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      // number
      if (ch === "-") i++;
      // integer part
      if (i >= n) return err(errInvalidJson());
      const digitCh = text[i];
      if (digitCh === "0") {
        i++;
      } else if (digitCh !== undefined && digitCh >= "1" && digitCh <= "9") {
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      } else {
        return err(errInvalidJson());
      }
      // optional fraction
      if (i < n && text[i] === ".") {
        i++;
        if (i >= n || text[i]! < "0" || text[i]! > "9") return err(errInvalidJson());
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
      // optional exponent
      if (i < n && (text[i] === "e" || text[i] === "E")) {
        i++;
        if (i < n && (text[i] === "+" || text[i] === "-")) i++;
        if (i >= n || text[i]! < "0" || text[i]! > "9") return err(errInvalidJson());
        while (i < n && text[i]! >= "0" && text[i]! <= "9") i++;
      }
    } else {
      return err(errInvalidJson());
    }

    return ok(undefined);
  }

  function scanObject(): SnapResult<void> {
    if (text[i] !== "{") return err(errInvalidJson());
    i++; // skip {
    const keys = new Set<string>();
    keyStack.push(keys);
    skipWhitespace();
    if (i < n && text[i] === "}") {
      i++;
      keyStack.pop();
      return ok(undefined);
    }
    // parse key-value pairs
    for (;;) {
      skipWhitespace();
      if (i >= n || text[i] !== '"') return err(errInvalidJson());
      const key = readString();
      if (!key.ok) return err(key.error);
      // Check for duplicate
      if (keys.has(key.value)) {
        return err(errDuplicateJsonKey(key.value));
      }
      keys.add(key.value);
      skipWhitespace();
      const colonCh = text[i];
      if (i >= n || colonCh !== ":") return err(errInvalidJson());
      i++; // skip :
      const value = scanValue();
      if (!value.ok) return err(value.error);
      skipWhitespace();
      if (i >= n) return err(errInvalidJson());
      const afterValCh = text[i];
      if (afterValCh === "}") {
        i++;
        keyStack.pop();
        return ok(undefined);
      }
      if (afterValCh !== ",") return err(errInvalidJson());
      i++; // skip ,
    }
  }

  function scanArray(): SnapResult<void> {
    if (text[i] !== "[") return err(errInvalidJson());
    i++; // skip [
    skipWhitespace();
    if (i < n && text[i] === "]") {
      i++;
      return ok(undefined);
    }
    for (;;) {
      const value = scanValue();
      if (!value.ok) return err(value.error);
      skipWhitespace();
      if (i >= n) return err(errInvalidJson());
      const afterArrayCh = text[i];
      if (afterArrayCh === "]") {
        i++;
        return ok(undefined);
      }
      if (afterArrayCh !== ",") return err(errInvalidJson());
      i++; // skip ,
    }
  }

  // Top-level scan
  const top = scanValue();
  if (!top.ok) return err(top.error);
  skipWhitespace();
  if (i < n) {
    // trailing content — JSON.parse would catch this too, but fail here to match behavior
    return err(errInvalidJson());
  }

  return ok(undefined);
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
