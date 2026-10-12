import assert from "node:assert/strict";
import { test } from "node:test";

import { IDLE_MS, Inbox } from "../main/inbox";

test("a message waits while the user is typing and arrives once they send or clear it", () => {
  const inbox = new Inbox();
  const t = 1_000_000;
  assert.equal(inbox.busy("work", t), false, "a terminal nobody typed in is free");

  inbox.typed("work", "fix the lo", t);
  assert.equal(inbox.busy("work", t + IDLE_MS * 10), true, "unsent text keeps it busy however long ago it was typed");
  inbox.hold("work", "first");
  inbox.hold("work", "second");
  assert.equal(inbox.next("work", false, t + IDLE_MS * 10), undefined);
  assert.equal(inbox.waiting("work"), 2);
  assert.deepEqual(inbox.pending(), ["work"]);

  // Backspacing the whole draft away clears it; arrow keys and terminal reports change nothing.
  inbox.typed("work", "\x7f".repeat(10) + "\x1b[D\x1b[A", t + 100);
  inbox.typed("work", "\x1b[I", t + 99_999);
  assert.equal(inbox.busy("work", t + 100 + IDLE_MS - 1), true, "just typed");
  assert.equal(inbox.next("work", false, t + 100 + IDLE_MS), "first", "free again after a quiet moment, oldest first");

  // A paste and Enter: the paste is a draft until Enter sends it.
  inbox.typed("work", "\x1b[200~hello\nworld\x1b[201~", t + 10_000);
  assert.equal(inbox.busy("work", t + 60_000), true);
  inbox.typed("work", "\r", t + 60_000);
  assert.equal(inbox.next("work", false, t + 60_000 + IDLE_MS), "second");
  assert.equal(inbox.waiting("work"), 0);
  assert.deepEqual(inbox.pending(), []);
});

test("the user can take a waiting message now, and a restart or removal resets the terminal", () => {
  const inbox = new Inbox();
  inbox.typed("work", "half a thought", 0);
  inbox.hold("work", "urgent");
  assert.equal(inbox.next("work", true, 1), "urgent", "sent now when the user asks, typing or not");

  inbox.typed("work", "abc\x03", 0);
  assert.equal(inbox.busy("work", IDLE_MS), false, "Ctrl+C clears the prompt");
  inbox.typed("work", "abc\x15", 0);
  assert.equal(inbox.busy("work", IDLE_MS), false, "so does Ctrl+U");

  inbox.typed("work", "unsent", 0);
  inbox.hold("work", "later");
  inbox.restarted("work");
  assert.equal(inbox.next("work", false, IDLE_MS), "later", "a new shell has an empty prompt; the message still goes to it");

  inbox.hold("work", "lost");
  inbox.forget("work");
  assert.equal(inbox.waiting("work"), 0);
});
