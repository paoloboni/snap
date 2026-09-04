// Duplicate-key-rejecting JSON parser and canonical repository serializer

import type { Repository } from "./model.js";

// Parse JSON, rejecting duplicate keys; throws SnapError on invalid JSON or duplicate keys
export function parseJSON(_text: string): unknown {
  throw new Error("not implemented");
}

// Serialize a Repository to canonical JSON bytes (JSON.stringify + "\n", 2-space indent,
// key order: format,frontier,patches / author,revision,base,message,changes / type,path,edit)
export function serializeRepository(_repo: Repository): string {
  throw new Error("not implemented");
}
