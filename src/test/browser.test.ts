import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import { claudeCommand } from "../brain/launch";
import * as ws from "../brain/workspace";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-browser-"));

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  process.env.ALT_HOME = path.join(root, "home");
});

const claude = (extra: Partial<ws.Profile> = {}): ws.Profile => ({ id: "a", name: "A", color: "#fff", configDir: null, ...extra });

test("Claude Code gets --chrome only for a Claude terminal with the browser on, never a contained one", () => {
  assert.match(claudeCommand(claude({ browser: true }), "c.json"), /^claude --chrome --mcp-config 'c.json'$/);
  assert.match(claudeCommand(claude({ browser: true, kind: "claude", configDir: "C:\\Users\\x\\.claude-account1" }), "c.json"), / --chrome /,
    "a profile with its own sign-in folder too");
  assert.doesNotMatch(claudeCommand(claude(), "c.json"), /chrome/, "off unless turned on");
  assert.doesNotMatch(claudeCommand(claude({ browser: false }), "c.json"), /chrome/);
  assert.doesNotMatch(claudeCommand(claude({ browser: true }), "c.json", undefined, true), /chrome/, "contained");
  assert.doesNotMatch(claudeCommand(claude({ browser: true, kind: "ollama", model: "qwen3:8b" }), "c.json"), /chrome/, "Ollama");
  assert.doesNotMatch(claudeCommand(claude({ browser: true, kind: "free" }), "c.json"), /chrome/, "free providers");
  assert.doesNotMatch(claudeCommand(claude({ browser: "yes" as any }), "c.json"), /chrome/, "a hand-edited workspace.json needs a real true");
});

test("the browser switch is saved in workspace.json and refused where it is not allowed", () => {
  const workspace = ws.load();
  const main = workspace.profiles[0];
  ws.setBrowser(workspace, main.id, true);
  ws.save(workspace);
  const again = ws.load();
  assert.equal(again.profiles[0].browser, true, "survives a restart of the app");
  assert.match(claudeCommand(again.profiles[0], "c.json"), / --chrome /);

  ws.setBrowser(again, main.id, false);
  ws.save(again);
  assert.equal("browser" in ws.load().profiles[0], false, "off leaves no trace");

  const offline = ws.addProfile(again, { name: "Offline", kind: "ollama", model: "qwen3:8b" });
  assert.throws(() => ws.setBrowser(again, offline.id, true), /signed in to Claude/);
  ws.enableFreeProfile(again);
  const free = again.profiles.find((p) => p.kind === "free")!;
  assert.throws(() => ws.setBrowser(again, free.id, true), /signed in to Claude/);
  assert.doesNotThrow(() => ws.setBrowser(again, free.id, false), "turning it off is always allowed");
  assert.throws(() => ws.setBrowser(again, "gone", true), /not in this workspace/);
  assert.equal(ws.browserAllowed(again, main), true);
  assert.equal(ws.browserAllowed(again, free), false);
});
