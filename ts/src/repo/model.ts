// Repository, Patch, and Change typed value definitions

import type { DiffScript } from "../core/diff.js";

export type ChangeType = "put" | "delete" | "text";

export type Change =
  | { readonly type: "put"; readonly path: string; readonly edit: DiffScript }
  | { readonly type: "delete"; readonly path: string }
  | { readonly type: "text"; readonly path: string; readonly edit: DiffScript };

export type Patch = {
  readonly author: string;
  readonly revision: number;
  readonly base: ReadonlyMap<string, number>; // version vector
  readonly message: string;
  readonly changes: readonly Change[];
};

export type Repository = {
  readonly format: number;
  readonly frontier: ReadonlyMap<string, number>; // version vector
  readonly patches: readonly Patch[];
};
