import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { roleById } from "../brain/kits";
import { Task, Teammate, checkerFor, handOffMessage, whyNotMove } from "../brain/tasks";
import { Control, TerminalInfo } from "../main/control";

const task = (to: string): Task => ({
  id: "t1", title: "Fix the jump", from: "Lead", to, files: ["src/player.ts"], done: "jumping twice works",
  status: "working", note: "", created: "", updated: "",
});
const member = (name: string, roleId?: string, running = true): Teammate =>
  ({ name, running, roleId, role: roleId ? roleById(roleId).name : undefined });

test("a Builder's finished task goes to a running Reviewer first, then a Tester, never back to itself", () => {
  const builder = member("Coder", "builder");
  assert.equal(checkerFor(task("Coder"), [builder, member("QA", "tester"), member("Checker", "reviewer")])?.name, "Checker");
  assert.equal(checkerFor(task("Coder"), [builder, member("QA", "tester"), member("Checker", "reviewer", false)])?.name, "QA", "a Reviewer that is not running is skipped");
  assert.equal(checkerFor(task("coder"), [builder, member("QA", "tester")])?.name, "QA", "names match whatever their case");
  assert.equal(checkerFor(task("Coder"), [builder, member("Spare")]), null, "nobody to check it: it simply stays done");
  assert.equal(checkerFor(task("Checker"), [builder, member("Checker", "reviewer"), member("QA", "tester")]), null, "a Reviewer's done is final, so there is no loop");
  assert.equal(checkerFor(task("Ghost"), [builder, member("Checker", "reviewer")]), null, "a holder the app does not know is not a Builder");
  // Without an id (an older app), the display name still says who is who.
  assert.equal(checkerFor(task("Coder"), [{ name: "Coder", running: true, role: "Builder" }, { name: "R", running: true, role: "Reviewer" }])?.name, "R");
  assert.equal(checkerFor(task("Coder"), []), null);
});

test("the hand-off message names the task, the files, what done means and how to answer", () => {
  const text = handOffMessage(task("Coder"), "Coder", "fixed in player.ts");
  assert.match(text, /Task t1 "Fix the jump" was finished by Coder/);
  assert.match(text, /Files: src\/player\.ts\./);
  assert.match(text, /Done means: jumping twice works/);
  assert.match(text, /Coder's note: fixed in player\.ts/);
  assert.match(text, /update_task with id "t1"/);
});

test("only the holder or the one who handed a task out moves it, and only the checker closes a review", () => {
  const working = task("Coder");
  assert.equal(whyNotMove(working, "Coder", "done"), null);
  assert.equal(whyNotMove(working, " lead ", "failed"), null, "the hander, whatever the case and spaces");
  assert.match(whyNotMove(working, "Checker", "done")!, /Only Coder, who has task t1, or Lead/);
  assert.match(whyNotMove(working, "", "working")!, /Only Coder/, "a server without a name moves nothing");
  const review: Task = { ...working, status: "review", to: "Checker", builder: "Coder" };
  assert.match(whyNotMove(review, "Coder", "done")!, /being checked by Checker; only Checker can mark it done/, "a Builder can't close its own task while it's in review");
  assert.match(whyNotMove(review, "Lead", "done")!, /only Checker/, "nor can the one who handed it out");
  assert.equal(whyNotMove(review, "Checker", "failed"), null);
  assert.equal(whyNotMove(review, "Lead", "working"), null, "the hander can still take it back out of review");
});

/** The brain's MCP server for one terminal, talking to a Control that stands in for the app. */
async function serverFor(t: { after: (fn: () => void) => void }, self: string, control: Control, dir: string) {
  const controlFile = path.join(dir, "control.json");
  control.writeAddress(controlFile);
  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
    cwd: dir, env: { ...process.env, ALT_HOME: path.join(dir, "home"), ALT_CLAUDE_HOME: path.join(dir, "claude"), ALT_PROFILE: self, ALT_CONTROL: controlFile },
  });
  t.after(() => server.kill());
  const replies: any[] = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  let next = 1;
  return async (name: string, args: object = {}) => {
    const id = next++;
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    for (let i = 0; i < 500 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 30));
    const result = replies.find((r) => r.id === id).result;
    return { text: String(result.content[0].text), error: result.isError === true };
  };
}

