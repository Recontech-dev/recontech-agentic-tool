import assert from "node:assert/strict";
import { test } from "node:test";

import { IdleModel, UNLOAD_AFTER_IDLE_CHECKS } from "../brain/sorting";

/** A stand-in for Laya that counts how often it is loaded and closed. */
function fakeModel() {
  const counts = { loads: 0, closes: 0 };
  const load = async () => {
    counts.loads++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { close: async () => void counts.closes++ };
  };
  return { counts, load };
}

test("the sorting model is loaded only when there is work and closed after a few empty rechecks", async () => {
  const { counts, load } = fakeModel();
  const model = new IdleModel(load);
  assert.equal(model.loaded, false, "nothing is loaded before there is something to sort");
  await model.idleCheck();
  assert.equal(counts.loads, 0, "an empty recheck never loads it");

  const first = await model.get();
  assert.equal(await model.get(), first, "work in the next recheck uses the model already loaded");
  assert.equal(counts.loads, 1);

  for (let i = 1; i < UNLOAD_AFTER_IDLE_CHECKS; i++) await model.idleCheck();
  assert.equal(model.loaded, true, "one quiet recheck is not enough to close it");
  await model.idleCheck();
  assert.deepEqual(counts, { loads: 1, closes: 1 });
  assert.equal(model.loaded, false);
  await model.idleCheck();
  assert.equal(counts.closes, 1, "closed once only");

  // A new session settles: loaded again.
  await model.get();
  assert.deepEqual(counts, { loads: 2, closes: 1 });
});

test("work between quiet rechecks starts the count again", async () => {
  const { counts, load } = fakeModel();
  const model = new IdleModel(load, 2);
  await model.get();
  await model.idleCheck();
  await model.get();
  await model.idleCheck();
  assert.equal(model.loaded, true, "the quiet rechecks were not in a row");
  await model.idleCheck();
  assert.equal(counts.closes, 1);
});

test("two requests while the model loads share one load", async () => {
  const { counts, load } = fakeModel();
  const model = new IdleModel(load);
  const [a, b] = await Promise.all([model.get(), model.get()]);
  assert.equal(a, b);
  assert.equal(counts.loads, 1);
});

test("a failed load is tried again on the next recheck", async () => {
  let fail = true;
  const model = new IdleModel(async () => {
    if (fail) throw new Error("disk busy");
    return { close: async () => {} };
  });
  await assert.rejects(model.get(), /disk busy/);
  assert.equal(model.loaded, false);
  fail = false;
  await model.get();
  assert.equal(model.loaded, true);
});
