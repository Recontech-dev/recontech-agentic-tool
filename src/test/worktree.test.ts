import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { branchFor, ensureWorktree, listWorktrees, removeWorktree, repoRoot, worktreeDir, worktreeStatus } from "../brain/worktree";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

test("each Builder gets its own worktree and branch beside the project, and keeps its work", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "alt-worktree-"));
  const root = path.join(parent, "game");
  fs.mkdirSync(root);
  try {
    assert.equal(await repoRoot(root), null, "not a repository yet");
    run(root, "init", "-q", "-b", "main");
    await assert.rejects(ensureWorktree(root, "builder-1"), /at least one commit/);
    fs.writeFileSync(path.join(root, "a.txt"), "a\n");
    run(root, "add", ".");
    run(root, "commit", "-q", "-m", "first");
    assert.equal((await repoRoot(root))?.toLowerCase(), fs.realpathSync.native(root).toLowerCase());

    for (const bad of ["", "../x", "a/b", "-rf", "a b", "x".repeat(41)]) {
      assert.throws(() => worktreeDir(root, bad), /cannot be used/, bad);
    }

    const made = await ensureWorktree(root, "builder-1");
    assert.equal(made.created, true);
    assert.equal(made.branch, branchFor("builder-1"));
    assert.equal(made.dir, path.join(parent, "game.worktrees", "builder-1"), "beside the project, not inside it");
    assert.ok(fs.existsSync(path.join(made.dir, "a.txt")));
    assert.equal((await ensureWorktree(root, "builder-1")).created, false, "asking again reuses it");
    assert.equal((await listWorktrees(root)).length, 2);

    fs.writeFileSync(path.join(made.dir, "b.txt"), "b\n");
    assert.deepEqual(await worktreeStatus(made.dir, "main"), { dirty: 1, ahead: 0, behind: 0 });
    await assert.rejects(removeWorktree(root, "builder-1"), /uncommitted changes/);

    run(made.dir, "add", ".");
    run(made.dir, "commit", "-q", "-m", "builder work");
    fs.writeFileSync(path.join(root, "c.txt"), "c\n");
    run(root, "add", ".");
    run(root, "commit", "-q", "-m", "main moved on");
    assert.deepEqual(await worktreeStatus(made.dir, "main"), { dirty: 0, ahead: 1, behind: 1 });

    await removeWorktree(root, "builder-1");
    assert.equal(fs.existsSync(made.dir), false);
    assert.equal((await listWorktrees(root)).length, 1);
    await removeWorktree(root, "builder-1"); // already gone: nothing to do

    const again = await ensureWorktree(root, "builder-1");
    assert.ok(fs.existsSync(path.join(again.dir, "b.txt")), "the branch kept the committed work");

    fs.writeFileSync(path.join(again.dir, "d.txt"), "d\n");
    await removeWorktree(root, "builder-1", true);
    assert.equal(fs.existsSync(again.dir), false, "force throws uncommitted changes away");

    fs.mkdirSync(worktreeDir(root, "stray"), { recursive: true });
    await assert.rejects(ensureWorktree(root, "stray"), /not a worktree/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