test("dry run with two terminals: the Builder marks its task done and the Reviewer is sent it automatically", async (t) => {
  const team: TerminalInfo[] = [
    { name: "Coder", kind: "claude", running: true, role: "Builder", roleId: "builder" },
    { name: "Checker", kind: "claude", running: true, role: "Reviewer", roleId: "reviewer" },
    { name: "Lead", kind: "claude", running: true, role: "Manager", roleId: "manager" },
  ];
  const delivered: [string, string][] = [];
  const control = new Control({ terminals: () => team, read: async () => "", deliver: (name, text) => void delivered.push([name, text]) });
  await control.listen();
  t.after(() => control.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alt-handoff-"));
  // Registered first so it runs last, once the servers are gone; a folder Windows still holds is left behind.
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } });
  // Each terminal works in the same project folder with its own brain server, as in the app.
  const lead = await serverFor(t, "Lead", control, dir);
  const checker = await serverFor(t, "Checker", control, dir);
  const coder = await serverFor(t, "Coder", control, dir);
  const last = () => delivered[delivered.length - 1];

  // The Manager hands the Builder a task; the Builder is sent it.
  const handed = await lead("hand_task", { to: "Coder", title: "Fix the jump", files: ["src/player.ts"], done: "jumping twice works" });
  assert.match(handed.text, /^Task (\w+) is on the board and was sent to Coder\.$/);
  const id = /^Task (\w+)/.exec(handed.text)![1];
  assert.equal(delivered.length, 1);
  assert.equal(last()[0], "Coder");
  assert.ok(last()[1].includes(`You are handed task ${id}: "Fix the jump". Files: src/player.ts. Done means: jumping twice works`), last()[1]);

  // Somebody else's task is not the Reviewer's to move.
  const meddle = await checker("update_task", { id, status: "done" });
  assert.equal(meddle.error, true);
  assert.match(meddle.text, /Only Coder, who has task \w+, or Lead, who handed it out, can move it/);

  assert.equal((await coder("update_task", { id, status: "working" })).text, `Task ${id} is now working.`);
  assert.equal(delivered.length, 1, "progress is not sent anywhere");

  // Done by the Builder: it goes to the Reviewer instead of counting as done.
  const done = await coder("update_task", { id, status: "done", note: "double jump fixed" });
  assert.equal(done.text, `Task ${id} was sent to Checker (Reviewer) to check. It counts as done once Checker marks it so.`);
  assert.equal(delivered.length, 2);
  assert.equal(last()[0], "Checker");
  assert.match(last()[1], /^\[Message from the "Coder" terminal\] Task \w+ "Fix the jump" was finished by Coder and needs checking/);
  assert.match(last()[1], /Coder's note: double jump fixed/);
  assert.equal((await coder("task_board")).text, `"Fix the jump" is in review with Checker.\n- ${id} [review] "Fix the jump", Checker (from Lead): double jump fixed`);

  // A Builder can't close its own task while it's in review, and neither can the Manager.
  for (const [who, server] of [["Coder", coder], ["Lead", lead]] as const) {
    const skip = await server("update_task", { id, status: "done" });
    assert.equal(skip.error, true, `${who} cannot skip the review`);
    assert.match(skip.text, /being checked by Checker; only Checker can mark it done/);
  }

  // A failed check goes back to the Builder with the findings.
  const failed = await checker("update_task", { id, status: "failed", note: "triple jump still possible" });
  assert.equal(failed.text, `Task ${id} failed the check and went back to Coder with your note.`);
  assert.equal(last()[0], "Coder");
  assert.match(last()[1], /did not pass Checker's check: triple jump still possible Fix it/);
  assert.ok((await lead("task_board")).text.includes(`- ${id} [working] "Fix the jump", Coder (from Lead): triple jump still possible`));

  // Fixed and done again: back to review, then the Reviewer's done is final, with no further hand-off.
  assert.match((await coder("update_task", { id, status: "done", note: "fixed for real" })).text, /was sent to Checker \(Reviewer\) to check/);
  assert.equal(last()[0], "Checker");
  const sent = delivered.length;
  assert.equal((await checker("update_task", { id, status: "done", note: "looks right" })).text, `Task ${id} is now done.`);
  assert.equal(delivered.length, sent);
  assert.match((await checker("task_board")).text, /^Nothing is open\. 1 task is finished\./);

  // With no Reviewer or Tester running, a Builder's done stays done.
  team[1].running = false;
  const second = /^Task (\w+)/.exec((await lead("hand_task", { to: "Coder", title: "Write the menu" })).text)![1];
  assert.equal((await coder("update_task", { id: second, status: "done" })).text, `Task ${second} is now done.`);

  const bad = await coder("update_task", { id: "nope", status: "done" });
  assert.equal(bad.error, true);
  assert.match(bad.text, /no task/);
});
