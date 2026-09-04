// Tests for fsys/worktree.ts
// Covers: clean/dirty/unsupported status, added/modified/deleted files, empty dirs, symlinks

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as os from "node:os";

import { scanWorktree, classifyWorktree } from "../../src/fsys/worktree.js";
import { emptyTree, treeFromEntries } from "../../src/core/tree.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(nodePath.join(os.tmpdir(), "snap-worktree-test-"));
}

// ---------------------------------------------------------------------------
// scanWorktree tests
// ---------------------------------------------------------------------------

void describe("scanWorktree — basic scanning", () => {
  void it("returns empty list for empty directory", async () => {
    const dir = await makeTempDir();
    try {
      const entries = await scanWorktree(dir);
      assert.deepEqual(entries, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("returns tracked entries for regular files", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(dir, "a.txt"), "hello\n");
      await fs.writeFile(nodePath.join(dir, "b.txt"), "world\n");

      const entries = await scanWorktree(dir);
      assert.strictEqual(entries.length, 2);

      const entry0 = entries[0]!;
      const entry1 = entries[1]!;

      assert.strictEqual(entry0.type, "tracked");
      assert.strictEqual(entry0.path, "a.txt");
      assert.strictEqual(entry1.type, "tracked");
      assert.strictEqual(entry1.path, "b.txt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("skips .snap/ directory entirely", async () => {
    const dir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(dir, ".snap"), { recursive: true });
      await fs.writeFile(nodePath.join(dir, ".snap/repository.json"), "{}");
      await fs.writeFile(nodePath.join(dir, "tracked.txt"), "data\n");

      const entries = await scanWorktree(dir);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]!.type, "tracked");
      assert.strictEqual(entries[0]!.path, "tracked.txt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("does not track empty directories", async () => {
    const dir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(dir, "empty-dir"), { recursive: true });
      await fs.mkdir(nodePath.join(dir, "nested/also-empty"), { recursive: true });

      const entries = await scanWorktree(dir);
      assert.deepEqual(entries, [], "Empty directories should not be tracked");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("recurses into subdirectories", async () => {
    const dir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(dir, "sub"), { recursive: true });
      await fs.writeFile(nodePath.join(dir, "root.txt"), "root\n");
      await fs.writeFile(nodePath.join(dir, "sub/child.txt"), "child\n");

      const entries = await scanWorktree(dir);
      assert.strictEqual(entries.length, 2);

      const paths = entries.map((e) => e.path);
      assert.ok(paths.includes("root.txt"), "root.txt should be tracked");
      assert.ok(paths.includes("sub/child.txt"), "sub/child.txt should be tracked");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("sorts entries by UTF-8 byte order path", async () => {
    const dir = await makeTempDir();
    try {
      // Write in reverse order
      await fs.writeFile(nodePath.join(dir, "z.txt"), "z\n");
      await fs.writeFile(nodePath.join(dir, "a.txt"), "a\n");
      await fs.writeFile(nodePath.join(dir, "m.txt"), "m\n");

      const entries = await scanWorktree(dir);
      const paths = entries.map((e) => e.path);
      assert.deepEqual(paths, ["a.txt", "m.txt", "z.txt"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("returns unsupported entry for a symlink", async () => {
    const dir = await makeTempDir();
    try {
      await fs.symlink("missing-target", nodePath.join(dir, "link"));

      const entries = await scanWorktree(dir);
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0]!.type, "unsupported");
      assert.strictEqual(entries[0]!.path, "link");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("reads file bytes correctly", async () => {
    const dir = await makeTempDir();
    try {
      const bytes = Buffer.from([0x01, 0x02, 0x03, 0xff]);
      await fs.writeFile(nodePath.join(dir, "bin.dat"), bytes);

      const entries = await scanWorktree(dir);
      assert.strictEqual(entries.length, 1);
      const entry = entries[0]!;
      assert.strictEqual(entry.type, "tracked");
      // After assert, TypeScript still unions - cast to access buf
      const tracked = entry as { type: "tracked"; path: string; buf: Buffer };
      assert.ok(tracked.buf.equals(bytes), "Binary bytes should be read correctly");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// classifyWorktree tests
// ---------------------------------------------------------------------------

void describe("classifyWorktree — clean working tree", () => {
  void it("returns clean when working tree exactly matches current tree", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(dir, "f.txt"), "hello\n");

      const tree = treeFromEntries([["f.txt", Buffer.from("hello\n", "utf8")]]);
      const status = await classifyWorktree(dir, tree);
      assert.strictEqual(status.type, "clean");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("returns clean for empty working tree and empty current tree", async () => {
    const dir = await makeTempDir();
    try {
      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "clean");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("ignores .snap/ contents when checking clean status", async () => {
    const dir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(dir, ".snap"), { recursive: true });
      await fs.writeFile(nodePath.join(dir, ".snap/repository.json"), "{}");
      await fs.writeFile(nodePath.join(dir, ".snap/config.json"), "{}");
      await fs.writeFile(nodePath.join(dir, "f.txt"), "data\n");

      const tree = treeFromEntries([["f.txt", Buffer.from("data\n", "utf8")]]);
      const status = await classifyWorktree(dir, tree);
      assert.strictEqual(status.type, "clean");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

void describe("classifyWorktree — dirty working tree", () => {
  void it("detects an added file (not in current tree)", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(dir, "new.txt"), "new\n");

      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "dirty");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("detects a modified file (different bytes)", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(dir, "f.txt"), "modified\n");

      const tree = treeFromEntries([["f.txt", Buffer.from("original\n", "utf8")]]);
      const status = await classifyWorktree(dir, tree);
      assert.strictEqual(status.type, "dirty");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("detects a deleted file (in current tree but absent from working tree)", async () => {
    const dir = await makeTempDir();
    try {
      // Working tree is empty, but current tree has a file
      const tree = treeFromEntries([["deleted.txt", Buffer.from("gone\n", "utf8")]]);
      const status = await classifyWorktree(dir, tree);
      assert.strictEqual(status.type, "dirty");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("includes all tracked entries in dirty result", async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(nodePath.join(dir, "a.txt"), "a\n");
      await fs.writeFile(nodePath.join(dir, "b.txt"), "b\n");

      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "dirty");
      // Cast to access entries after type check
      const dirty = status as { type: "dirty"; entries: readonly unknown[] };
      assert.strictEqual(dirty.entries.length, 2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

void describe("classifyWorktree — unsupported entries", () => {
  void it("returns unsupported when a symlink is present", async () => {
    const dir = await makeTempDir();
    try {
      await fs.symlink("missing", nodePath.join(dir, "link"));

      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "unsupported");
      // Cast to access paths after type check
      const unsupported = status as { type: "unsupported"; paths: readonly string[] };
      assert.deepEqual([...unsupported.paths], ["link"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("unsupported takes priority over dirty", async () => {
    const dir = await makeTempDir();
    try {
      // Both a symlink AND a new tracked file (dirty + unsupported)
      await fs.symlink("missing", nodePath.join(dir, "link"));
      await fs.writeFile(nodePath.join(dir, "dirty.txt"), "dirty\n");

      // Current tree does not have dirty.txt, so it would be dirty
      // But unsupported (symlink) takes priority
      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "unsupported", "unsupported should take priority over dirty");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  void it("returns sorted unsupported paths", async () => {
    const dir = await makeTempDir();
    try {
      await fs.symlink("missing", nodePath.join(dir, "z-link"));
      await fs.symlink("missing", nodePath.join(dir, "a-link"));

      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "unsupported");
      // Cast to access paths after type check
      const unsupported2 = status as { type: "unsupported"; paths: readonly string[] };
      assert.deepEqual([...unsupported2.paths], ["a-link", "z-link"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

void describe("classifyWorktree — empty directories not tracked", () => {
  void it("considers working tree clean when only empty directories exist (besides .snap/)", async () => {
    const dir = await makeTempDir();
    try {
      await fs.mkdir(nodePath.join(dir, "empty-dir"), { recursive: true });

      // Empty tree should match (empty dirs are not tracked)
      const status = await classifyWorktree(dir, emptyTree());
      assert.strictEqual(status.type, "clean");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
