import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { changedAt, committed, inside, list, readText, runnable, writeText } from "../brain/files";

test("the Files panel lists a project folder level by level and never leaves it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-files-"));
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "Assets"));
  fs.writeFileSync(path.join(root, "readme.md"), "");
  fs.writeFileSync(path.join(root, ".env"), "");
  fs.writeFileSync(path.join(root, "file10.txt"), "");
  fs.writeFileSync(path.join(root, "file2.txt"), "");
  fs.writeFileSync(path.join(root, "src", "main.ts"), "");

  const top = list(root);
  assert.deepEqual(top.entries.map((e) => e.name), ["Assets", "src", ".env", "file2.txt", "file10.txt", "readme.md"], "folders first, natural order, no .git");
  assert.equal(top.more, false);
  assert.deepEqual(list(root, "src").entries, [
    { name: "deep", path: "src/deep", dir: true },
    { name: "main.ts", path: "src/main.ts", dir: false },
  ]);

  for (const escape of ["..", "../..", "src/../../x", path.dirname(root), "C:\\Windows"]) {
    assert.throws(() => list(root, escape), /outside the project folder/, escape);
  }
  assert.equal(inside(root, "src/deep"), path.join(root, "src", "deep"));
  assert.throws(() => inside("", "x"), /Choose a project folder/);

  assert.equal(runnable("setup.EXE"), true);
  assert.equal(runnable("build.ps1"), true);
  assert.equal(runnable("index.js"), true, "Windows runs .js files with Script Host");
  assert.equal(runnable("notes.md"), false);
  assert.equal(runnable("main.ts"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the editor reads text files, refuses binary ones, and never overwrites a file changed meanwhile", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-edit-"));
  fs.writeFileSync(path.join(root, "run.ps1"), "\ufeffWrite-Host hi\r\n");
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));

  const script = readText(root, "run.ps1");
  assert.equal(script.text, "Write-Host hi\r\n", "the byte order mark is not part of the text, line endings are kept");
  assert.equal(script.bom, true);
  assert.throws(() => readText(root, "logo.png"), (e: any) => e.code === "binary");
  assert.throws(() => readText(root, "../outside.txt"), /outside the project folder/);

  const saved = writeText(root, "run.ps1", "Write-Host bye\r\n", script.mtime, script.bom);
  assert.ok("mtime" in saved);
  assert.equal(fs.readFileSync(path.join(root, "run.ps1"), "utf8"), "\ufeffWrite-Host bye\r\n", "written back with its byte order mark");

  // Someone else (Claude Code) changes the file after it was opened: saving must not clobber it.
  const opened = readText(root, "run.ps1");
  fs.writeFileSync(path.join(root, "run.ps1"), "changed elsewhere");
  fs.utimesSync(path.join(root, "run.ps1"), new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(writeText(root, "run.ps1", "mine", opened.mtime, false), { conflict: true });
  assert.equal(fs.readFileSync(path.join(root, "run.ps1"), "utf8"), "changed elsewhere");
  assert.ok("mtime" in writeText(root, "run.ps1", "mine", opened.mtime, false, true), "the user can choose to overwrite");
  assert.equal(changedAt(root, "gone.txt"), 0);

  assert.equal(committed(root, "run.ps1"), null, "no git repository here");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  try {
    git("init", "-q");
    git("add", "run.ps1");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
  } catch {
    return; // git is not installed on this machine; the rest needs it
  }
  fs.writeFileSync(path.join(root, "run.ps1"), "newer");
  assert.equal(committed(root, "run.ps1"), "mine", "the text as of the last commit");
  assert.equal(committed(root, "new.txt"), null, "a file that was never committed");
  fs.rmSync(root, { recursive: true, force: true });
});
