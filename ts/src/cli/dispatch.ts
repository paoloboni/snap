// Command routing: dispatches a parsed Command to the appropriate handler
// SPEC §7, PLAN.md §7.5 rule 4

import type { Command } from "./grammar.js";
import { errSnapColorInvalid, errNotARepository } from "../errors.js";
import type { SnapError, SnapResult } from "../errors.js";
import { ok, err } from "../result.js";
import { SNAP_VERSION } from "../build-info.js";
import * as initCmd from "../commands/init.js";
import * as configCmd from "../commands/config.js";
import * as addCmd from "../commands/add.js";
import * as commitCmd from "../commands/commit.js";
import * as statusCmd from "../commands/status.js";
import * as logCmd from "../commands/log.js";
import * as diffCmd from "../commands/diff.js";
import * as mergeCmd from "../commands/merge.js";
import * as revertCmd from "../commands/revert.js";
import { serve } from "../net/server.js";
import { findRepository, readRepository } from "../repo/store.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";

const SNAP_COLOR_ERROR_MESSAGE = "snap: SNAP_COLOR must be auto, always, or never";

/**
 * Validate SNAP_COLOR environment variable.
 * SPEC §7.11: must be "auto", "always", "never", or unset.
 * Any other value is an error before command execution.
 */
function checkSnapColor(): SnapResult<void> {
  const val = process.env["SNAP_COLOR"];
  if (val === undefined || val === "auto" || val === "always" || val === "never") {
    return ok(undefined);
  }
  return err(errSnapColorInvalid());
}

/**
 * Write an error line to stderr, colored if SNAP_COLOR allows it.
 * SPEC §7.11: plain error <error> → S(31,"✗ " + <error>) + LF in terminal mode
 * The SNAP_COLOR-invalid error is always plain (no valid presentation selected yet).
 */
export function writeError(message: string, plain: boolean = false): void {
  if (!plain && colorMode(process.stderr)) {
    process.stderr.write(`${S(31, `\u2717 ${message}`)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
}

/**
 * Report a SnapError on stderr and yield its exit code.
 * The SNAP_COLOR-invalid error is always reported plain (SPEC §7.11).
 */
export function reportError(error: SnapError): number {
  writeError(error.message, error.message === SNAP_COLOR_ERROR_MESSAGE);
  return error.exitCode;
}

/**
 * Dispatch a Command to the appropriate handler.
 * Returns exit code 0/1/2.
 *
 * Error handling:
 * - SnapError with exitCode=1 → print to stderr, return 1
 * - SnapError with exitCode=2 → print to stderr, return 2
 */
export async function dispatch(cmd: Command, cwd: string): Promise<number> {
  // Check SNAP_COLOR before any command (PLAN.md §7.5 rule 2)
  const colorCheck = checkSnapColor();
  if (!colorCheck.ok) {
    return reportError(colorCheck.error);
  }

  const result = await routeCommand(cmd, cwd);
  if (!result.ok) {
    return reportError(result.error);
  }
  return result.value;
}

async function routeCommand(cmd: Command, cwd: string): Promise<SnapResult<number>> {
  switch (cmd.cmd) {
    case "version": {
      if (colorMode(process.stdout)) {
        // terminal mode: S(1,"snap <semver>") + LF
        process.stdout.write(`${S(1, `snap ${SNAP_VERSION}`)}\n`);
      } else {
        process.stdout.write(`snap ${SNAP_VERSION}\n`);
      }
      return ok(0);
    }

    case "init": {
      return initCmd.run(cmd.path, cwd);
    }

    case "config": {
      return configCmd.run(cmd.key, cmd.value, cmd.global ?? false, cwd);
    }

    case "add": {
      return addCmd.run(cmd.paths, cwd);
    }

    case "commit": {
      return commitCmd.run(cmd.message, cwd);
    }

    case "status": {
      return statusCmd.run(cwd);
    }

    case "log": {
      return logCmd.run(cwd);
    }

    case "diff": {
      return diffCmd.run(cmd.oldSpec, cmd.newSpec, cmd.repo, cwd);
    }

    case "merge": {
      return mergeCmd.run(cmd.url, cwd);
    }

    case "revert": {
      return revertCmd.run(cmd.version, cwd);
    }

    case "serve": {
      // serve needs a repo directory
      const repoDir = findRepository(cwd);
      if (repoDir === null) {
        return err(errNotARepository());
      }
      // Validate and snapshot the current repository at startup
      const repo = await readRepository(repoDir);
      if (!repo.ok) return err(repo.error);

      return serve(repoDir, cmd.port);
    }
  }
}
