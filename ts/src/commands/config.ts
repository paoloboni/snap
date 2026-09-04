// snap config [--global] contributor.id [value] — read or write contributor configuration
// SPEC §7.2, §8

import { findRepository } from "../repo/store.js";
import { readConfig, writeLocalConfig, writeGlobalConfig } from "../repo/config.js";
import { validateContributorId } from "../core/contributor.js";
import {
  errNotARepository,
  errInvalidContributorId,
  errInvalidCommandOrArguments,
} from "../errors.js";

/**
 * Run the config command.
 * - key: must be "contributor.id"
 * - value: if provided, set the ID; otherwise print the current ID
 * - global: if true, write/read from global config ($HOME/.snapconfig.json)
 */
export async function run(
  key: string,
  value: string | undefined,
  global_: boolean,
  cwd: string,
): Promise<number> {
  // Only contributor.id is supported
  if (key !== "contributor.id") {
    throw errInvalidCommandOrArguments();
  }

  if (value !== undefined) {
    // Setting the ID: validate first
    try {
      validateContributorId(value);
    } catch {
      throw errInvalidContributorId(value);
    }

    if (global_) {
      // Write to global config
      await writeGlobalConfig({ contributorId: value });
    } else {
      // Write to local config — need a repository
      const repoDir = findRepository(cwd);
      if (repoDir === null) {
        throw errNotARepository();
      }
      await writeLocalConfig(repoDir, { contributorId: value });
    }
    // Print nothing on success
    return 0;
  } else {
    // Reading the ID
    if (global_) {
      // Read global config only
      // Test 14 shows: `snap config --global contributor.id` without value → error
      // Per the grammar in the skeleton, config with --global and no value is "get"
      // But test 14 step 5 shows this is `errInvalidCommandOrArguments`
      // Re-reading: SPEC §7.2 says `snap config [--global] contributor.id <id>`
      // The spec doesn't show a "get" form for --global. Test 14 confirms error.
      throw errInvalidCommandOrArguments();
    } else {
      // Read from local config (no-value means "print")
      const repoDir = findRepository(cwd);
      if (repoDir === null) {
        throw errNotARepository();
      }
      const config = await readConfig(repoDir);
      if (config.contributorId !== undefined) {
        process.stdout.write(config.contributorId + "\n");
      }
      return 0;
    }
  }
}
