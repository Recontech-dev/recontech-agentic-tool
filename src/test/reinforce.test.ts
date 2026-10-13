import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import { DECAY_RATE, MAX_EDGES, PRUNE_BELOW, allEdges, neighbours, reset, scoreOf, scores, touch } from "../brain/reinforce";

beforeEach(() => {
  process.env.ALT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "alt-test-"));
  reset();
});

test("a recalled id scores above zero, and an id never recalled scores zero", async () => {
  assert.equal(scoreOf("a"), 0);
  await touch(["a", "b"]);
  assert.ok(scoreOf("a") > 0);
  assert.ok(scoreOf("b") > 0);
  assert.deepEqual(scores(["a", "b", "never"]), { a: scoreOf("a"), b: scoreOf("b") });
});

test("a score decays only while other recalls happen, never by itself", async () => {
  await touch(["a"]);
  const fresh = scoreOf("a");
  // No touch at all happens here: nothing should have changed, however this is read.
  assert.equal(scoreOf("a"), fresh);
  await touch(["x"]);
  await touch(["y"]);
  await touch(["z"]);
  assert.ok(scoreOf("a") < fresh, "three other recalls were three ticks of disuse for a");
  assert.ok(scoreOf("a") > 0, "decay fades a score, it does not zero it in a few ticks");
});

test("recalling two ids together strengthens the edge between them, and repeats strengthen it further", async () => {
  assert.deepEqual(neighbours("a"), []);
  await touch(["a", "b"]);
  const once = neighbours("a");
  assert.deepEqual(once.map((n) => n.id), ["b"]);
  await touch(["a", "b"]);
  const twice = neighbours("a")[0].weight;
  assert.ok(twice > once[0].weight, "a second co-recall strengthens the same edge");
  // c was never recalled with a: no edge.
  await touch(["c"]);
  assert.equal(neighbours("a").length, 1);
  assert.deepEqual(new Set(allEdges().map((e) => `${e.a}-${e.b}`)), new Set(["a-b"]));
});

test("a recall of three or more ids forms every pair, not just a chain", async () => {
  await touch(["a", "b", "c"]);
  assert.deepEqual(neighbours("a").map((n) => n.id).sort(), ["b", "c"]);
  assert.deepEqual(neighbours("b").map((n) => n.id).sort(), ["a", "c"]);
  assert.deepEqual(neighbours("c").map((n) => n.id).sort(), ["a", "b"]);
});

test("the decay rate is under 1 and over 0, so a score shrinks gradually, never jumps to zero in one tick", async () => {
  assert.ok(DECAY_RATE > 0 && DECAY_RATE < 1);
});

test("state survives a fresh load from disk (a new process reading the same ALT_HOME)", async () => {
  await touch(["a", "b"]);
  const before = scoreOf("a");
  reset();
  assert.equal(scoreOf("a"), before);
});

/** Runs touch() in a separate Node process on the same ALT_HOME, as another terminal's brain server would. */
function touchElsewhere(rounds: string[][]): Promise<void> {
  const script = `const r = require(${JSON.stringify(require.resolve("../brain/reinforce"))}); (async () => { for (const ids of ${JSON.stringify(rounds)}) if (!(await r.touch(ids))) process.exitCode = 3; })();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errors))));
  });
}

const fileOf = () => path.join(process.env.ALT_HOME!, "brain", "reinforce.json");

test("two processes touching in turn keep both updates, and each sees the other's", async () => {
  await touch(["app", "shared"]);
  await touchElsewhere([["terminal", "shared"]]);
  // This process read the file before the other one wrote: it must not answer from that stale copy.
  assert.ok(scoreOf("terminal") > 0, "the other process's update is seen");
  await touch(["app"]);
  await touchElsewhere([["terminal"]]);
  const saved = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
  assert.equal(saved.clock, 4, "four recalls, four ticks: none was lost");
  assert.deepEqual(Object.keys(saved.items).sort(), ["app", "shared", "terminal"]);
  assert.equal(saved.items.app.uses, 2);
  assert.equal(saved.items.terminal.uses, 2);
  assert.equal(saved.items.shared.uses, 2);
});

test("processes recalling at the same moment lose nothing and leave no temp or lock files", async () => {
  const workers = 4;
  const rounds = 15;
  await Promise.all(Array.from({ length: workers }, (_, w) => touchElsewhere(Array.from({ length: rounds }, (_, r) => [`w${w}-${r}`, `w${w}`]))));
  reset();
  const saved = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
  assert.equal(saved.clock, workers * rounds, "every recall ticked the one shared clock");
  for (let w = 0; w < workers; w++) assert.equal(saved.items[`w${w}`].uses, rounds, `worker ${w} kept all its updates`);
  assert.deepEqual(fs.readdirSync(path.dirname(fileOf())), ["reinforce.json"], "no temp file or lock is left behind");
});

test("a lock left by a process that died is taken over once it is stale", async () => {
  fs.mkdirSync(path.dirname(fileOf()), { recursive: true });
  const lock = fileOf() + ".lock";
  fs.writeFileSync(lock, "");
  assert.equal(await touch(["blocked"]), false, "a live lock is waited for, then the recall skips reinforcing rather than force it");
  assert.equal(scoreOf("blocked"), 0);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await touch(["after"]), true);
  assert.ok(scoreOf("after") > 0);
  assert.ok(!fs.existsSync(lock));
});

test("faded scores and edges are pruned when saved, and edges are capped", async () => {
  await touch(["old", "older"]);
  // About 150 ticks fade a single use below the prune line (0.97^150 ≈ 0.01).
  for (let i = 0; i < Math.ceil(Math.log(PRUNE_BELOW) / Math.log(DECAY_RATE)) + 1; i++) await touch([`tick${i % 3}`]);
  const saved = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
  assert.equal(saved.items.old, undefined, "a faded item is gone from the file");
  assert.equal(Object.keys(saved.edges).length, 0, "and so is its faded edge");
  assert.ok(saved.items.tick0, "what is still in use stays");

  const many = Array.from({ length: 102 }, (_, i) => `hit${i}`);
  await touch(many);
  const capped = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
  assert.equal(Object.keys(capped.edges).length, MAX_EDGES, "102 hits would be 5151 edges");
});
