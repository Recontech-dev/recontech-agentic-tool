import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { cleanSplit } from "../brain/workspace";

// split.js is a plain page script, so it is run in a sandbox and its functions are read back out.
const split = vm.runInNewContext(
  `${fs.readFileSync(path.join(__dirname, "..", "renderer", "split.js"), "utf8")}
  ({ splitDefault, splitDrop, splitReconcile, splitLeaves, splitZone });`,
  {},
);
// Values from the sandbox have its own Object prototype, so they are compared as plain JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const row = (...ids: string[]) => ({ dir: "row", sizes: ids.map(() => 1 / ids.length), children: ids.map((id) => ({ id })) });

test("the first layout is the old grid: up to 3 in a row, then two rows", () => {
  assert.deepEqual(plain(split.splitDefault(["a"])), { id: "a" });
  assert.deepEqual(plain(split.splitDefault(["a", "b", "c"])), row("a", "b", "c"));
  assert.deepEqual(plain(split.splitDefault(["a", "b", "c", "d", "e"])), { dir: "col", sizes: [0.5, 0.5], children: [row("a", "b", "c"), row("d", "e")] });
});

test("dropping on a side puts the terminal beside the target, and the middle swaps them", () => {
  const start = split.splitDefault(["a", "b", "c"]);
  // b below a: a's column becomes a stack of two, and b leaves the row.
  assert.deepEqual(plain(split.splitDrop(start, "b", "a", "bottom")), {
    dir: "row", sizes: [0.5, 0.5], children: [{ dir: "col", sizes: [0.5, 0.5], children: [{ id: "a" }, { id: "b" }] }, { id: "c" }],
  });
  // c left of a in the same row: once c has left, a has half the row, and c takes half of that.
  const left = plain(split.splitDrop(start, "c", "a", "left"));
  assert.deepEqual(plain(split.splitLeaves(left)), ["c", "a", "b"]);
  assert.deepEqual(left.sizes.map((n: number) => Math.round(n * 1000) / 1000), [0.25, 0.25, 0.5]);
  assert.deepEqual(plain(split.splitDrop(start, "a", "c", "center")), row("c", "b", "a"));
  // Dropping on itself, or naming a terminal that is not there, changes nothing.
  assert.deepEqual(plain(split.splitDrop(start, "a", "a", "left")), plain(start));
  assert.deepEqual(plain(split.splitDrop(start, "x", "a", "left")), plain(start));
});

test("a saved layout follows the terminals: removed ones leave, new ones join", () => {
  const saved = { dir: "row", sizes: [0.5, 0.5], children: [{ dir: "col", sizes: [0.5, 0.5], children: [{ id: "a" }, { id: "b" }] }, { id: "c" }] };
  // b is gone, so a's stack of one becomes just a.
  assert.deepEqual(plain(split.splitReconcile(saved, ["a", "c"])), row("a", "c"));
  const grown = plain(split.splitReconcile(saved, ["a", "b", "c", "d"]));
  assert.deepEqual(plain(split.splitLeaves(grown)), ["a", "b", "c", "d"]);
  // A terminal listed twice keeps its first place only.
  assert.deepEqual(plain(split.splitLeaves(split.splitReconcile(row("a", "b", "a"), ["a", "b"]))), ["a", "b"]);
  assert.deepEqual(plain(split.splitReconcile(null, ["a", "b"])), row("a", "b"));
});

test("the zone is the nearest edge, or the middle", () => {
  assert.equal(split.splitZone(50, 50, 100, 100), "center");
  assert.equal(split.splitZone(5, 50, 100, 100), "left");
  assert.equal(split.splitZone(95, 40, 100, 100), "right");
  assert.equal(split.splitZone(50, 10, 100, 100), "top");
  assert.equal(split.splitZone(40, 90, 100, 100), "bottom");
});

test("the main process keeps only a well-formed layout of known terminals", () => {
  const good = { dir: "row", sizes: [0.5, 0.5], children: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(cleanSplit(good, ["a", "b"]), good);
  assert.equal(cleanSplit({ ...good, children: [{ id: "a" }, { id: "zz" }] }, ["a", "b"]), null);
  assert.equal(cleanSplit({ ...good, sizes: [0.5] }, ["a", "b"]), null);
  assert.equal(cleanSplit({ ...good, sizes: [Infinity, 0.5] }, ["a", "b"]), null);
  assert.equal(cleanSplit({ ...good, dir: "diagonal" }, ["a", "b"]), null);
  assert.equal(cleanSplit("a", ["a"]), null);
  let deep: unknown = { id: "a" };
  for (let i = 0; i < 20; i++) deep = { dir: "row", sizes: [1], children: [deep] };
  assert.equal(cleanSplit(deep, ["a"]), null);
});
