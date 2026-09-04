// §4.5 ordered repository validation pipeline

import type { Repository } from "./model.js";

// Validate a parsed Repository object per §4.5 ordered pipeline; throws SnapError on first violation
export function validateRepository(_data: unknown): Repository {
  throw new Error("not implemented");
}
