// Command routing: dispatches a parsed Command to the appropriate handler

import type { Command } from "./grammar.js";

// Dispatch a Command to the appropriate handler; returns exit code 0/1/2
export async function dispatch(_cmd: Command, _cwd: string): Promise<number> {
  throw new Error("not implemented");
}
