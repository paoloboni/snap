/**
 * Integration Adversary tests — Phase 4 adversarial review of Commands Builder H
 *
 * This file is the adversarial review product of the Integration Adversary.
 * Each test covers a precedence edge case NOT present in the shared YAML suite.
 *
 * Every test is derived from:
 *   - SPEC.md §7–8 (command behavior)
 *   - PLAN.md §7.5 (pinned facts and error-precedence rules)
 *   - docs/DECISIONS.md DEC-015 (error precedence table)
 *
 * Objections are documented in the return format at the bottom of this file.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as cp from "node:child_process";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SNAP_BIN = nodePath.resolve(
  nodePath.dirname(new URL(import.meta.url).pathname),
  "../../snap",
);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runSnap(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    // Propagate PATH from process.env
    if (process.env["PATH"] !== undefined) env["PATH"] = process.env["PATH"];
    // NO_COLOR=1 to suppress terminal presentation (matches harness behavior)
    env["NO_COLOR"] = "1";
    // Override with caller-supplied env (undefined values remove the key)
    if (options.env !== undefined) {
      for (const [k, v] of Object.entries(options.env)) {
        if (v === undefined) {
          delete env[k];
        } else {
          env[k] = v;
        }
      }
    }
    const proc = cp.spawn(SNAP_BIN, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", reject);
  });
}

async function makeSandbox(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), "snap-adv-"));
}

async function rmSandbox(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Create a fresh repo at sandbox/repo, configure contributor.id, return repo path. */
async function initRepo(sandbox: string, contributorId = "a@x"): Promise<string> {
  const repoDir = nodePath.join(sandbox, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  await runSnap(["init"], { cwd: repoDir });
  if (contributorId !== "") {
    await runSnap(["config", "contributor.id", contributorId], { cwd: repoDir });
  }
  return repoDir;
}

/** Write a regular file with text content. */
async function writeFile(path: string, content: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(path), { recursive: true });
  await fs.writeFile(path, content, "utf8");
}

/** Create a symlink (unsupported entry). */
async function makeSymlink(linkPath: string, target: string): Promise<void> {
  await fs.mkdir(nodePath.dirname(linkPath), { recursive: true });
  await fs.symlink(target, linkPath);
}

// ===========================================================================
// ADV-H-001: commit — empty message + unsupported entry
//   DEC-015 table says priority 3 (unsupported entry) > priority 9 (invalid message)
//   The implementation checks message FIRST (before scanning working tree),
//   so it returns errInvalidCommitMessage instead of errUnsupportedEntry.
//   SPEC ref: SPEC.md §7.5 (commit), DEC-015 §table row 3 vs 9
// ===========================================================================

void describe("ADV-H-001: commit — empty message + unsupported entry (DEC-015 precedence 3 > 9)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("empty message + symlink in worktree: DEC-015 requires errUnsupportedEntry (pri 3) not errInvalidCommitMessage (pri 9)", async () => {
    // Create a tracked file (dirty tree) AND an unsupported entry
    await writeFile(nodePath.join(repoDir, "file.txt"), "hello\n");
    await makeSymlink(nodePath.join(repoDir, "link"), "/tmp");

    const result = await runSnap(["commit", ""], { cwd: repoDir });

    // DEC-015: unsupported entry (priority 3) should fire before invalid message (priority 9)
    // EXPECTED per spec: errUnsupportedEntry fires
    // ACTUAL: errInvalidCommitMessage fires (implementation bug)
    assert.equal(result.code, 1);
    // This assertion documents the FAILING expected behavior per DEC-015:
    assert.match(
      result.stderr,
      /^snap: unsupported working tree entry: link\n$/,
      `DEC-015 priority 3 (unsupported) should fire before priority 9 (invalid message). Got: ${result.stderr}`,
    );

    // Clean up for follow-up tests
    await fs.unlink(nodePath.join(repoDir, "link")).catch(() => {});
  });

  void test("empty message + clean tree + no unsupported entry: errInvalidCommitMessage fires (PLAN.md §7.5 rule 5 confirmed)", async () => {
    // Commit the tracked file first to make tree clean
    const sandbox2 = await makeSandbox();
    const repo2 = await initRepo(sandbox2);
    await writeFile(nodePath.join(repo2, "f.txt"), "x\n");
    await runSnap(["commit", "initial"], { cwd: repo2 });

    // Now tree is clean — empty message should give errInvalidCommitMessage
    const result = await runSnap(["commit", ""], { cwd: repo2 });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "snap: invalid commit message\n");
    await rmSandbox(sandbox2);
  });
});

