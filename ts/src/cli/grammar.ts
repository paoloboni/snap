// argv → discriminated Command union parser for the snap CLI
// SPEC §7, PLAN.md §7.5 rule 4

import { errInvalidCommandOrArguments, errInvalidPort, errUsageDiff } from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err } from "../result.js";

export type Command =
  | { cmd: "init"; path: string }
  | { cmd: "config"; key: string; value?: string; global?: boolean }
  | { cmd: "add"; paths: readonly string[] }
  | { cmd: "diff"; oldSpec?: string; newSpec?: string; repo?: string }
  | { cmd: "commit"; message: string }
  | { cmd: "log" }
  | { cmd: "merge"; url: string }
  | { cmd: "status" }
  | { cmd: "serve"; port: number }
  | { cmd: "version" }
  | { cmd: "revert"; version: string };

/**
 * Parse argv (process.argv.slice(2)) into a Command.
 * Returns an error value on invalid command or arguments.
 *
 * PLAN.md §7.5 rule 4: Two CLI error families:
 * - `snap: invalid command or arguments` for every command EXCEPT diff
 * - `snap: usage: snap diff <old> [<new>] [--repo <url>]` for diff grammar errors
 */
export function parseArgs(argv: readonly string[]): SnapResult<Command> {
  if (argv.length === 0) {
    return err(errInvalidCommandOrArguments());
  }

  const first = argv[0]!;

  // snap --version
  if (first === "--version") {
    if (argv.length !== 1) return err(errInvalidCommandOrArguments());
    return ok({ cmd: "version" });
  }

  // snap --serve [port]
  if (first === "--serve") {
    if (argv.length > 2) return err(errInvalidCommandOrArguments());
    if (argv.length === 1) {
      return ok({ cmd: "serve", port: 8765 });
    }
    const portStr = argv[1]!;
    const port = parsePort(portStr);
    if (!port.ok) return err(port.error);
    return ok({ cmd: "serve", port: port.value });
  }

  // Unknown top-level options (e.g., --unknown)
  if (first.startsWith("-")) {
    return err(errInvalidCommandOrArguments());
  }

  const cmd = first;
  const rest = argv.slice(1);

  switch (cmd) {
    case "init": {
      // snap init [path]
      if (rest.length > 1) return err(errInvalidCommandOrArguments());
      for (const arg of rest) {
        if (arg.startsWith("-")) return err(errInvalidCommandOrArguments());
      }
      const path = rest[0] ?? ".";
      return ok({ cmd: "init", path });
    }

    case "config": {
      // snap config [--global] contributor.id [value]
      return parseConfig(rest);
    }

    case "add": {
      // snap add <path> [path...]
      if (rest.length === 0) return err(errInvalidCommandOrArguments());
      for (const arg of rest) {
        if (arg.startsWith("-")) return err(errInvalidCommandOrArguments());
      }
      return ok({ cmd: "add", paths: rest });
    }

    case "diff": {
      // snap diff [<old> [<new>] [--repo <url>]]
      // No args: compare current tree vs working tree
      return parseDiff(rest);
    }

    case "commit": {
      // snap commit <message>
      if (rest.length !== 1) return err(errInvalidCommandOrArguments());
      // message can be empty (will be validated later for content errors)
      // but '--' options are not valid as messages in grammar
      // Actually: an empty message is a valid parse but semantic error.
      // The message can start with '-' — it's user content, not an option.
      // But SPEC says options occur "exactly in the positions shown" — commit has none.
      // So we just require exactly 1 arg.
      return ok({ cmd: "commit", message: rest[0]! });
    }

    case "log": {
      // snap log
      if (rest.length !== 0) return err(errInvalidCommandOrArguments());
      return ok({ cmd: "log" });
    }

    case "merge": {
      // snap merge <url>
      if (rest.length !== 1) return err(errInvalidCommandOrArguments());
      if (rest[0]!.startsWith("-")) return err(errInvalidCommandOrArguments());
      return ok({ cmd: "merge", url: rest[0]! });
    }

    case "status": {
      // snap status
      if (rest.length !== 0) return err(errInvalidCommandOrArguments());
      return ok({ cmd: "status" });
    }

    case "revert": {
      // snap revert <version>
      if (rest.length !== 1) return err(errInvalidCommandOrArguments());
      if (rest[0]!.startsWith("-")) return err(errInvalidCommandOrArguments());
      return ok({ cmd: "revert", version: rest[0]! });
    }

    default:
      return err(errInvalidCommandOrArguments());
  }
}

