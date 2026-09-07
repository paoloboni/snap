// snap add — not part of the Snap specification
// SPEC §12: "no branches, tags, staging area, partial commits..."
// Snap has no staging area; add is not a valid command.

import { errInvalidCommandOrArguments } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { err } from "../result.js";

// The `add` command is not defined in SPEC — Snap has no staging area.
// Return errInvalidCommandOrArguments for any call.
export function run(_paths: readonly string[], _cwd: string): Promise<SnapResult<number>> {
  return Promise.resolve(err(errInvalidCommandOrArguments()));
}
