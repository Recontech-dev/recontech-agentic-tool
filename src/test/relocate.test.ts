import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { defaultHome, earlierHomes, userHome } from "../brain/paths";
import { moveData } from "../brain/relocate";

test("the data lives on the drive the app runs from, outside the app's own folder", () => {
  assert.equal(defaultHome("D:\\Recontech Agentic Tool\\Recontech Agentic Tool.exe", "C:"), "D:\\Recontech Agentic Tool Data");
  assert.equal(defaultHome("d:\\AI Terminal\\node_modules\\electron\\dist\\electron.exe", "C:"), "D:\\Recontech Agentic Tool Data", "a development run too");
  assert.equal(defaultHome("C:\\Users\\me\\AppData\\Local\\Programs\\recontech-agentic-tool\\x.exe", "C:"), userHome(), "on the Windows drive it stays in the user's folder");
  assert.equal(defaultHome("\\\\server\\share\\app.exe", "C:"), userHome(), "a network share is not a drive to fill");
});

test("data kept under the app's old name is found to be moved", () => {
  assert.deepEqual(earlierHomes("D:\\Recontech Agentic Tool\\x.exe", "C:").map((dir) => path.basename(dir)), [".agentic-lazy-tool", "Agentic Lazy Tool Data"]);
  assert.equal(earlierHomes("D:\\Recontech Agentic Tool\\x.exe", "C:")[1], "D:\\Agentic Lazy Tool Data");
  assert.equal(earlierHomes("C:\\Programs\\x.exe", "C:").length, 1, "on the Windows drive only the user's folder");
});

test("moving the data copies everything, points the workspace at the new place and retires the old folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-move-"));
  const from = path.join(root, "old"), to = path.join(root, "D", "Recontech Agentic Tool Data");
  fs.mkdirSync(path.join(from, "profiles", "work"), { recursive: true });
  fs.mkdirSync(path.join(from, "memory"));
  fs.writeFileSync(path.join(from, "profiles", "work", ".credentials.json"), "{}");
  fs.writeFileSync(path.join(from, "memory", "notes.md"), "a note");
  fs.writeFileSync(path.join(from, "workspace.json"), JSON.stringify({
    folder: "D:\\project",
    profiles: [
      { id: "default", name: "Main", configDir: null },
      { id: "work", name: "Work", configDir: path.join(from, "profiles", "work") },
      { id: "acct", name: "Account 1", configDir: "C:\\Users\\me\\.claude-account1" },
    ],
    sorting: { enabled: true, modelDir: path.join(from, "models") },
  }));

  assert.deepEqual(moveData(from, to), { moved: true });
  assert.equal(fs.existsSync(from), false, "the old folder is gone");
  assert.equal(fs.readFileSync(path.join(to, "memory", "notes.md"), "utf8"), "a note");
  assert.ok(fs.existsSync(path.join(to, "profiles", "work", ".credentials.json")), "sign-ins move with it");
  const workspace = JSON.parse(fs.readFileSync(path.join(to, "workspace.json"), "utf8"));
  assert.equal(workspace.profiles[0].configDir, null);
  assert.equal(workspace.profiles[1].configDir, path.join(to, "profiles", "work"));
  assert.equal(workspace.profiles[2].configDir, "C:\\Users\\me\\.claude-account1", "folders outside the data folder stay put");
  assert.equal(workspace.sorting.modelDir, path.join(to, "models"));
  assert.equal(workspace.folder, "D:\\project");

  // Once moved, nothing happens again; and an existing destination is never merged into.
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "workspace.json"), "{}");
  assert.deepEqual(moveData(from, to), { moved: false });
  assert.ok(fs.existsSync(from), "left alone");
  assert.deepEqual(moveData(path.join(root, "nothing"), path.join(root, "else")), { moved: false });
  fs.rmSync(root, { recursive: true, force: true });
});
