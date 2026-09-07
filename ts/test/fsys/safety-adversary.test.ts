// Safety Adversary — Phase 4 adversarial review of FS Builder E
//
// Spec refs used throughout:
//   SPEC.md §2       — directories are implicit; working-tree rules
//   SPEC.md §6.2     — installation removes files blocking required dirs,
//                      creates required dirs, writes target files, removes
//                      newly empty dirs
//   SPEC.md §10      — atomic same-dir temp replace; no leftover temp files
//   PLAN.md §7.5 rule 3  — no leftover temp file after success OR failure
//   PLAN.md §7.5 rule 13 — init creates missing parent directories recursively

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

import { materialize } from "../../src/fsys/materialize.js";
import { assertOk } from "../helpers/result.js";
import { findRepository } from "../../src/repo/store.js";
import { readConfig } from "../../src/repo/config.js";
import { treeFromEntries } from "../../src/core/tree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), "snap-safety-adversary-"));
}

/** Enumerate every path under `dir`, recursively. Returns relative paths with
 *  `/` separators.  Directories are suffixed with `/`. */
async function lsAll(dir: string, base: string = dir): Promise<string[]> {
  const results: string[] = [];
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const d of dirents) {
    const abs = nodePath.join(dir, d.name);
    const rel = nodePath.relative(base, abs).split(nodePath.sep).join("/");
    if (d.isDirectory()) {
      results.push(rel + "/");
      const children = await lsAll(abs, base);
      results.push(...children);
    } else {
      results.push(rel);
    }
  }
  return results;
}

