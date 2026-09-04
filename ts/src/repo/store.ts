// Repository discovery walk and atomic same-directory temp-file replacement

import type { Repository } from "./model.js";

// Walk up from cwd to find the nearest .snap/repository.json; returns its directory or null
export function findRepository(_cwd: string): string | null {
  throw new Error("not implemented");
}

// Read and parse repository.json from the given directory
export async function readRepository(_dir: string): Promise<Repository> {
  throw new Error("not implemented");
}

// Atomically write repository.json (same-dir temp replace)
export async function writeRepository(_dir: string, _repo: Repository): Promise<void> {
  throw new Error("not implemented");
}
