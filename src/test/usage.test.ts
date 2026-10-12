import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import { summarize, tokenUsage, usageFile, usageOf } from "../brain/usage";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-usage-"));
  process.env.ALT_HOME = path.join(root, "home");
});

/** A transcript line for one content block of an answer, as Claude Code writes it. */
const answer = (id: string, time: string, input: number, output: number, cacheWrite = 0, cacheRead = 0, request = `req_${id}`) =>
  JSON.stringify({
    type: "assistant", requestId: request, timestamp: time,
    message: { id, role: "assistant", content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead } },
  });
const prompt = (time: string) => JSON.stringify({ type: "user", timestamp: time, message: { role: "user", content: "say \"usage\" please" } });

function transcript(configDir: string, name: string, lines: string[], end = "\n"): string {
  const file = path.join(configDir, "projects", "d--proj", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + end);
  return file;
}

test("a transcript line gives its message's tokens, and other lines give none", () => {
  assert.deepEqual(usageOf(answer("m1", "2026-10-12T10:00:00Z", 2, 300, 9000, 24000)), [
    "m1:req_m1", [Date.parse("2026-10-12T10:00:00Z"), 2, 300, 9000, 24000],
  ]);
  assert.equal(usageOf(prompt("2026-10-12T10:00:00Z")), null, "a prompt that only mentions the word");
  assert.equal(usageOf("{ broken"), null);
  assert.equal(usageOf(answer("m2", "not a date", 1, 1)), null);
  assert.equal(usageOf(answer("m3", "2026-10-12T10:00:00Z", 0, 0)), null, "an answer that used nothing");
  assert.deepEqual(usageOf(answer("m4", "2026-10-12T10:00:00Z", -5, 7))?.[1].slice(1), [0, 7, 0, 0]);
});

test("tokens are summed per week, month, year and in total, each answer once", () => {
  const now = new Date(2026, 9, 14, 12); // Wednesday 14 October 2026, local time
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 9).getTime();
  const files: { messages: Record<string, [number, number, number, number, number]> }[] = [
    { messages: {
      a: [at(2026, 9, 12), 10, 20, 0, 0], // Monday this week
      b: [at(2026, 9, 11), 1, 2, 3, 4], // Sunday: last week, this month
      c: [at(2026, 0, 1), 100, 0, 0, 0], // this year
      d: [at(2025, 11, 31), 1000, 0, 0, 0], // last year
    } },
    // A resumed session repeats an earlier answer under the same key; it is not counted again.
    { messages: { a: [at(2026, 9, 12), 10, 20, 0, 0] } },
  ];
  const sum = summarize(files, now);
  assert.equal(sum.week.total, 30);
  assert.deepEqual(sum.month, { input: 11, output: 22, cacheWrite: 3, cacheRead: 4, total: 40 });
  assert.equal(sum.year.total, 140);
  assert.equal(sum.all.total, 1140);
  assert.equal(sum.since, at(2025, 11, 31));
  assert.equal(summarize([], now).since, 0);
});

test("transcripts are read once, then only what was added, across profiles and subagents", async () => {
  const now = new Date();
  const today = now.toISOString();
  const one = path.join(root, "claude-one"), two = path.join(root, "claude-two");
  const file = transcript(one, "s1.jsonl", [
    prompt(today),
    // One answer, written as two lines (two content blocks) with the same usage.
    answer("m1", today, 5, 50), answer("m1", today, 5, 50),
  ]);
  transcript(two, path.join("s2", "subagents", "agent-1.jsonl"), [answer("m2", today, 1, 9)]);
  // The same answer copied into a resumed session in the other profile counts once.
  transcript(two, "s3.jsonl", [answer("m1", today, 5, 50)]);

  let sum = await tokenUsage([one, two, one], now);
  assert.equal(sum.all.total, 65);
  assert.equal(sum.week.output, 59);
  assert.ok(fs.existsSync(usageFile()));

  // A line still being written is left for the next read; once complete it counts, and only once.
  const half = answer("m3", today, 2, 8);
  fs.appendFileSync(file, half.slice(0, 40));
  assert.equal((await tokenUsage([one, two], now)).all.total, 65);
  fs.appendFileSync(file, half.slice(40) + "\n");
  sum = await tokenUsage([one, two], now);
  assert.equal(sum.all.total, 75);
  assert.equal((await tokenUsage([one, two], now)).all.total, 75, "nothing new, nothing added");

  // A deleted transcript still counts (those tokens were used); a folder that is no longer a profile does not.
  fs.rmSync(file);
  assert.equal((await tokenUsage([one, two], now)).all.total, 75);
  assert.equal((await tokenUsage([two], now)).all.total, 65);
});

test("calls made while a scan is running share it", async () => {
  const dir = path.join(root, "claude");
  transcript(dir, "s.jsonl", [answer("m1", new Date().toISOString(), 1, 2)]);
  const [a, b] = [tokenUsage([dir]), tokenUsage([dir])];
  assert.equal(a, b);
  assert.equal((await a).all.total, 3);
});
