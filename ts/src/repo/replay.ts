// §6.1/6.2/6.4 deterministic replay with heap ordering, OT, and warning collection

import type { Repository } from "./model.js";
import type { Tree } from "../core/tree.js";

export type Warning = { readonly path: string; readonly reason: string };

// Replay patches in snap order, applying OT; returns final tree and sorted warnings
export function replay(_repo: Repository): { tree: Tree; warnings: readonly Warning[] } {
  throw new Error("not implemented");
}

// Join two repositories (merge); returns merged Repository; throws SnapError on unresolvable conflict
export function joinRepositories(
  _local: Repository,
  _remote: Repository,
): { repo: Repository; warnings: readonly Warning[] } {
  throw new Error("not implemented");
}