// ===========================================================================
// ADV-H-002: commit — empty message + clean tree (DEC-015 vs PLAN.md §7.5 rule 5)
//   DEC-015 table says priority 8 (clean tree) > priority 9 (invalid message),
//   meaning clean tree should be checked before invalid message.
//   BUT PLAN.md §7.5 rule 5 says "invalid message ▸ clean tree (25)" — message first.
//   Test 25 confirms: empty message on clean tree → errInvalidCommitMessage.
//   This means the DEC-015 table ordering for commit is wrong.
//   SPEC ref: SPEC.md §7.5, PLAN.md §7.5 rule 5, tests/25
// ===========================================================================

void describe("ADV-H-002: commit — message precedence over clean tree (DEC-015 table has wrong order for commit)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("empty message + clean tree → errInvalidCommitMessage (message checked before clean-tree check)", async () => {
    // Tree is clean (empty repo, nothing committed, nothing in worktree)
    const result = await runSnap(["commit", ""], { cwd: repoDir });
    assert.equal(result.code, 1);
    // PLAN.md §7.5 rule 5 confirms: invalid message fires before clean tree
    assert.equal(
      result.stderr,
      "snap: invalid commit message\n",
      "empty message should fire errInvalidCommitMessage even on a clean tree",
    );
    // NOT "snap: working tree is clean\n"
    assert.notEqual(result.stderr, "snap: working tree is clean\n");
  });

  void test("message with forbidden control char (\\x01) + clean tree → errInvalidCommitMessage", async () => {
    const result = await runSnap(["commit", "bad\x01msg"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "snap: invalid commit message\n",
      "message with forbidden control character fires before clean-tree check",
    );
  });

  void test("message > 4096 bytes + clean tree → errInvalidCommitMessage", async () => {
    const longMsg = "x".repeat(4097);
    const result = await runSnap(["commit", longMsg], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "snap: invalid commit message\n");
  });
});

// ===========================================================================
// ADV-H-003: revert — invalid/unknown version vs dirty tree (DEC-015 inverted)
//   DEC-015 table: priority 4 (dirty tree) > priority 5 (invalid version) > priority 6 (unknown version)
//   Implementation order in revert.ts: syntax check (step 3) → known check (step 4) → dirty check (step 6)
//   This means the implementation checks version BEFORE dirty tree, inverting DEC-015 priorities 4 vs 5,6.
//   SPEC ref: SPEC.md §7.7, DEC-015 table rows 4, 5, 6
// ===========================================================================