/**
 * Parse config arguments: [--global] contributor.id [value]
 */
function parseConfig(args: readonly string[]): SnapResult<Command> {
  let global_ = false;
  let idx = 0;

  // Check for --global flag at beginning
  if (args.length > 0 && args[0] === "--global") {
    global_ = true;
    idx = 1;
  }

  const remaining = args.slice(idx);

  if (remaining.length === 0) return err(errInvalidCommandOrArguments());

  const key = remaining[0]!;

  // Check for duplicate or misplaced --global
  if (remaining.includes("--global")) return err(errInvalidCommandOrArguments());

  // Only contributor.id is supported
  if (key !== "contributor.id") return err(errInvalidCommandOrArguments());

  // Check for unknown options in remaining args
  for (let i = 1; i < remaining.length; i++) {
    if (remaining[i]!.startsWith("-")) return err(errInvalidCommandOrArguments());
  }

  if (remaining.length === 1) {
    // Read-only: snap config contributor.id (no --global for read)
    if (global_) {
      // snap config --global contributor.id (no value) → invalid per test 14
      return err(errInvalidCommandOrArguments());
    }
    return ok({ cmd: "config", key, global: false });
  }

  if (remaining.length === 2) {
    const value = remaining[1]!;
    if (global_) {
      return ok({ cmd: "config", key, value, global: true });
    }
    return ok({ cmd: "config", key, value });
  }

  // Too many args
  return err(errInvalidCommandOrArguments());
}

/**
 * Parse diff arguments: [<old> [<new>] [--repo <url>]]
 * or: [--repo <url> <old> [<new>]]
 * or: [] (no args — working tree diff)
 *
 * PLAN.md §7.5 rule 4: diff errors use errUsageDiff.
 */
function parseDiff(args: readonly string[]): SnapResult<Command> {
  // No args: diff current tree vs working tree
  if (args.length === 0) {
    return ok({ cmd: "diff" });
  }

  let repoUrl: string | undefined;
  const versionArgs: string[] = [];
  let sawRepoDuplicate = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--repo") {
      if (repoUrl !== undefined) {
        sawRepoDuplicate = true;
      }
      if (i + 1 >= args.length) return err(errUsageDiff()); // missing value after --repo
      repoUrl = args[i + 1]!;
      i += 2;
    } else if (arg.startsWith("-")) {
      return err(errUsageDiff()); // unknown option
    } else {
      versionArgs.push(arg);
      i++;
    }
  }

  if (sawRepoDuplicate) return err(errUsageDiff());

  // With --repo, must have at least old and new
  if (repoUrl !== undefined && versionArgs.length < 2) return err(errUsageDiff());

  // Must have exactly 2 version args (old and new) per SPEC §7.6
  if (versionArgs.length < 2) return err(errUsageDiff());
  if (versionArgs.length > 2) return err(errUsageDiff()); // too many version args

  const oldSpec = versionArgs[0]!;
  const newSpec = versionArgs[1]!;
  if (repoUrl !== undefined) {
    return ok({ cmd: "diff", oldSpec, newSpec, repo: repoUrl });
  }
  return ok({ cmd: "diff", oldSpec, newSpec });
}

/**
 * Parse a port number string.
 * SPEC §7.9: port defaults to 8765, 0 selects OS port.
 * Valid range: 0–65535.
 * Test 14: 65536 → errInvalidPort.
 */
function parsePort(s: string): SnapResult<number> {
  // Must be digits only (no sign)
  if (!/^\d+$/.test(s)) {
    return err(errInvalidPort(s));
  }
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 65535) {
    return err(errInvalidPort(s));
  }
  return ok(n);
}
