import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { Member, handoverMessage, handoverOffer, nearLimit, openTasksOf, screenTail, takersFor } from "../brain/handover";
import { Task } from "../brain/tasks";

const task = (id: string, to: string, status: Task["status"] = "working", extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, from: "Lead", to, files: [], done: "", status, note: "", created: "", updated: "", ...extra,
});
const member = (id: string, extra: Partial<Member> = {}): Member => ({
  id, name: id, running: true, account: `acct-${id}`, contained: false, near: null, ...extra,
});

test("near a limit means 90% or more of the session or the week, the fuller one", () => {
  assert.equal(nearLimit({ session: { percent: 89.9 }, week: { percent: 50 } }), null);
  assert.deepEqual(nearLimit({ session: { percent: 90 }, week: { percent: 50 } }), { which: "session", percent: 90 });
  assert.deepEqual(nearLimit({ session: { percent: 95 }, week: { percent: 99 } }), { which: "week", percent: 99 });
  assert.deepEqual(nearLimit({ session: { percent: 120 }, week: null }), { which: "session", percent: 120 }, "extra usage can go over 100");
  assert.equal(nearLimit({ error: "Not signed in" }), null, "unknown is not near");
  assert.equal(nearLimit(null), null);
  assert.equal(nearLimit({ session: { percent: NaN }, week: null }), null);
});

test("only a running terminal on another account, not contained and not near a limit itself, can take over", () => {
  const from = member("Gio", { near: { which: "session", percent: 93 }, role: "builder" });
  const team = [
    from,
    member("SameAccount", { account: from.account }),
    member("Stopped", { running: false }),
    member("Free", { contained: true, account: "kind:free" }),
    member("AlsoNear", { near: { which: "week", percent: 91 } }),
    member("Reviewer", { role: "reviewer" }),
    member("Builder2", { role: "builder" }),
    member("Ollama", { account: "kind:ollama" }),
  ];
  assert.deepEqual(takersFor(from, team).map((m) => m.name), ["Builder2", "Reviewer", "Ollama"], "same role first, then the rest in order");
});

test("an offer needs a terminal near its limit, open tasks of its own, and someone to take them", () => {
  const near = { which: "session" as const, percent: 95 };
  const tasks = [task("a", "Gio"), task("b", "gio ", "sent"), task("c", "Gio", "done"), task("d", "Gio", "failed"), task("e", "Other"), task("f", "Gio", "review")];
  const team = [member("Gio", { near }), member("Other")];

  const offer = handoverOffer("Gio", tasks, team)!;
  assert.deepEqual(offer.tasks.map((t) => t.id), ["a", "b", "f"], "open ones only, its own, names matched loosely");
  assert.deepEqual(offer.to.map((m) => m.name), ["Other"]);
  assert.deepEqual(openTasksOf("Other", tasks).map((t) => t.id), ["e"]);

  assert.equal(handoverOffer("Gio", tasks, [member("Gio"), member("Other")]), null, "not near a limit: nothing offered");
  assert.equal(handoverOffer("Gio", [task("c", "Gio", "done")], team), null, "nothing open: nothing offered");
  assert.equal(handoverOffer("Gio", tasks, [member("Gio", { near }), member("Other", { account: "acct-Gio" })]), null, "nobody free: nothing offered");
  assert.equal(handoverOffer("Nobody", tasks, team), null);
});

test("the taker gets a short summary: why, each task, where things stood, without secrets or escape codes", () => {
  const from = member("Gio", { near: { which: "week", percent: 96.4 } });
  const tasks = [task("t1", "Gio", "working", { title: "Fix the jump", files: ["src/player.ts"], done: "jumping twice works", note: "half done" })];
  const screen = "\x1b[32m╭────╮\x1b[0m\n│ Editing src/player.ts │\n\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") +
    "\nkey sk-" + "PLACEHOLDER_NOT_A_REAL_KEY\x07\n";
  const text = handoverMessage(from, tasks, screen);
  assert.match(text, /^Gio is at 96% of its weekly usage limit, so the user handed its open task to you\./);
  assert.match(text, /Task t1 "Fix the jump" \(working, from Lead\)\. Files: src\/player\.ts\. Done means: jumping twice works Latest note: half done/);
  assert.match(text, /Last on Gio's screen:\nline 19\n/, "only the last few lines");
  assert.ok(!text.includes("line 18\n"));
  assert.ok(!text.includes("PLACEHOLDER_NOT_A_REAL_KEY"), "secrets are masked");
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text), "no control characters or escape codes");
  assert.match(text, /update_task/);
  assert.match(handoverMessage(member("Gio", { near: { which: "session", percent: 0 } }), tasks), /^Gio is near its usage limit, so/, "only Claude Code's word for it: no made-up figure");
  assert.equal(screenTail(""), "");
  assert.ok(screenTail("x\n".repeat(2000), 500).length <= 800, "capped");
});

test("the app hands over only from the user's confirmed click, never by itself", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "..", "src", "renderer", "renderer.ts"), "utf8");
  const calls = [...renderer.matchAll(/"handover:confirm"/g)];
  assert.equal(calls.length, 1, "one place asks for a hand-over");
  const fn = renderer.slice(renderer.indexOf("async function offerHandover("), calls[0].index);
  assert.match(fn, /if \(!confirm\([\s\S]*\)\) return;\s*const result = await api\.invoke\($/, "right behind the user's confirm");
  assert.equal([...renderer.matchAll(/offerHandover\(/g)].length, 2, "defined once, called once");
  assert.match(renderer, /button\.onclick = \(\) => void offerHandover\(id\);/, "and called only from the button's click");
  // The main process re-checks the offer before it moves anything (see main.ts handover:confirm).
  const main = fs.readFileSync(path.join(__dirname, "..", "..", "src", "main", "main.ts"), "utf8");
  const confirmHandler = main.slice(main.indexOf('ipcMain.handle("handover:confirm"'));
  assert.ok(confirmHandler.indexOf("handoverOffer(") < confirmHandler.indexOf("moveTask("), "the offer is worked out again before any task moves");
  assert.ok(!main.slice(main.indexOf('ipcMain.handle("handover:offer"'), main.indexOf('ipcMain.handle("handover:confirm"')).includes("moveTask("), "offering moves nothing");
});