void describe("ADV-H-003: revert — version errors vs dirty tree (DEC-015 priority 4 dirty > 5 invalid-version > 6 unknown)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
    // Make one commit to have a version to revert to
    await writeFile(nodePath.join(repoDir, "f.txt"), "v1\n");
    await runSnap(["commit", "v1"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("revert with invalid version syntax + dirty tree → DEC-015 requires errWorkingTreeDirty (pri 4) not errInvalidVersion (pri 5)", async () => {
    // Make tree dirty
    await writeFile(nodePath.join(repoDir, "dirty.txt"), "dirty\n");

    const result = await runSnap(["revert", "(invalid@->01)"], { cwd: repoDir });

    assert.equal(result.code, 1);
    // DEC-015: dirty tree (priority 4) should fire before invalid version syntax (priority 5)
    // EXPECTED per spec: errWorkingTreeDirty
    // ACTUAL (implementation): errInvalidVersion — because code checks syntax before dirty
    assert.equal(
      result.stderr,
      "snap: working tree is dirty\n",
      `DEC-015 priority 4 (dirty) should fire before priority 5 (invalid version). Got: ${result.stderr}`,
    );

    await fs.unlink(nodePath.join(repoDir, "dirty.txt")).catch(() => {});
  });

  void test("revert with unknown version + dirty tree → DEC-015 requires errWorkingTreeDirty (pri 4) not errUnknownVersion (pri 6)", async () => {
    // Make tree dirty
    await writeFile(nodePath.join(repoDir, "dirty2.txt"), "dirty\n");

    const result = await runSnap(["revert", "(a@x->99)"], { cwd: repoDir });

    assert.equal(result.code, 1);
    // DEC-015: dirty tree (priority 4) should fire before unknown version (priority 6)
    // EXPECTED per spec: errWorkingTreeDirty
    // ACTUAL (implementation): errUnknownVersion
    assert.equal(
      result.stderr,
      "snap: working tree is dirty\n",
      `DEC-015 priority 4 (dirty) should fire before priority 6 (unknown version). Got: ${result.stderr}`,
    );

    await fs.unlink(nodePath.join(repoDir, "dirty2.txt")).catch(() => {});
  });

  void test("revert with invalid version + clean tree → errInvalidVersion (correct behavior)", async () => {
    const result = await runSnap(["revert", "(invalid@->01)"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^snap: invalid version: .+\n$/);
  });

  void test("revert with unknown version + clean tree → errUnknownVersion (correct behavior)", async () => {
    const result = await runSnap(["revert", "(a@x->99)"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "snap: unknown version: (a@x->99)\n");
  });
});

// ===========================================================================
// ADV-H-004: diff — old operand should be fully validated before new operand
//   DEC-015: "diff old operand before new"
//   Implementation: parses ALL version strings for syntax BEFORE checking if known.
//   Bug: diff (unknown-old) (bad-new-syntax) fires errInvalidVersion(new) not errUnknownVersion(old)
//   SPEC ref: SPEC.md §7.6, DEC-015 note "diff old operand before new"
// ===========================================================================

void describe("ADV-H-004: diff — old operand must be fully validated (syntax + known) before new operand", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
    // Commit one patch to have a valid version (a@x->1)
    await writeFile(nodePath.join(repoDir, "f.txt"), "v1\n");
    await runSnap(["commit", "v1"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("diff (unknown-but-valid-syntax old) (invalid-syntax new) → DEC-015 requires errUnknownVersion(old) first", async () => {
    // Old is syntactically valid but not in history; new is syntactically invalid
    const result = await runSnap(["diff", "(a@x->99)", "(bad->"], { cwd: repoDir });

    assert.equal(result.code, 1);
    // DEC-015: "diff old operand before new" — old should be fully checked (syntax + known)
    // before new is checked at all.
    // EXPECTED per DEC-015: errUnknownVersion("(a@x->99)") fires first
    // ACTUAL (implementation): errInvalidVersion("(bad->") fires — because code parses all
    // syntax first, then checks known status; syntax check for new fires before known check for old
    assert.equal(
      result.stderr,
      "snap: unknown version: (a@x->99)\n",
      `DEC-015 "old before new": errUnknownVersion(old) should fire before errInvalidVersion(new). Got: ${result.stderr}`,
    );
  });

  void test("diff (invalid-syntax old) (valid known new) → errInvalidVersion(old) fires (correct)", async () => {
    const result = await runSnap(["diff", "(bad->", "(a@x->1)"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^snap: invalid version: .+\n$/);
    assert.ok(result.stderr.includes("(bad->"));
  });

  void test("diff (valid known old) (invalid-syntax new) → errInvalidVersion(new) fires", async () => {
    const result = await runSnap(["diff", "(a@x->1)", "(bad->"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^snap: invalid version: .+\n$/);
    assert.ok(result.stderr.includes("(bad->"));
  });

  void test("diff (unknown old) (unknown new) → errUnknownVersion(old) fires first (correct, old < new)", async () => {
    const result = await runSnap(["diff", "(a@x->98)", "(a@x->99)"], { cwd: repoDir });
    assert.equal(result.code, 1);
    // Old is checked first per DEC-015
    assert.equal(result.stderr, "snap: unknown version: (a@x->98)\n");
  });
});

// ===========================================================================
// ADV-H-005: init — init at existing repo root vs init inside a repo subdir
//   SPEC §7.1: "Reinitializing a repository is an error."
//   SPEC §7.1: "Initializing a target inside an existing repository is an error."
//   These are two distinct errors: errRepositoryAlreadyExists vs errCannotInitializeInsideRepository
//   Tests verify correct discrimination.
//   SPEC ref: SPEC.md §7.1:460-463, DEC-017
// ===========================================================================

void describe("ADV-H-005: init — correct error discrimination for re-init vs nested-init", () => {
  let sandbox: string;
  before(async () => {
    sandbox = await makeSandbox();
  });
  after(async () => rmSandbox(sandbox));

  void test("init at existing repository root → errRepositoryAlreadyExists (not errCannotInitialize)", async () => {
    const repoDir = nodePath.join(sandbox, "repo-exists");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });

    // Re-init at the same root: should be errRepositoryAlreadyExists
    const result = await runSnap(["init"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes("repository already exists"),
      `expected 'repository already exists' but got: ${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes("cannot initialize inside repository"),
      `got wrong error: ${result.stderr}`,
    );
  });

  void test("init inside a repository (child subdir) → errCannotInitializeInsideRepository (not errRepositoryAlreadyExists)", async () => {
    const repoDir = nodePath.join(sandbox, "repo-parent");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });

    // Create a subdirectory inside the repo
    const childDir = nodePath.join(repoDir, "child");
    await fs.mkdir(childDir, { recursive: true });

    // init from inside the child dir
    const result = await runSnap(["init"], { cwd: childDir });
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes("cannot initialize inside repository"),
      `expected 'cannot initialize inside repository' but got: ${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes("repository already exists"),
      `got wrong error: ${result.stderr}`,
    );
  });

  void test("init a new path that IS inside an existing repo → errCannotInitializeInsideRepository", async () => {
    const repoDir = nodePath.join(sandbox, "repo-outer");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });

    // Try to init a nested path from outside
    const result = await runSnap(["init", "repo-outer/nested"], { cwd: sandbox });
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes("cannot initialize inside repository"),
      `expected 'cannot initialize inside repository' but got: ${result.stderr}`,
    );
  });

  void test("init . when already a repo root → errRepositoryAlreadyExists (same as re-init)", async () => {
    const repoDir = nodePath.join(sandbox, "repo-dot-test");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });

    // init . from the repo root
    const result = await runSnap(["init", "."], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.ok(
      result.stderr.includes("repository already exists"),
      `expected 'repository already exists' but got: ${result.stderr}`,
    );
  });
});

// ===========================================================================
// ADV-H-006: config — reading contributor.id when local config has invalid ID
//   PLAN.md §7.5 rule 9: "invalid local contributor.id must error rather than fall back to global"
//   No existing test covers: `snap config contributor.id` (read, no value) with invalid local config
//   SPEC ref: SPEC.md §8:669-680, PLAN.md §7.5 rule 9
// ===========================================================================

void describe("ADV-H-006: config — invalid local contributor.id errors without global fallback", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = nodePath.join(sandbox, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("snap config contributor.id (read) with invalid local ID + valid global → errInvalidContributorId (no fallback)", async () => {
    // Write invalid local config
    const localConfig = nodePath.join(repoDir, ".snap", "config.json");
    await writeFile(localConfig, JSON.stringify({ contributor: { id: "not-an-id" } }) + "\n");

    // Write valid global config
    const globalConfig = nodePath.join(sandbox, "home", ".snapconfig.json");
    await writeFile(
      globalConfig,
      JSON.stringify({ contributor: { id: "global@example.com" } }) + "\n",
    );

    // Read config: should fail on invalid local, NOT fall through to global
    const result = await runSnap(["config", "contributor.id"], {
      cwd: repoDir,
      env: { HOME: nodePath.join(sandbox, "home") },
    });

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^snap: invalid contributor id: .+\n$/,
      `expected errInvalidContributorId but got: ${result.stderr}`,
    );
    // Must NOT return the global config value
    assert.equal(result.stdout, "");
  });

  void test("snap config contributor.id (read) with valid local ID → returns local ID without reading global", async () => {
    const localConfig = nodePath.join(repoDir, ".snap", "config.json");
    await writeFile(
      localConfig,
      JSON.stringify({ contributor: { id: "local@example.com" } }) + "\n",
    );

    const result = await runSnap(["config", "contributor.id"], {
      cwd: repoDir,
      env: { HOME: "/nonexistent-home-should-not-matter" },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "local@example.com\n");
    assert.equal(result.stderr, "");
  });

  void test("snap config contributor.id (read) with no local config → falls through to global", async () => {
    // Remove local config
    const localConfig = nodePath.join(repoDir, ".snap", "config.json");
    await fs.unlink(localConfig).catch(() => {});

    const homeDir = nodePath.join(sandbox, "home-fallback");
    await fs.mkdir(homeDir, { recursive: true });
    const globalConfig = nodePath.join(homeDir, ".snapconfig.json");
    await writeFile(
      globalConfig,
      JSON.stringify({ contributor: { id: "fallback@example.com" } }) + "\n",
    );

    const result = await runSnap(["config", "contributor.id"], {
      cwd: repoDir,
      env: { HOME: homeDir },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "fallback@example.com\n");
  });
});

// ===========================================================================
// ADV-H-007: log — escape ordering (backslash before tab before LF)
//   SPEC §7.4: "backslash, tab, and LF are escaped as \\, \t, and \n in that order"
//   The ORDER matters: a literal backslash-t ("\\t") must become "\\\\t" not "\\t"
//   (escape backslash first, then tab).
//   SPEC ref: SPEC.md §7.4:488-492
// ===========================================================================

void describe("ADV-H-007: log — escape ordering must be backslash → tab → LF", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("message containing backslash-t literal (\\t): backslash must be escaped first → \\\\t in output", async () => {
    // Message is the 3-char string: backslash, t, newline → should appear as \\t\n in log
    await writeFile(nodePath.join(repoDir, "x.txt"), "hello\n");
    await runSnap(["commit", "back\\slash-tab\tnewline\n"], { cwd: repoDir });

    const logResult = await runSnap(["log"], { cwd: repoDir });
    assert.equal(logResult.code, 0);

    // The message "back\\slash-tab\tnewline\n" should appear as:
    // "back\\\\slash-tab\\tnewline\\n"
    // (backslash→\\, then tab→\t, then LF→\n)
    const lines = logResult.stdout.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const fields = lines[0]!.split("\t");
    assert.equal(fields.length, 3);
    const escapedMsg = fields[2]!;
    assert.equal(
      escapedMsg,
      "back\\\\slash-tab\\tnewline\\n",
      `log message escaping incorrect. Got: ${escapedMsg}`,
    );
  });

  void test("message with just a backslash → escaped as \\\\ (double backslash in output)", async () => {
    const sandbox2 = await makeSandbox();
    const repo2 = await initRepo(sandbox2);
    await writeFile(nodePath.join(repo2, "f.txt"), "data\n");
    await runSnap(["commit", "path\\file"], { cwd: repo2 });

    const logResult = await runSnap(["log"], { cwd: repo2 });
    assert.equal(logResult.code, 0);
    const lines = logResult.stdout.split("\n").filter((l) => l.length > 0);
    const fields = lines[0]!.split("\t");
    const msg = fields[2]!;
    assert.equal(msg, "path\\\\file", `backslash should be escaped to \\\\. Got: ${msg}`);
    await rmSandbox(sandbox2);
  });
});

// ===========================================================================
// ADV-H-008: revert — unsupported entry + dirty tree (DEC-015: unsupported > dirty)
//   DEC-015: priority 3 (unsupported) > priority 4 (dirty) for revert
//   No existing test covers revert with BOTH unsupported entries AND dirty tree simultaneously.
//   SPEC ref: SPEC.md §7.7, DEC-015 table rows 3, 4
// ===========================================================================

void describe("ADV-H-008: revert — unsupported entry fires before dirty tree (DEC-015 priority 3 > 4)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
    await writeFile(nodePath.join(repoDir, "f.txt"), "v1\n");
    await runSnap(["commit", "v1"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("revert with symlink (unsupported) + dirty file: errUnsupportedEntry fires before errWorkingTreeDirty", async () => {
    // Make tree dirty
    await writeFile(nodePath.join(repoDir, "dirty.txt"), "dirty\n");
    // Add an unsupported entry (symlink)
    await makeSymlink(nodePath.join(repoDir, "symlink"), "/tmp");

    const result = await runSnap(["revert", "()"], { cwd: repoDir });

    assert.equal(result.code, 1);
    // DEC-015: unsupported (priority 3) > dirty (priority 4)
    assert.equal(
      result.stderr,
      "snap: unsupported working tree entry: symlink\n",
      `DEC-015 priority 3 (unsupported) should fire before priority 4 (dirty). Got: ${result.stderr}`,
    );

    await fs.unlink(nodePath.join(repoDir, "symlink")).catch(() => {});
    await fs.unlink(nodePath.join(repoDir, "dirty.txt")).catch(() => {});
  });
});

// ===========================================================================
// ADV-H-009: diff single-arg → grammar rejects with errUsageDiff (not errInvalidVersion)
//   `snap diff <version>` (1 arg) is not a valid form per SPEC §7.6.
//   The grammar throws errUsageDiff (not errInvalidVersion) because the form is wrong.
//   This verifies the correct error family is used even for syntactically valid versions.
//   SPEC ref: SPEC.md §7.6:519-521, PLAN.md §7.5 rule 4
// ===========================================================================

void describe("ADV-H-009: diff with one version arg → errUsageDiff (grammar error not version error)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
    await writeFile(nodePath.join(repoDir, "f.txt"), "v1\n");
    await runSnap(["commit", "v1"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("diff (valid-known-version) with no second arg → errUsageDiff (not errUnknownVersion)", async () => {
    // (a@x->1) is a valid known version — but single-arg diff is not a valid form
    const result = await runSnap(["diff", "(a@x->1)"], { cwd: repoDir });
    assert.equal(result.code, 1);
    // Must be the diff usage error, NOT a version error
    assert.match(
      result.stderr,
      /^snap: usage: snap diff .+\n$/,
      `single-arg diff must give errUsageDiff. Got: ${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes("unknown version"),
      `must not give unknown version error. Got: ${result.stderr}`,
    );
  });

  void test("diff (invalid-syntax-version) with no second arg → errUsageDiff (grammar checked before version syntax)", async () => {
    // Grammar rejects single-arg diff before any version parsing occurs
    const result = await runSnap(["diff", "(bad->"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^snap: usage: snap diff .+\n$/,
      `single-arg diff must give errUsageDiff. Got: ${result.stderr}`,
    );
  });
});

// ===========================================================================
// ADV-H-010: merge — dirty tree check happens BEFORE loading remote
//   SPEC §7.8: "Requires a clean working tree"
//   DEC-015: priority 4 (dirty) before remote repository validation (priority 10)
//   No existing test verifies that an INVALID remote does NOT contaminate local repo
//   when local tree is dirty (local dirty error fires first).
//   SPEC ref: SPEC.md §7.8:573-578, DEC-015 table, SPEC.md §10:709-710
// ===========================================================================

void describe("ADV-H-010: merge — dirty tree fires before remote repo validation", () => {
  let sandbox: string;
  let localDir: string;
  let remoteDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    localDir = nodePath.join(sandbox, "local");
    remoteDir = nodePath.join(sandbox, "remote");
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    // Init local (no config needed for merge)
    await runSnap(["init"], { cwd: localDir });
    // Create an INVALID remote repository (corrupt JSON)
    await fs.mkdir(nodePath.join(remoteDir, ".snap"), { recursive: true });
    await writeFile(nodePath.join(remoteDir, ".snap", "repository.json"), "this is not valid json");
  });
  after(async () => rmSandbox(sandbox));

  void test("merge with dirty local + invalid remote → errWorkingTreeDirty (not a remote validation error)", async () => {
    // Make local tree dirty
    await writeFile(nodePath.join(localDir, "dirty.txt"), "dirty\n");

    const result = await runSnap(["merge", remoteDir], { cwd: localDir });

    assert.equal(result.code, 1);
    // DEC-015: dirty (priority 4) fires before repository validation (priority 10)
    assert.equal(
      result.stderr,
      "snap: working tree is dirty\n",
      `dirty tree should fire before remote validation. Got: ${result.stderr}`,
    );
    // Verify local repository was NOT mutated
    const localRepoJson = await fs.readFile(
      nodePath.join(localDir, ".snap", "repository.json"),
      "utf8",
    );
    const parsed = JSON.parse(localRepoJson) as { patches: unknown[] };
    assert.equal(parsed.patches.length, 0, "local repo must not be mutated when merge fails");
  });
});

// ===========================================================================
// ADV-H-011: grammar — snap add rejects despite being in grammar (out-of-scope command)
//   SPEC §12 explicitly excludes a staging area. The grammar file accepts "add"
//   but the add command implementation immediately throws errInvalidCommandOrArguments.
//   This tests that `snap add <anything>` exits 1 with the grammar error.
//   SPEC ref: SPEC.md §12:773 ("no branches, tags, staging area, partial commits")
// ===========================================================================

void describe("ADV-H-011: add command is not implemented (out-of-scope per SPEC §12)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("snap add <file> → errInvalidCommandOrArguments (staging area is out of scope)", async () => {
    await writeFile(nodePath.join(repoDir, "f.txt"), "hello\n");
    const result = await runSnap(["add", "f.txt"], { cwd: repoDir });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "snap: invalid command or arguments\n");
    assert.equal(result.stdout, "");
  });
});

// ===========================================================================
// ADV-H-012: commit — contributor.id missing fires AFTER unsupported + tree scan
//   DEC-015: priority 7 (missing contributor.id) > priority 3 (unsupported) would be wrong.
//   Actually DEC-015 says priority 3 (unsupported) BEFORE priority 7 (missing id).
//   commit.ts reads config BEFORE scanning worktree (steps 3-4 before step 6).
//   So if config read throws (e.g., missing id), it fires BEFORE unsupported entry check.
//   This is an ordering bug: missing contributor.id (7) fires before unsupported (3).
//   SPEC ref: DEC-015 table row 3 vs 7
// ===========================================================================

void describe("ADV-H-012: commit — missing contributor.id vs unsupported entry (DEC-015 priority 3 > 7)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    // Init WITHOUT setting contributor.id
    repoDir = nodePath.join(sandbox, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });
  });
  after(async () => rmSandbox(sandbox));

  void test("commit with symlink (unsupported) + no contributor.id → DEC-015 requires errUnsupportedEntry (pri 3) before errContributorIdRequired (pri 7)", async () => {
    // Create a dirty tracked file and an unsupported symlink
    await writeFile(nodePath.join(repoDir, "file.txt"), "content\n");
    await makeSymlink(nodePath.join(repoDir, "symlink"), "/tmp");

    const result = await runSnap(["commit", "valid message"], {
      cwd: repoDir,
      env: { HOME: "/nonexistent-home-no-global-config" },
    });

    assert.equal(result.code, 1);
    // DEC-015: unsupported entry (priority 3) must fire before missing contributor.id (priority 7)
    // EXPECTED per DEC-015: errUnsupportedEntry
    // ACTUAL (implementation): errContributorIdRequired — because config is read at step 3,
    // before worktree scan at step 6.
    assert.equal(
      result.stderr,
      "snap: unsupported working tree entry: symlink\n",
      `DEC-015 priority 3 (unsupported) should fire before priority 7 (missing id). Got: ${result.stderr}`,
    );

    await fs.unlink(nodePath.join(repoDir, "symlink")).catch(() => {});
  });
});

// ===========================================================================
// ADV-H-013: revert — contributor.id check is AFTER version validation but the
//   spec says unsupported entry fires before contributor check (DEC-015 priority 3 > 7)
//   No test covers: revert + unsupported entry + no contributor.id
//   The implementation checks unsupported (step 5) after version validity (steps 3-4)
//   but BEFORE contributor.id (step 7) — the relative ordering of 5 vs 7 is correct
//   per DEC-015 (3 > 7, where step 5 implements priority 3).
//   But there's no test confirming unsupported fires before missing-id on revert.
//   SPEC ref: DEC-015 table row 3 vs 7, SPEC.md §7.7
// ===========================================================================

void describe("ADV-H-013: revert — unsupported entry fires before missing contributor.id (DEC-015 priority 3 > 7)", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    // Init WITHOUT contributor.id
    repoDir = nodePath.join(sandbox, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await runSnap(["init"], { cwd: repoDir });
    // Set contributor.id temporarily to make a commit
    await runSnap(["config", "contributor.id", "a@x"], { cwd: repoDir });
    await writeFile(nodePath.join(repoDir, "f.txt"), "v1\n");
    await runSnap(["commit", "v1"], { cwd: repoDir });
    // Remove the local config (to simulate no contributor.id)
    await fs.unlink(nodePath.join(repoDir, ".snap", "config.json")).catch(() => {});
  });
  after(async () => rmSandbox(sandbox));

  void test("revert with symlink (unsupported) + no contributor.id → errUnsupportedEntry fires first (DEC-015 3 > 7)", async () => {
    // Tree is clean (only the committed file)
    // Add unsupported entry
    await makeSymlink(nodePath.join(repoDir, "link"), "/tmp");

    const result = await runSnap(["revert", "()"], {
      cwd: repoDir,
      env: { HOME: "/nonexistent-home-no-global-config" },
    });

    assert.equal(result.code, 1);
    // DEC-015: unsupported (priority 3) > missing id (priority 7)
    // The implementation checks unsupported (step 5) before contributor.id (step 7) — this should be CORRECT
    assert.equal(
      result.stderr,
      "snap: unsupported working tree entry: link\n",
      `DEC-015 priority 3 (unsupported) should fire before priority 7 (missing contributor.id). Got: ${result.stderr}`,
    );

    await fs.unlink(nodePath.join(repoDir, "link")).catch(() => {});
  });
});

// ===========================================================================
// ADV-H-014: diff working-tree — unsupported entry fires correctly
//   No test covers the case: snap diff (no args / working tree diff) with a symlink.
//   The diff command in working-tree mode scans the worktree and must report unsupported entries.
//   SPEC ref: SPEC.md §7.6:517-518, SPEC.md §10:712-713
// ===========================================================================

void describe("ADV-H-014: diff (working-tree mode) with unsupported entry → errUnsupportedEntry", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("snap diff (no args) with symlink in working tree → errUnsupportedEntry exit 1", async () => {
    await makeSymlink(nodePath.join(repoDir, "bad-symlink"), "/tmp");

    const result = await runSnap(["diff"], { cwd: repoDir });

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "snap: unsupported working tree entry: bad-symlink\n");
    assert.equal(result.stdout, "");

    await fs.unlink(nodePath.join(repoDir, "bad-symlink")).catch(() => {});
  });
});

// ===========================================================================
// ADV-H-015: status — clean repo prints only version line (no trailing changes)
//   SPEC §7.3: "A clean repository prints only the version line."
//   Verify that an empty working tree with some committed content outputs exactly the version line.
//   Also verify paths sort by UTF-8 byte order (not JS string order).
//   SPEC ref: SPEC.md §7.3:475-483
// ===========================================================================

void describe("ADV-H-015: status — clean repo prints only version line; paths in UTF-8 byte order", () => {
  let sandbox: string;
  let repoDir: string;
  before(async () => {
    sandbox = await makeSandbox();
    repoDir = await initRepo(sandbox);
  });
  after(async () => rmSandbox(sandbox));

  void test("clean repo after commit → only version line on stdout", async () => {
    await writeFile(nodePath.join(repoDir, "f.txt"), "hello\n");
    await runSnap(["commit", "first"], { cwd: repoDir });

    const result = await runSnap(["status"], { cwd: repoDir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "version (a@x->1)\n");
    assert.equal(result.stderr, "");
  });

  void test("paths in status sort by unsigned UTF-8 byte order, not JS localeCompare", async () => {
    // 'z' (0x7A) sorts before 'é' (0xC3 0xA9) in UTF-8 byte order
    // but 'é' > 'z' in JS string/locale order
    await writeFile(nodePath.join(repoDir, "z.txt"), "z\n");
    await writeFile(nodePath.join(repoDir, "é.txt"), "e-accent\n");

    const result = await runSnap(["status"], { cwd: repoDir });
    assert.equal(result.code, 0);

    const lines = result.stdout.split("\n").filter((l) => l.length > 0);
    // version line is first
    assert.ok(lines[0]!.startsWith("version"));
    // Then changes in UTF-8 byte order: z.txt (0x7A) before é.txt (0xC3...)
    const changePaths = lines.slice(1).map((l) => l.slice(2)); // remove "A "
    const zIdx = changePaths.indexOf("z.txt");
    const eIdx = changePaths.indexOf("é.txt");
    assert.ok(zIdx !== -1, "z.txt should appear in status");
    assert.ok(eIdx !== -1, "é.txt should appear in status");
    assert.ok(
      zIdx < eIdx,
      `z.txt (UTF-8: 0x7A) should sort before é.txt (UTF-8: 0xC3 0xA9). Got order: ${changePaths.join(", ")}`,
    );
  });
});
