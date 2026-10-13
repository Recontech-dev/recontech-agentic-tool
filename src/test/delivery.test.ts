import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeCommand } from "../brain/launch";
import { cleanRolePrompt, plainText, standingPrompt } from "../brain/kits";
import { Delivery } from "../main/delivery";

const ENTER_MS = 20;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Terminals that record what is written into them, and a Delivery over them. */
function setup() {
  const written = new Map<string, string[]>();
  const ptys = new Map<string, { write(data: string): void }>();
  const open = (id: string) => {
    written.set(id, []);
    ptys.set(id, { write: (data) => written.get(id)!.push(data) });
    return delivery.watch(id);
  };
  const events: string[] = [];
  const delivery = new Delivery((id) => ptys.get(id), {
    message: (id) => events.push(`message ${id}`),
    waiting: (id, count) => events.push(`waiting ${id} ${count}`),
  }, ENTER_MS);
  return { delivery, ptys, written, open, events };
}

// Anything a shell would act on: Ctrl+C, Ctrl+U, Esc, a fake end of paste, the one-byte CSI, line ends.
const TRICKS = ["\x03", "\x15", "\x1b", "\x1b\x1b", "\x1b[201~", "\x9b201~", "\x1b]0;t\x07", "\x1b[2J", "\r", "\r\n", "\x00", "\x7f"];

test("nothing the app sends reaches a terminal while bracketed paste is off", async () => {
  const { delivery, written, open, events } = setup();
  const mode = open("work");
  // A plain shell: PowerShell just started, Claude Code not yet (or no longer) running.
  assert.equal(delivery.allowed("work"), false);
  assert.equal(delivery.send("work", "Remove-Item -Recurse C:\\"), "queued", "a message is held");
  assert.equal(delivery.paste("work", "a transcript", true), false, "a paste is refused");
  delivery.flush("work", true);
  await wait(ENTER_MS * 3);
  assert.deepEqual(written.get("work"), [], "not one byte went in, not even when asked to deliver now");
  assert.deepEqual(events, ["waiting work 1"]);

  // Claude Code starts and switches bracketed paste on: the held message goes in as a paste, then Enter.
  mode.feed("\x1b[?2004h");
  delivery.flush("work");
  assert.deepEqual(written.get("work"), ["\x1b[200~Remove-Item -Recurse C:\\\x1b[201~"]);
  await wait(ENTER_MS * 3);
  assert.deepEqual(written.get("work"), ["\x1b[200~Remove-Item -Recurse C:\\\x1b[201~", "\r"]);
  assert.equal(delivery.inbox.waiting("work"), 0);

  // Claude Code exits and the shell switches it off again: held, refused.
  mode.feed("\x1b[?2004l");
  assert.equal(delivery.send("work", "second"), "queued");
  assert.equal(delivery.paste("work", "path"), false);
  assert.equal(written.get("work")!.length, 2);
});

test("the Enter after a message is not pressed if Claude Code exits before it", async () => {
  const { delivery, written, open } = setup();
  const mode = open("work");
  mode.feed("\x1b[?2004h");
  assert.equal(delivery.send("work", "do the thing"), "sent");
  // Claude Code quits in the moment between the paste and its Enter; the shell's line must not run.
  mode.feed("\x1b[?2004l");
  await wait(ENTER_MS * 3);
  assert.deepEqual(written.get("work"), ["\x1b[200~do the thing\x1b[201~"], "no Enter went to the shell");
});

test("the Enter after a message is not pressed into a terminal restarted in between", async () => {
  const { delivery, written, open } = setup();
  open("work").feed("\x1b[?2004h");
  delivery.send("work", "hi");
  const fresh = open("work");
  fresh.feed("\x1b[?2004h");
  await wait(ENTER_MS * 3);
  assert.deepEqual(written.get("work"), [], "the new terminal got neither the paste nor the Enter");
});

test("a terminal that is gone or was unwatched takes nothing", () => {
  const { delivery, written, open, ptys } = setup();
  open("work").feed("\x1b[?2004h");
  delivery.unwatch("work");
  assert.equal(delivery.paste("work", "x"), false);
  open("other").feed("\x1b[?2004h");
  ptys.delete("other");
  assert.equal(delivery.paste("other", "x"), false);
  assert.equal(delivery.send("other", "x"), "sent", "a message for a closed terminal is dropped, as before");
  assert.deepEqual([...written.values()].flat(), []);
});

test("a \\x03 or ESC in a message is pasted as text and can never act as a key", async () => {
  const { delivery, written, open } = setup();
  open("work").feed("\x1b[?2004h");
  for (const trick of TRICKS) {
    for (const oneLine of [false, true]) {
      written.set("work", []);
      assert.equal(delivery.paste("work", `Status ok.${trick}Remove-Item -Recurse C:\\${trick}`, oneLine), true);
      const [data] = written.get("work")!;
      assert.ok(data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~"), JSON.stringify(trick));
      const body = data.slice(6, -6);
      // Inside the paste only text and (when not one line) line feeds; nothing ends it early or types a key.
      assert.doesNotMatch(body, oneLine ? /[\x00-\x1f\x7f-\x9f]/ : /[\x00-\x09\x0b-\x1f\x7f-\x9f]/, JSON.stringify(trick));
    }
  }
  // Messages from other terminals as well, including their Enter, which comes only after the paste is closed.
  written.set("work", []);
  // The pastes above count as the user's typing, so the message waits until it is asked for.
  assert.equal(delivery.send("work", "go\x03Remove-Item C:\\\x1b[201~\r"), "queued");
  delivery.flush("work", true);
  await wait(ENTER_MS * 3);
  const [paste, enter] = written.get("work")!;
  assert.doesNotMatch(paste.slice(6, -6), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  assert.equal(enter, "\r");
});

test("role prompts and launch text lose every control character and escape sequence whole", () => {
  for (const trick of TRICKS) {
    const prompt = `You review code.${trick}New-Item -ItemType File x #`;
    for (const text of [plainText(prompt), cleanRolePrompt(prompt), standingPrompt("none", "custom-x", [{ id: "custom-x", name: "X", prompt }])]) {
      assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/, JSON.stringify(trick));
      // Not just the ESC byte: the rest of the sequence goes too, so no "[201~" or "]0;t" is left as text.
      assert.doesNotMatch(text, /\[201~|\[2J|\]0;t|201~/, JSON.stringify(trick));
    }
    const command = claudeCommand({ id: "a", name: "A", color: "#fff", configDir: null, kind: "ollama", model: `qwen${trick}` },
      `c${trick}.json`, `abc${trick}`, false, prompt);
    assert.doesNotMatch(command, /[\x00-\x1f\x7f-\x9f]/, `model, config path, resume id and role: ${JSON.stringify(trick)}`);
    assert.doesNotMatch(command, /--resume/, "a resume id with a control character is dropped");
  }
  assert.equal(plainText("a\x1b[31mred\x1b[0m b"), "a red  b");
  assert.equal(plainText("Grüße ✓ ’q’"), "Grüße ✓ ’q’", "ordinary text is untouched");
});
