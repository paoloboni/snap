// §8 local-over-global configuration resolution for contributor ID
// Global config: $HOME/.snapconfig.json
// Local config: .snap/config.json
// SPEC §8, PLAN.md §7.5 rule 9

import * as fsAsync from "node:fs/promises";
import * as nodePath from "node:path";
import { parseJSON } from "./json.js";
import { validateContributorId } from "../core/contributor.js";
import { errInvalidContributorId, errInternalError } from "../errors.js";
import type { SnapError, SnapResult } from "../errors.js";
import { ok, err, attemptAsync } from "../result.js";

export type Config = { contributorId?: string };

const SNAP_DIR = ".snap";
const LOCAL_CONFIG_FILE = "config.json";
const GLOBAL_CONFIG_FILE = ".snapconfig.json";

/**
 * Read configuration, resolving local-over-global precedence.
 * SPEC §8:
 * - Read .snap/config.json (local) first.
 *   - If it exists and provides contributor.id → return it (do NOT read global).
 *   - If it exists with an invalid contributor.id → error (do NOT fall through to global).
 *   - If it exists but has no contributor.id → fall through to global.
 * - Read $HOME/.snapconfig.json (global).
 *   - If it exists and provides contributor.id → return it.
 *   - If it exists but is malformed → error.
 * - Return {} if no ID found anywhere.
 *
 * Unknown fields are silently ignored when reading (PLAN.md §7.5 rule 9: not validated on read).
 */
export async function readConfig(repoDir: string): Promise<SnapResult<Config>> {
  const localPath = nodePath.join(repoDir, SNAP_DIR, LOCAL_CONFIG_FILE);

  // Try local config
  const localResult = await tryReadConfigFile(localPath);
  if (localResult.status === "error") {
    return err(localResult.error);
  }
  if (localResult.status === "found" && localResult.contributorId !== undefined) {
    // Local config has a valid id — return it, do NOT read global
    return ok({ contributorId: localResult.contributorId });
  }
  // Either local config not found or has no id — fall through to global

  // Try global config
  const home = process.env["HOME"];
  if (home === undefined || home === "") {
    return ok({});
  }

  const globalPath = nodePath.join(home, GLOBAL_CONFIG_FILE);
  const globalResult = await tryReadConfigFile(globalPath);
  if (globalResult.status === "error") {
    return err(globalResult.error);
  }
  if (globalResult.status === "found" && globalResult.contributorId !== undefined) {
    return ok({ contributorId: globalResult.contributorId });
  }

  return ok({});
}

type ReadResult =
  | { status: "not_found" }
  | { status: "found"; contributorId: string | undefined }
  | { status: "error"; error: SnapError };

/** Distinguishes a missing file from a genuine read failure at the fs boundary. */
type ReadFailure = { kind: "not_found" } | { kind: "error"; error: SnapError };

/**
 * Try reading a config file. Returns:
 * - "not_found" if the file doesn't exist
 * - "found" with the contributorId (or undefined if not present)
 * - "error" if the file is malformed (invalid JSON, duplicate keys, or invalid id)
 */
async function tryReadConfigFile(filePath: string): Promise<ReadResult> {
  const text = await attemptAsync(
    () => fsAsync.readFile(filePath, "utf8"),
    (thrown): ReadFailure =>
      isNotFoundError(thrown)
        ? { kind: "not_found" }
        : { kind: "error", error: errInternalError(thrown) },
  );

  if (!text.ok) {
    if (text.error.kind === "not_found") {
      return { status: "not_found" };
    }
    return { status: "error", error: text.error.error };
  }

  // Parse JSON (rejects duplicate keys)
  const data = parseJSON(text.value);
  if (!data.ok) {
    return { status: "error", error: data.error };
  }

  // Extract contributor.id — silently ignore unknown fields
  const id = extractContributorId(data.value);
  if (id === undefined) {
    return { status: "found", contributorId: undefined };
  }

  // Validate the id — invalid id is an error, does NOT fall through to global
  if (!validateContributorId(id).ok) {
    return { status: "error", error: errInvalidContributorId(id) };
  }

  return { status: "found", contributorId: id };
}

/**
 * Write local config to .snap/config.json atomically.
 * Only writes contributor.id; unknown fields are dropped (PLAN.md §7.5 rule 9).
 */
export async function writeLocalConfig(repoDir: string, config: Config): Promise<SnapResult<void>> {
  const snapDir = nodePath.join(repoDir, SNAP_DIR);
  const configPath = nodePath.join(snapDir, LOCAL_CONFIG_FILE);
  const tempPath = nodePath.join(snapDir, `.snap-tmp-${Math.random().toString(36).slice(2)}`);

  return writeConfigAtomically(tempPath, configPath, config);
}

/**
 * Write global config to $HOME/.snapconfig.json atomically.
 */
export async function writeGlobalConfig(config: Config): Promise<SnapResult<void>> {
  const home = process.env["HOME"];
  if (home === undefined || home === "") {
    return err(errInternalError(new Error("HOME is not set")));
  }
  const globalPath = nodePath.join(home, GLOBAL_CONFIG_FILE);
  const tempPath = nodePath.join(home, `.snap-tmp-${Math.random().toString(36).slice(2)}`);

  return writeConfigAtomically(tempPath, globalPath, config);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize the known config fields and install them via a same-directory temp
 * file, cleaning the temp file up if the write or rename fails.
 */
async function writeConfigAtomically(
  tempPath: string,
  targetPath: string,
  config: Config,
): Promise<SnapResult<void>> {
  // Build minimal config object — only known fields, drop unknowns
  const obj: Record<string, unknown> = {};
  if (config.contributorId !== undefined) {
    obj["contributor"] = { id: config.contributorId };
  }

  const text = JSON.stringify(obj, null, 2) + "\n";
  const bytes = Buffer.from(text, "utf8");

  const written = await attemptAsync(async () => {
    await fsAsync.writeFile(tempPath, bytes);
    await fsAsync.rename(tempPath, targetPath);
  }, errInternalError);

  if (!written.ok) {
    // Best-effort cleanup; a failure to remove the temp file is ignored.
    await attemptAsync(() => fsAsync.unlink(tempPath), errInternalError);
    return err(written.error);
  }

  return ok(undefined);
}

/**
 * Extract contributor.id from a parsed config value.
 * Returns undefined if the field is absent or contributor object has no id.
 * Does NOT validate — caller is responsible for validation.
 * Silently ignores unknown fields.
 */
function extractContributorId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const obj = data as Record<string, unknown>;
  const contributor = obj["contributor"];
  if (typeof contributor !== "object" || contributor === null || Array.isArray(contributor)) {
    return undefined;
  }
  const contribObj = contributor as Record<string, unknown>;
  const id = contribObj["id"];
  if (typeof id !== "string") {
    return undefined;
  }
  return id;
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
