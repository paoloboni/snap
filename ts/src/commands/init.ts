// snap init [path] — create a new empty Snap repository
// SPEC §7.1

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { findRepository } from "../repo/store.js";
import {
  errRepositoryAlreadyExists,
  errCannotInitializeInsideRepository,
  errInternalError,
} from "../errors.js";
import type { SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";
import { colorMode } from "../present/mode.js";
import { S } from "../present/sgr.js";
import { formatVersionString } from "../core/version.js";

const EMPTY_REPO_JSON = JSON.stringify({ format: 1, frontier: [], patches: [] }, null, 2) + "\n";

/**
 * Run the init command.
 * - Creates the target directory if it doesn't exist (including parents recursively).
 * - Fails if the target is already inside an existing repository.
 * - Fails if .snap/repository.json already exists at the target.
 * - Prints "()\n" in plain mode, colored output in terminal mode.
 */
export async function run(initPath: string, cwd: string): Promise<SnapResult<number>> {
  // Resolve target path against cwd
  const targetDir = nodePath.resolve(cwd, initPath);

  // Create the target directory recursively if needed
  const made = await attemptAsync(() => fs.mkdir(targetDir, { recursive: true }), errInternalError);
  if (!made.ok) return err(made.error);

  // Check if there's an existing repository containing targetDir
  // SPEC §7.1: "Initializing a target inside an existing repository is an error."
  // DEC-017: walk from targetDir upward; if .snap/repository.json found in any ancestor → fail
  //
  // Case 1: .snap/repository.json already exists at targetDir itself → errRepositoryAlreadyExists
  const snapDir = nodePath.join(targetDir, ".snap");
  const repoJsonPath = nodePath.join(snapDir, "repository.json");

  // A stat failure means the path is absent, which is the normal case.
  const alreadyARepo = await attemptAsync(
    async () => (await fs.stat(repoJsonPath)).isFile(),
    () => false,
  );
  if (alreadyARepo.ok && alreadyARepo.value) {
    return err(errRepositoryAlreadyExists());
  }

  // Case 2: targetDir is inside an existing repository (ancestor has .snap/)
  // PLAN.md §7.5 rule 13: detects an ancestor repository when operand is "."
  // DEC-017: walk from targetDir upward
  const existingRepo = findRepository(targetDir);
  if (existingRepo !== null && existingRepo !== targetDir) {
    // targetDir is inside an existing repository
    return err(errCannotInitializeInsideRepository());
  }

  // Create .snap/ directory and repository.json
  const madeSnapDir = await attemptAsync(
    () => fs.mkdir(snapDir, { recursive: true }),
    errInternalError,
  );
  if (!madeSnapDir.ok) return err(madeSnapDir.error);

  const written = await attemptAsync(
    () => fs.writeFile(repoJsonPath, EMPTY_REPO_JSON, "utf8"),
    errInternalError,
  );
  if (!written.ok) return err(written.error);

  const emptyVersion = formatVersionString(new Map());

  if (colorMode(process.stdout)) {
    // terminal mode: S(32,"✓") + " " + S(1,"Initialized repository") + " " + S(36,version) + LF
    process.stdout.write(
      `${S(32, "✓")} ${S(1, "Initialized repository")} ${S(36, emptyVersion)}\n`,
    );
  } else {
    // plain mode: just the version string
    process.stdout.write(`${emptyVersion}\n`);
  }

  return ok(0);
}
