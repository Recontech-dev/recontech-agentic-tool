import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-consolidate-"));
  process.env.ALT_HOME = path.join(root, "home");
  process.env.OLLAMA_HOST = "http://127.0.0.1:9";
});

import { applyMerge, previewDuplicates, safeDrop } from "../brain/consolidate";
import { addNote, notes } from "../brain/store";

test("near-duplicate notes group together by shared words when there is no embedding model, and a lone note never groups", async () => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  addNote(project, "Deploy key lives in the CI secrets vault", "manual");
  addNote(project, "The deploy key lives in the CI secrets vault now", "manual");
  addNote(project, "Billing invoices are generated monthly", "manual");

  const groups = await previewDuplicates(project);
  assert.equal(groups.length, 1, "one duplicate group, the billing note stands alone");
  assert.equal(groups[0].keep.text, "Deploy key lives in the CI secrets vault", "the oldest of the group is kept");
  assert.deepEqual(groups[0].drop.map((n) => n.text), ["The deploy key lives in the CI secrets vault now"]);
  assert.ok(groups[0].similarity >= 0.88);

  assert.equal(notes(project).length, 3, "a preview changes nothing");
});

test("fewer than two notes never groups, and an empty project is fine", async () => {
  const project = path.join(root, "empty");
  fs.mkdirSync(project);
  assert.deepEqual(await previewDuplicates(project), []);
  addNote(project, "Only one note here", "manual");
  assert.deepEqual(await previewDuplicates(project), []);
});

test("a forged group naming a note that is not actually a duplicate is cut down to nothing", async () => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  addNote(project, "Deploy key lives in the CI secrets vault", "manual");
  addNote(project, "The deploy key lives in the CI secrets vault now", "manual");
  addNote(project, "Billing invoices are generated monthly", "manual");
  const fresh = await previewDuplicates(project);
  const real = fresh[0];

  // The real group's own claim survives untouched.
  assert.deepEqual(safeDrop(fresh, real).map((n) => n.text), real.drop.map((n) => n.text));

  // A forged claim naming the billing note (not a duplicate of anything) is dropped entirely.
  const billing = notes(project).find((n) => n.text.startsWith("Billing"))!;
  const forged = { keep: real.keep, drop: [billing] };
  assert.deepEqual(safeDrop(fresh, forged), [], "a note outside the real group is never allowed through");

  // A forged "keep" that names no real group drops nothing, even if the drop list looks plausible.
  assert.deepEqual(safeDrop(fresh, { keep: { text: "Not a real note", time: "x" }, drop: real.drop }), []);

  // Malformed input never throws and never drops anything.
  assert.deepEqual(safeDrop(fresh, {}), []);
  assert.deepEqual(safeDrop(fresh, { keep: real.keep, drop: "not an array" as any }), []);
  assert.deepEqual(safeDrop(fresh, { keep: real.keep, drop: [{ text: 5, time: null }] as any }), []);

  assert.equal(notes(project).length, 3, "none of this touched the notes themselves");
});

test("applying a merge removes exactly the drop notes and keeps the rest, and is safe to call on a stale group", async () => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  addNote(project, "Deploy key lives in the CI secrets vault", "manual");
  addNote(project, "The deploy key lives in the CI secrets vault now", "manual");
  addNote(project, "Billing invoices are generated monthly", "manual");
  const [group] = await previewDuplicates(project);

  assert.equal(applyMerge(project, group), 1);
  assert.deepEqual(notes(project).map((n) => n.text), ["Deploy key lives in the CI secrets vault", "Billing invoices are generated monthly"]);
  // The note was already removed: asking again removes nothing and never throws.
  assert.equal(applyMerge(project, group), 0);
});
