// snap init [path] — create a new empty Snap repository
// SPEC §7.1

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { findRepository } from "../repo/store.js";
import { errRepositoryAlreadyExists, errCannotInitializeInsideRepository } from "../errors.js";
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
export async function run(initPath: string, cwd: string): Promise<number> {
  // Resolve target path against cwd
  const targetDir = nodePath.resolve(cwd, initPath);

  // Create the target directory recursively if needed
  await fs.mkdir(targetDir, { recursive: true });

  // Check if there's an existing repository containing targetDir
  // SPEC §7.1: "Initializing a target inside an existing repository is an error."
  // DEC-017: walk from targetDir upward; if .snap/repository.json found in any ancestor → fail
  //
  // Case 1: .snap/repository.json already exists at targetDir itself → errRepositoryAlreadyExists
  const snapDir = nodePath.join(targetDir, ".snap");
  const repoJsonPath = nodePath.join(snapDir, "repository.json");

  try {
    const stat = await fs.stat(repoJsonPath);
    if (stat.isFile()) {
      throw errRepositoryAlreadyExists();
    }
  } catch (e: unknown) {
    // If it's a SnapError, re-throw
    if (
      e !== null &&
      typeof e === "object" &&
      "name" in e &&
      (e as { name: string }).name === "SnapError"
    ) {
      throw e;
    }
    // Otherwise: file doesn't exist, continue
  }

  // Case 2: targetDir is inside an existing repository (ancestor has .snap/)
  // PLAN.md §7.5 rule 13: detects an ancestor repository when operand is "."
  // DEC-017: walk from targetDir upward
  const existingRepo = findRepository(targetDir);
  if (existingRepo !== null && existingRepo !== targetDir) {
    // targetDir is inside an existing repository
    throw errCannotInitializeInsideRepository();
  }

  // Create .snap/ directory and repository.json
  await fs.mkdir(snapDir, { recursive: true });
  await fs.writeFile(repoJsonPath, EMPTY_REPO_JSON, "utf8");

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

  return 0;
}
