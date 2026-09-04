// snap add — not part of the Snap specification
// SPEC §12: "no branches, tags, staging area, partial commits..."
// Snap has no staging area; add is not a valid command.

import { errInvalidCommandOrArguments } from "../errors.js";

// The `add` command is not defined in SPEC — Snap has no staging area.
// Return errInvalidCommandOrArguments for any call.
export async function run(_paths: readonly string[], _cwd: string): Promise<number> {
  throw errInvalidCommandOrArguments();
}
