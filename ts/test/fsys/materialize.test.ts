// Tests for fsys/materialize.ts
// Covers: basic creation, update, deletion, dir↔file transitions, no leftover temp files

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

import { materialize } from "../../src/fsys/materialize.js";
import { emptyTree, treeFromEntries } from "../../src/core/tree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), "snap-materialize-test-"));
}

async function readFileIfExists(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

async function statIfExists(p: string): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

async function lsAll(dir: string, base: string = dir): Promise<string[]> {
  const results: string[] = [];
  const dirents = await fs.readdir(dir, { withFileTypes: true });
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

void describe("materialize — basic file creation", () => {
  void it("creates files in an empty working directory", async () => {
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([
        ["hello.txt", Buffer.from("hello\n", "utf8")],
        ["world.txt", Buffer.from("world\n", "utf8")],
      ]);
      await materialize(workDir, tree);

      const hello = await fs.readFile(nodePath.join(workDir, "hello.txt"), "utf8");
      const world = await fs.readFile(nodePath.join(workDir, "world.txt"), "utf8");
      assert.strictEqual(hello, "hello\n");
      assert.strictEqual(world, "world\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("creates nested files with parent directories", async () => {
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([
        ["a/b/c.txt", Buffer.from("deep\n", "utf8")],
        ["a/d.txt", Buffer.from("sibling\n", "utf8")],
      ]);
      await materialize(workDir, tree);

      const deep = await fs.readFile(nodePath.join(workDir, "a/b/c.txt"), "utf8");
      const sibling = await fs.readFile(nodePath.join(workDir, "a/d.txt"), "utf8");
      assert.strictEqual(deep, "deep\n");
      assert.strictEqual(sibling, "sibling\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("materializes the empty tree (clears all files except .snap/)", async () => {
    const workDir = await makeTempDir();
    try {
      // Create some existing files
      await fs.writeFile(nodePath.join(workDir, "old.txt"), "old\n");
      await fs.mkdir(nodePath.join(workDir, ".snap"), { recursive: true });
      await fs.writeFile(
        nodePath.join(workDir, ".snap/repository.json"),
        '{"format":1,"frontier":[],"patches":[]}\n',
      );

      await materialize(workDir, emptyTree());

      // old.txt should be removed
      const oldStat = await statIfExists(nodePath.join(workDir, "old.txt"));
      assert.strictEqual(oldStat, null, "old.txt should be removed");

      // .snap/ should be untouched
      const snapStat = await statIfExists(nodePath.join(workDir, ".snap/repository.json"));
      assert.ok(snapStat !== null, ".snap/repository.json should still exist");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — file update (changed bytes)", () => {
  void it("overwrites an existing file with new bytes", async () => {
    const workDir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(workDir, "f.txt"), "old content\n");

      const tree = treeFromEntries([["f.txt", Buffer.from("new content\n", "utf8")]]);
      await materialize(workDir, tree);

      const content = await fs.readFile(nodePath.join(workDir, "f.txt"), "utf8");
      assert.strictEqual(content, "new content\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — file deletion", () => {
  void it("removes files present in old state but absent in new tree", async () => {
    const workDir = await makeTempDir();
    try {
      // Pre-populate two files
      await fs.writeFile(nodePath.join(workDir, "keep.txt"), "keep\n");
      await fs.writeFile(nodePath.join(workDir, "remove.txt"), "remove\n");

      // New tree only has keep.txt
      const tree = treeFromEntries([["keep.txt", Buffer.from("keep\n", "utf8")]]);
      await materialize(workDir, tree);

      const keepBuf = await readFileIfExists(nodePath.join(workDir, "keep.txt"));
      assert.ok(keepBuf !== null, "keep.txt should still exist");
      assert.strictEqual(keepBuf.toString("utf8"), "keep\n");

      const removeBuf = await readFileIfExists(nodePath.join(workDir, "remove.txt"));
      assert.strictEqual(removeBuf, null, "remove.txt should be deleted");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("removes entire subtree when directory no longer contains tracked files", async () => {
    const workDir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(workDir, "subdir"), { recursive: true });
      await fs.writeFile(nodePath.join(workDir, "subdir/file.txt"), "data\n");

      // Materialize empty tree (no files at all)
      await materialize(workDir, emptyTree());

      const subdirStat = await statIfExists(nodePath.join(workDir, "subdir"));
      assert.strictEqual(subdirStat, null, "subdir should be removed when empty");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — directory→file transition", () => {
  void it("replaces a directory with a file when tree has file at that path", async () => {
    const workDir = await makeTempDir();
    try {
      // Create a directory at path "foo"
      await fs.mkdir(nodePath.join(workDir, "foo"), { recursive: true });
      await fs.writeFile(nodePath.join(workDir, "foo/child.txt"), "child\n");

      // New tree has "foo" as a file (not a directory)
      const tree = treeFromEntries([["foo", Buffer.from("I am a file\n", "utf8")]]);
      await materialize(workDir, tree);

      const stat = await fs.stat(nodePath.join(workDir, "foo"));
      assert.ok(stat.isFile(), "foo should be a file now, not a directory");

      const content = await fs.readFile(nodePath.join(workDir, "foo"), "utf8");
      assert.strictEqual(content, "I am a file\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — file→directory transition", () => {
  void it("replaces a file with a directory when tree has child paths under that name", async () => {
    const workDir = await makeTempDir();
    try {
      // Create "bar" as a file
      await fs.writeFile(nodePath.join(workDir, "bar"), "old file\n");

      // New tree has "bar/child" (so "bar" must become a directory)
      const tree = treeFromEntries([["bar/child", Buffer.from("nested\n", "utf8")]]);
      await materialize(workDir, tree);

      const barStat = await fs.stat(nodePath.join(workDir, "bar"));
      assert.ok(barStat.isDirectory(), "bar should now be a directory");

      const childContent = await fs.readFile(nodePath.join(workDir, "bar/child"), "utf8");
      assert.strictEqual(childContent, "nested\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — .snap/ is never touched", () => {
  void it("does not remove .snap/ or its contents", async () => {
    const workDir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(workDir, ".snap"), { recursive: true });
      await fs.writeFile(
        nodePath.join(workDir, ".snap/repository.json"),
        '{"format":1,"frontier":[],"patches":[]}\n',
      );
      await fs.writeFile(
        nodePath.join(workDir, ".snap/config.json"),
        '{"contributor":{"id":"a@x"}}\n',
      );

      // Materialize tree without any files
      await materialize(workDir, emptyTree());

      // .snap/repository.json must still exist
      const repoJson = await fs.readFile(nodePath.join(workDir, ".snap/repository.json"), "utf8");
      assert.ok(repoJson.includes("format"), ".snap/repository.json should still exist");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — no leftover temp files after failure", () => {
  void it("leaves no .snap-tmp-* files in workDir on success", async () => {
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([["file.txt", Buffer.from("content\n", "utf8")]]);
      await materialize(workDir, tree);

      // Check for any leftover temp files in workDir
      const all = await lsAll(workDir);
      const tempFiles = all.filter((f) => f.includes(".snap-tmp-"));
      assert.deepEqual(
        tempFiles,
        [],
        `No temp files should remain after success, found: ${tempFiles.join(", ")}`,
      );
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });

  void it("leaves no .snap-tmp-* files after successful nested write", async () => {
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([
        ["a/b/c.txt", Buffer.from("nested\n", "utf8")],
        ["root.txt", Buffer.from("root\n", "utf8")],
      ]);
      await materialize(workDir, tree);

      const all = await lsAll(workDir);
      const tempFiles = all.filter((f) => f.includes(".snap-tmp-"));
      assert.deepEqual(tempFiles, [], "No temp files after nested write");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void describe("materialize — idempotent application", () => {
  void it("applying the same tree twice produces the same result", async () => {
    const workDir = await makeTempDir();
    try {
      const tree = treeFromEntries([
        ["a.txt", Buffer.from("aaa\n", "utf8")],
        ["b.txt", Buffer.from("bbb\n", "utf8")],
        ["sub/c.txt", Buffer.from("ccc\n", "utf8")],
      ]);

      await materialize(workDir, tree);
      await materialize(workDir, tree);

      const a = await fs.readFile(nodePath.join(workDir, "a.txt"), "utf8");
      const b = await fs.readFile(nodePath.join(workDir, "b.txt"), "utf8");
      const c = await fs.readFile(nodePath.join(workDir, "sub/c.txt"), "utf8");
      assert.strictEqual(a, "aaa\n");
      assert.strictEqual(b, "bbb\n");
      assert.strictEqual(c, "ccc\n");
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  });
});

void before(async () => {
  tmpDir = await makeTempDir();
});

void after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});