/** Return all paths matching a predicate glob prefix. */
function matchingPaths(all: string[], prefix: string): string[] {
  return all.filter((p) => p.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// 1. File → Directory transition
//    SPEC.md §6.2: "Installation removes files that block required directories"
// ---------------------------------------------------------------------------

void describe("materialize — file→directory transition (adversarial)", () => {
  void it("ADV-1a: a single file at 'a' is removed and 'a/' created when tree has 'a/b'", async () => {
    // SPEC.md §6.2 line 370: "removes files that block required directories"
    const workDir = await makeTempDir();
    try {
      // Pre-condition: "a" is a plain file
      await fs.writeFile(nodePath.join(workDir, "a"), "I am a file\n");

      // Target tree has "a/b" — so "a" must become a directory
      const tree = treeFromEntries([["a/b", Buffer.from("child content\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const aStat = await fs.stat(nodePath.join(workDir, "a"));
      assert.ok(aStat.isDirectory(), "ADV-1a: 'a' must be a directory after materialize");

      const bContent = await fs.readFile(nodePath.join(workDir, "a/b"), "utf8");
      assert.strictEqual(bContent, "child content\n", "ADV-1a: 'a/b' must have correct content");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-1b: deeply nested file→directory: 'a/b' file replaced when tree has 'a/b/c/d'", async () => {
    // SPEC.md §6.2 line 370, PLAN.md §7.5 rule 13 line 311
    const workDir = await makeTempDir();
    try {
      // Pre-condition: "a/b" is a file
      await fs.mkdir(nodePath.join(workDir, "a"), { recursive: true });
      await fs.writeFile(nodePath.join(workDir, "a/b"), "I am also a file\n");

      // Target tree has "a/b/c/d" — so "a/b" must become a directory
      const tree = treeFromEntries([["a/b/c/d", Buffer.from("deep\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const bStat = await fs.stat(nodePath.join(workDir, "a/b"));
      assert.ok(bStat.isDirectory(), "ADV-1b: 'a/b' must be a directory now");

      const dContent = await fs.readFile(nodePath.join(workDir, "a/b/c/d"), "utf8");
      assert.strictEqual(dContent, "deep\n", "ADV-1b: deep path must have correct content");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-1c: multiple siblings — one path transitions file→dir, another remains a file", async () => {
    // SPEC.md §6.2: changes to unrelated paths commute
    const workDir = await makeTempDir();
    try {
      // "x" is a file; "y" is also a file
      await fs.writeFile(nodePath.join(workDir, "x"), "x file\n");
      await fs.writeFile(nodePath.join(workDir, "y"), "y file\n");

      // New tree: "x/child" (x becomes dir), "y" stays a file with new content
      const tree = treeFromEntries([
        ["x/child", Buffer.from("x child\n", "utf8")],
        ["y", Buffer.from("y updated\n", "utf8")],
      ]);
      assertOk(await materialize(workDir, tree));

      const xStat = await fs.stat(nodePath.join(workDir, "x"));
      assert.ok(xStat.isDirectory(), "ADV-1c: 'x' must be a directory");

      const xChild = await fs.readFile(nodePath.join(workDir, "x/child"), "utf8");
      assert.strictEqual(xChild, "x child\n", "ADV-1c: 'x/child' must have correct content");

      const yStat = await fs.stat(nodePath.join(workDir, "y"));
      assert.ok(yStat.isFile(), "ADV-1c: 'y' must remain a regular file");

      const yContent = await fs.readFile(nodePath.join(workDir, "y"), "utf8");
      assert.strictEqual(yContent, "y updated\n", "ADV-1c: 'y' must have updated content");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Directory → File transition (adversarial variants)
//    SPEC.md §6.2 line 370: "removes files that block required directories,
//    creates required directories, writes target files, removes newly empty
//    directories"
// ---------------------------------------------------------------------------

void describe("materialize — directory→file transition (adversarial)", () => {
  void it("ADV-2a: directory with multiple children replaced by file at that path", async () => {
    // SPEC.md §2 line 74: prefix-free by path segment — if 'foo' is a file,
    // no 'foo/...' path is present
    const workDir = await makeTempDir();
    try {
      // Pre-condition: "foo/" with three children
      await fs.mkdir(nodePath.join(workDir, "foo"), { recursive: true });
      await fs.writeFile(nodePath.join(workDir, "foo/a.txt"), "a\n");
      await fs.writeFile(nodePath.join(workDir, "foo/b.txt"), "b\n");
      await fs.writeFile(nodePath.join(workDir, "foo/c.txt"), "c\n");

      // New tree: "foo" is a file — entire directory must be removed
      const tree = treeFromEntries([["foo", Buffer.from("I replaced the dir\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const fooStat = await fs.stat(nodePath.join(workDir, "foo"));
      assert.ok(fooStat.isFile(), "ADV-2a: 'foo' must now be a file");

      const content = await fs.readFile(nodePath.join(workDir, "foo"), "utf8");
      assert.strictEqual(content, "I replaced the dir\n", "ADV-2a: correct file content");

      // Children must be gone
      for (const child of ["a.txt", "b.txt", "c.txt"]) {
        let threw = false;
        try {
          await fs.stat(nodePath.join(workDir, "foo", child));
        } catch {
          threw = true;
        }
        assert.ok(threw, `ADV-2a: 'foo/${child}' must not exist after transition`);
      }
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-2b: deep directory→file: 'a/b/' directory replaced by 'a/b' file", async () => {
    // SPEC.md §6.2 line 370
    const workDir = await makeTempDir();
    try {
      // "a/b/deep.txt" exists
      await fs.mkdir(nodePath.join(workDir, "a/b"), { recursive: true });
      await fs.writeFile(nodePath.join(workDir, "a/b/deep.txt"), "deep\n");

      // New tree: "a/b" is a file
      const tree = treeFromEntries([["a/b", Buffer.from("replaced\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const abStat = await fs.stat(nodePath.join(workDir, "a/b"));
      assert.ok(abStat.isFile(), "ADV-2b: 'a/b' must be a file now");

      const content = await fs.readFile(nodePath.join(workDir, "a/b"), "utf8");
      assert.strictEqual(content, "replaced\n", "ADV-2b: correct content");

      // "a/b/deep.txt" must not exist
      let threw = false;
      try {
        await fs.stat(nodePath.join(workDir, "a/b/deep.txt"));
      } catch {
        threw = true;
      }
      assert.ok(threw, "ADV-2b: 'a/b/deep.txt' must be removed");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-2c: dir→file transition removes all descendant content (no orphaned dirs)", async () => {
    // SPEC.md §2 line 73: "empty directories are not tracked"
    // After replacing dir with file, no remnant directories should exist
    const workDir = await makeTempDir();
    try {
      // "parent/child/grandchild/file.txt" — nested structure
      await fs.mkdir(nodePath.join(workDir, "parent/child/grandchild"), { recursive: true });
      await fs.writeFile(
        nodePath.join(workDir, "parent/child/grandchild/file.txt"),
        "deeply nested\n",
      );

      // New tree: "parent" is a file
      const tree = treeFromEntries([["parent", Buffer.from("flat file\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const parentStat = await fs.stat(nodePath.join(workDir, "parent"));
      assert.ok(parentStat.isFile(), "ADV-2c: 'parent' must be a file");

      // No subdirectories under parent should remain
      const all = await lsAll(workDir);
      const orphaned = all.filter((p) => p.startsWith("parent/"));
      assert.deepEqual(
        orphaned,
        [],
        `ADV-2c: no orphaned entries under 'parent/', found: ${orphaned.join(", ")}`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. No leftover temp files after failure
//    SPEC.md §10 line 714: "Snap reports the failure; the user may repair"
//    PLAN.md §7.5 rule 3 line 283: "No leftover temp file after success or failure"
// ---------------------------------------------------------------------------

void describe("materialize — no leftover temp files after failure (adversarial)", () => {
  void it("ADV-3a: no .snap-tmp-* files left in workDir when a write fails", async () => {
    // PLAN.md §7.5 rule 3 (line 283): tree_equals enumerates .snap/ exhaustively
    // We simulate failure by making the destination directory read-only.
    // On macOS/Linux, chmod 0o555 on a directory prevents file creation in it.
    const workDir = await makeTempDir();
    const subDir = nodePath.join(workDir, "ro-dir");
    try {
      await fs.mkdir(subDir);

      // Make subDir read-only so writes into it fail
      await fs.chmod(subDir, 0o555);

      // Try to materialize a file inside the read-only directory
      const tree = treeFromEntries([["ro-dir/blocked.txt", Buffer.from("cannot write\n", "utf8")]]);

      let threw = false;
      try {
        assertOk(await materialize(workDir, tree));
      } catch {
        threw = true;
      }

      // Whether it threw or not, there must be no leftover temp files anywhere
      // (including in subDir if somehow a temp was created before the failure)
      const all = await lsAll(workDir);
      const tempFiles = matchingPaths(all, ".snap-tmp-");
      assert.deepEqual(
        tempFiles,
        [],
        `ADV-3a: no leftover temp files after write failure, found: ${tempFiles.join(", ")}`,
      );

      // The operation should have thrown because we can't write into a read-only dir
      assert.ok(threw, "ADV-3a: materialize should throw when write fails due to permissions");
    } finally {
      // Restore permissions before cleanup
      try {
        await fs.chmod(subDir, 0o755);
      } catch {
        // ignore
      }
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-3b: no .snap-tmp-* files left after write into a non-existent deep path fails", async () => {
    // PLAN.md §7.5 rule 3 (line 283)
    // Simulate partial failure: workDir itself is read-only
    const workDir = await makeTempDir();
    try {
      await fs.chmod(workDir, 0o555);

      const tree = treeFromEntries([["cannotcreate.txt", Buffer.from("fail\n", "utf8")]]);

      let threw = false;
      try {
        assertOk(await materialize(workDir, tree));
      } catch {
        threw = true;
      }

      // Restore permissions to allow lsAll to work
      await fs.chmod(workDir, 0o755);

      const all = await lsAll(workDir);
      const tempFiles = matchingPaths(all, ".snap-tmp-");
      assert.deepEqual(
        tempFiles,
        [],
        `ADV-3b: no leftover temp files after permission failure, found: ${tempFiles.join(", ")}`,
      );

      assert.ok(threw, "ADV-3b: materialize must throw when workDir is not writable");
    } finally {
      try {
        await fs.chmod(workDir, 0o755);
      } catch {
        // ignore
      }
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-3c: no .snap-tmp-* files after successful multi-file materialize", async () => {
    // PLAN.md §7.5 rule 3 (line 283): success case must also be clean
    const workDir = await makeTempDir();
    try {
      // Write many files so the probability of a left-behind temp is higher
      const entries: [string, Buffer][] = [];
      for (let i = 0; i < 20; i++) {
        entries.push([`file-${i}.txt`, Buffer.from(`content-${i}\n`, "utf8")]);
        entries.push([`sub/nested-${i}.txt`, Buffer.from(`nested-${i}\n`, "utf8")]);
      }
      const tree = treeFromEntries(entries);
      assertOk(await materialize(workDir, tree));

      const all = await lsAll(workDir);
      const tempFiles = matchingPaths(all, ".snap-tmp-");
      assert.deepEqual(
        tempFiles,
        [],
        `ADV-3c: no leftover temp files after 40-file materialize, found: ${tempFiles.join(", ")}`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. findRepository walks up correctly from a deep subdirectory
//    SPEC.md §7 line 443: "locates the nearest repository by walking from
//    the current directory to the filesystem root"
// ---------------------------------------------------------------------------

void describe("findRepository — deep subdirectory walk (adversarial)", () => {
  void it("ADV-4a: finds .snap/ at root when called from a/b/c/d/", async () => {
    // SPEC.md §7 line 443
    const workDir = await makeTempDir();
    try {
      // Create .snap/repository.json at workDir root
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      await fs.writeFile(
        nodePath.join(snapDir, "repository.json"),
        '{"format":1,"frontier":[],"patches":[]}\n',
      );

      // Create a deep subdirectory
      const deepDir = nodePath.join(workDir, "a", "b", "c", "d");
      await fs.mkdir(deepDir, { recursive: true });

      const found = findRepository(deepDir);
      assert.strictEqual(
        found,
        workDir,
        `ADV-4a: findRepository from a/b/c/d/ should return the root '${workDir}', got '${found}'`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-4b: returns null when no .snap/ exists anywhere up the tree", async () => {
    // SPEC.md §7.1 line 460 (init); implied: walk terminates at root
    const workDir = await makeTempDir();
    try {
      const deep = nodePath.join(workDir, "x", "y", "z");
      await fs.mkdir(deep, { recursive: true });

      const found = findRepository(deep);
      assert.strictEqual(found, null, "ADV-4b: should return null when no repository exists");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-4c: finds nearest (innermost) repository — not the outer one", async () => {
    // SPEC.md §7 line 443: "nearest repository"
    const workDir = await makeTempDir();
    try {
      // Outer repo at workDir
      const outerSnap = nodePath.join(workDir, ".snap");
      await fs.mkdir(outerSnap, { recursive: true });
      await fs.writeFile(
        nodePath.join(outerSnap, "repository.json"),
        '{"format":1,"frontier":[],"patches":[]}\n',
      );

      // Inner repo at workDir/inner
      const innerDir = nodePath.join(workDir, "inner");
      const innerSnap = nodePath.join(innerDir, ".snap");
      await fs.mkdir(innerSnap, { recursive: true });
      await fs.writeFile(
        nodePath.join(innerSnap, "repository.json"),
        '{"format":1,"frontier":[],"patches":[]}\n',
      );

      // Call from inside inner repo
      const found = findRepository(innerDir);
      assert.strictEqual(
        found,
        innerDir,
        `ADV-4c: should find inner repo '${innerDir}', not outer '${workDir}'`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. readConfig — edge cases
//    SPEC.md §8 line 668: local-over-global configuration
//    PLAN.md §7.5 rule 9 line 301: snap config must not validate pre-existing
//    malformed local config; invalid local id errors without falling through
// ---------------------------------------------------------------------------

void describe("readConfig — edge cases (adversarial)", () => {
  void it("ADV-5a: HOME not set → returns empty config (no error)", async () => {
    // SPEC.md §8 line 672: "If $HOME is absent, global configuration is unavailable"
    const workDir = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      // No local config file

      delete process.env["HOME"];

      const cfg = assertOk(await readConfig(workDir));
      assert.strictEqual(
        cfg.contributorId,
        undefined,
        "ADV-5a: no id when HOME is absent and no local config",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-5b: HOME points to nonexistent path → returns empty config (no error)", async () => {
    // SPEC.md §8 line 669: "A missing file means no value"
    const workDir = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      // No local config file

      process.env["HOME"] = "/nonexistent-path-that-does-not-exist-12345";

      const cfg = assertOk(await readConfig(workDir));
      assert.strictEqual(
        cfg.contributorId,
        undefined,
        "ADV-5b: no id when HOME path is nonexistent and no local config",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-5c: local config absent, global present → returns global id", async () => {
    // SPEC.md §8 line 668: "Otherwise it reads $HOME/.snapconfig.json"
    const workDir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      // No local config

      await fs.writeFile(
        nodePath.join(fakeHome, ".snapconfig.json"),
        '{"contributor":{"id":"global@example.com"}}\n',
      );

      process.env["HOME"] = fakeHome;

      const cfg = assertOk(await readConfig(workDir));
      assert.strictEqual(
        cfg.contributorId,
        "global@example.com",
        "ADV-5c: should return global contributor id",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  void it("ADV-5d: local config with valid id → returns local id, does NOT read global", async () => {
    // SPEC.md §8 line 668: "If it provides an ID, Snap does not read global config"
    const workDir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      await fs.writeFile(
        nodePath.join(snapDir, "config.json"),
        '{"contributor":{"id":"local@example.com"}}\n',
      );

      // Global config has different id — should NOT be read
      await fs.writeFile(
        nodePath.join(fakeHome, ".snapconfig.json"),
        '{"contributor":{"id":"global@example.com"}}\n',
      );

      process.env["HOME"] = fakeHome;

      const cfg = assertOk(await readConfig(workDir));
      assert.strictEqual(
        cfg.contributorId,
        "local@example.com",
        "ADV-5d: local id must take precedence over global",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  void it("ADV-5e: local config with no id → falls through to global", async () => {
    // SPEC.md §8 line 668: "Otherwise it reads $HOME/.snapconfig.json"
    const workDir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      // Local config exists but has no contributor.id
      await fs.writeFile(nodePath.join(snapDir, "config.json"), '{"other":"field"}\n');

      await fs.writeFile(
        nodePath.join(fakeHome, ".snapconfig.json"),
        '{"contributor":{"id":"global@example.com"}}\n',
      );

      process.env["HOME"] = fakeHome;

      const cfg = assertOk(await readConfig(workDir));
      assert.strictEqual(
        cfg.contributorId,
        "global@example.com",
        "ADV-5e: should fall through to global when local has no id",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });

  void it("ADV-5f: local config with invalid id → errors, does NOT fall through to global", async () => {
    // PLAN.md §7.5 rule 9 line 301: "an invalid local contributor.id must error
    // rather than fall back to global"
    // SPEC.md §8 line 669: "a malformed file ... is an error"
    const workDir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const savedHome = process.env["HOME"];
    try {
      const snapDir = nodePath.join(workDir, ".snap");
      await fs.mkdir(snapDir, { recursive: true });
      // Invalid id: no @
      await fs.writeFile(
        nodePath.join(snapDir, "config.json"),
        '{"contributor":{"id":"not-an-email"}}\n',
      );

      // Global config has valid id
      await fs.writeFile(
        nodePath.join(fakeHome, ".snapconfig.json"),
        '{"contributor":{"id":"global@example.com"}}\n',
      );

      process.env["HOME"] = fakeHome;

      const cfg = await readConfig(workDir);

      assert.ok(
        !cfg.ok,
        "ADV-5f: invalid local id must produce an error, not fall through to global",
      );
    } finally {
      if (savedHome !== undefined) process.env["HOME"] = savedHome;
      else delete process.env["HOME"];
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.rm(fakeHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. PLAN.md §7.5 rule 13: init creates missing parent directories recursively
//    Verified via materialize deep-path creation (the mechanism used by init)
//    PLAN.md §7.5 rule 13 line 311: "init creates missing parent directories
//    recursively and detects an ancestor repository"
// ---------------------------------------------------------------------------

void describe("materialize — deep parent directory creation (PLAN.md §7.5 rule 13)", () => {
  void it("ADV-6a: creates a 5-level deep path from scratch", async () => {
    // PLAN.md §7.5 rule 13 line 311
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([["a/b/c/d/e/file.txt", Buffer.from("very deep\n", "utf8")]]);
      assertOk(await materialize(workDir, tree));

      const content = await fs.readFile(nodePath.join(workDir, "a/b/c/d/e/file.txt"), "utf8");
      assert.strictEqual(content, "very deep\n", "ADV-6a: deep file must have correct content");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-6b: creates sibling deep paths that share common ancestors", async () => {
    // PLAN.md §7.5 rule 13 line 311; SPEC.md §6.2 line 370
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([
        ["a/b/x.txt", Buffer.from("x\n", "utf8")],
        ["a/b/y.txt", Buffer.from("y\n", "utf8")],
        ["a/c/z.txt", Buffer.from("z\n", "utf8")],
      ]);
      assertOk(await materialize(workDir, tree));

      assert.strictEqual(await fs.readFile(nodePath.join(workDir, "a/b/x.txt"), "utf8"), "x\n");
      assert.strictEqual(await fs.readFile(nodePath.join(workDir, "a/b/y.txt"), "utf8"), "y\n");
      assert.strictEqual(await fs.readFile(nodePath.join(workDir, "a/c/z.txt"), "utf8"), "z\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("ADV-6c: no orphaned empty directories after deep subtree is removed", async () => {
    // SPEC.md §2 line 63: "empty directories are not tracked"
    // SPEC.md §6.2 line 370: "removes newly empty directories"
    const workDir = await makeTempDir();
    try {
      // Start with a deep tree
      const tree1 = treeFromEntries([
        ["a/b/c/file1.txt", Buffer.from("f1\n", "utf8")],
        ["a/b/c/file2.txt", Buffer.from("f2\n", "utf8")],
        ["keep.txt", Buffer.from("keep\n", "utf8")],
      ]);
      assertOk(await materialize(workDir, tree1));

      // Now materialize to a tree that only has keep.txt
      const tree2 = treeFromEntries([["keep.txt", Buffer.from("keep\n", "utf8")]]);
      assertOk(await materialize(workDir, tree2));

      const all = await lsAll(workDir);
      // Only keep.txt should remain (no empty dirs a/, a/b/, a/b/c/)
      const remaining = all.filter((p) => !p.startsWith(".snap"));
      assert.deepEqual(
        remaining,
        ["keep.txt"],
        `ADV-6c: only keep.txt should remain, got: ${remaining.join(", ")}`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});
