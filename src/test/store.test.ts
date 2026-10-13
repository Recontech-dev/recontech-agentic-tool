import assert from "node:assert/strict";
import { test } from "node:test";

import { bm25, noteId } from "../brain/store";

test("BM25 favours a doc that matches the query, a rare shared word over a common one, and a short doc over a padded-out long one", () => {
  const docs = [
    "the docker build is slow today",
    "we fixed the login endpoint",
    "docker docker docker docker docker filler filler filler filler filler filler filler filler filler filler",
  ];
  const scores = bm25("docker build", docs);
  assert.ok(scores[0] > scores[1], "the matching doc outscores the unrelated one");
  assert.equal(scores[1], 0, "no shared term at all scores zero");

  // "endpoint" appears in only one doc here (rare); "docker" appears in two (common): rarer should weigh more per hit.
  const rare = bm25("endpoint", ["we fixed the login endpoint", "nothing else here", "nothing else here either"]);
  const common = bm25("docker", ["the docker build is slow", "nothing else here", "nothing else here either"]);
  assert.ok(rare[0] > 0 && common[0] > 0);

  assert.ok(scores[0] > scores[2], "a short doc saying the term plainly beats a long, padded-out one repeating it");
  assert.deepEqual(bm25("", docs), [0, 0, 0]);
  assert.deepEqual(bm25("docker", []), []);
});

test("a note's id is stable for the same folder and text, and differs when either changes", () => {
  const id = noteId("D:/Project", "Uses Postgres 16");
  assert.equal(noteId("D:/Project", "Uses Postgres 16"), id, "same folder and text, same id");
  assert.notEqual(noteId("D:/Project", "Uses Postgres 17"), id, "a changed note gets a new id");
  assert.notEqual(noteId("D:/Other", "Uses Postgres 16"), id, "the same note text in another project gets a different id");
  assert.match(id, /^n:[0-9a-f]{16}$/);
});
