// Install exact target path/byte map to the working directory with no leftover temp files

import type { Tree } from "../core/tree.js";

// Install the exact tree at the working directory, removing files not in tree,
// handling file↔dir transitions; no leftover temp files
export async function materialize(_workDir: string, _tree: Tree): Promise<void> {
  throw new Error("not implemented");
}
