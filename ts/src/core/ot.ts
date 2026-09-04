// §6.3 operational transform for concurrent text edits

import type { DiffScript } from "./diff.js";

// Transform edit script P against Q (Q-insert priority); returns P'
export function transform(_P: DiffScript, _Q: DiffScript): DiffScript {
  throw new Error("not implemented");
}
