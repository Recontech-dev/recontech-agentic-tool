import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-tasks-"));
process.env.ALT_HOME = path.join(root, "home");

// Load after ALT_HOME is set; paths are read on every call.
import { addTask, boardSummary, moveTask, readTasks, tasksFile } from "../brain/tasks";

test("hand-offs are tracked from sent to done, per project, and read aloud in plain words", () => {
  const project = path.join(root, "game");
  const other = path.join(root, "site");
  fs.mkdirSync(project);
  fs.mkdirSync(other);
  try {
    assert.deepEqual(readTasks(project), []);
    assert.equal(boardSummary([]), "There are no tasks yet.");

    const a = addTask(project, { title: "Fix the jump\x03 bug", from: "Earl AI", to: "Gio AI", files: ["src/player.ts", "", 42 as unknown as string], done: "jumping twice works" });
    assert.equal(a.title, "Fix the jump bug", "control characters never get in");
    assert.deepEqual(a.files, ["src/player.ts", "42"]);
    assert.equal(a.status, "sent");
    const b = addTask(project, { title: "Write the menu", from: "Earl AI", to: "Gio AI" });
    addTask(other, { title: "Another project's task", from: "x", to: "y" });

    assert.throws(() => addTask(project, { title: " ", from: "a", to: "b" }), /needs a title/);
    assert.throws(() => addTask(project, { title: "t", from: "", to: "b" }), /handing it out/);
    assert.throws(() => moveTask(project, a.id, "lost" as never), /status is one of/);
    assert.throws(() => moveTask(project, "nope", "done"), /no task/);

    moveTask(project, a.id, "working");
    const reviewed = moveTask(project, a.id, "review", "ready, see player.ts", "Main Manager");
    assert.equal(reviewed.to, "Main Manager", "handed on for review");
    moveTask(project, b.id, "failed", "the menu art is missing");

    // A crash halfway through a write leaves a broken last line; it is skipped.
    fs.appendFileSync(tasksFile(project), '{"kind":"move","id":');

    const tasks = readTasks(project);
    assert.equal(tasks.length, 2, "only this project's tasks");
    assert.deepEqual(tasks.map((t) => [t.title, t.status, t.to, t.note]), [
      ["Fix the jump bug", "review", "Main Manager", "ready, see player.ts"],
      ["Write the menu", "failed", "Gio AI", "the menu art is missing"],
    ]);
    assert.equal(boardSummary(tasks), '"Fix the jump bug" is in review with Main Manager. 1 task is finished.');

    moveTask(project, a.id, "done");
    assert.equal(boardSummary(readTasks(project)), "Nothing is open. 2 tasks are finished.");

    const secret = addTask(project, { title: "Use key sk-" + "PLACEHOLDER_NOT_A_REAL_KEY", from: "a", to: "b" });
    assert.ok(!secret.title.includes("PLACEHOLDER_NOT_A_REAL_KEY"), "secrets are masked before they are stored");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
