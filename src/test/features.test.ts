import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import { Brain } from "../brain/brain";
import { KITS, ROLES, cleanRolePrompt, detectKit, standingPrompt } from "../brain/kits";
import { claudeCommand } from "../brain/launch";
import * as meaning from "../brain/meaning";
import { SHARE_FILE, exportProject, importProject, newSharedNotes, readShared } from "../brain/share";
import * as sorting from "../brain/sorting";
import { cleanupTranscript } from "../brain/speech";
import { addNote, notes } from "../brain/store";
import { newer } from "../brain/version";
import * as ws from "../brain/workspace";

let root = "";
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-features-"));
  process.env.ALT_HOME = path.join(root, "home");
  process.env.ALT_CLAUDE_HOME = path.join(root, "claude-default");
  process.env.OLLAMA_HOST = "http://127.0.0.1:9";
  meaning.reset();
});

test("the same note is not stored twice", () => {
  const project = path.join(root, "game");
  fs.mkdirSync(project);
  addNote(project, "Player speed is 6 units per second.", "manual");
  addNote(project, "  player speed is 6 units   per second ", "claude-code");
  addNote(project, "Enemies spawn every 4 seconds", "manual");
  assert.equal(notes(project).length, 2);
});

test("a teammate gets the project's notes through the share file, without secrets or prompts", () => {
  const mine = path.join(root, "mine", "game");
  fs.mkdirSync(mine, { recursive: true });
  addNote(mine, "Levels are JSON files in Assets/Levels", "manual");
  addNote(mine, "Build key is " + "gsk_" + "c".repeat(30), "manual");
  assert.equal(exportProject(mine, [{ title: "Fix the jump bug", ended: "2026-10-10T09:00:00Z" }]), 2);
  const file = fs.readFileSync(path.join(mine, SHARE_FILE), "utf8");
  assert.ok(!file.includes("gsk_c"), "secrets are masked in the file");
  assert.deepEqual(readShared(mine)!.unfinished, [{ title: "Fix the jump bug", ended: "2026-10-10" }]);

  // The teammate has the project in another folder, with one note of their own already.
  process.env.ALT_HOME = path.join(root, "teammate-home");
  const theirs = path.join(root, "theirs", "game");
  fs.mkdirSync(theirs, { recursive: true });
  fs.copyFileSync(path.join(mine, SHARE_FILE), path.join(theirs, SHARE_FILE));
  addNote(theirs, "levels are JSON files in Assets/Levels.", "manual");
  assert.equal(newSharedNotes(theirs).length, 1, "what they already know is not offered again");
  assert.equal(importProject(theirs), 1);
  assert.equal(importProject(theirs), 0);
  assert.deepEqual(notes(theirs).map((n) => n.source), ["manual", "shared"]);
  fs.writeFileSync(path.join(theirs, SHARE_FILE), "not json");
  assert.equal(readShared(theirs), null);
});

test("the project kit is detected from the files, and kit and role become one line of instructions", () => {
  const make = (name: string, files: Record<string, string>) => {
    const dir = path.join(root, name);
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    return dir;
  };
  assert.equal(detectKit(make("u", { "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.0" })), "unity");
  assert.equal(detectKit(make("g", { "project.godot": "" })), "godot");
  assert.equal(detectKit(make("w", { "package.json": '{"dependencies":{"next":"15"}}' })), "web");
  assert.equal(detectKit(make("m", { "package.json": '{"dependencies":{"expo":"52","react":"19"}}' })), "mobile");
  assert.equal(detectKit(make("f", { "pubspec.yaml": "" })), "mobile");
  assert.equal(detectKit(make("n", { "notes.txt": "" })), "none");
  assert.equal(detectKit(path.join(root, "missing")), "none");

  assert.equal(standingPrompt("none", ""), "");
  const both = standingPrompt("unity", "reviewer");
  assert.match(both, /Unity game project[\s\S]*Your role in this workspace is Reviewer/);
  assert.ok(!both.includes("\n"));
  for (const item of [...KITS, ...ROLES]) assert.ok(!/['"`$]/.test(item.prompt), `${item.name}: no characters that need escaping on a command line`);

  const profile = { id: "a", name: "A", color: "#fff", configDir: null };
  assert.match(claudeCommand(profile, "c.json", undefined, false, "Line one.\nLine two."), /^claude --append-system-prompt 'Line one. Line two.' --mcp-config 'c.json'$/);
});

test("the role manager adds, changes and removes roles of the user's own", () => {
  const workspace = ws.load();
  assert.throws(() => ws.saveRole(workspace, { id: "builder", name: "Builder", prompt: "x" }), /cannot be changed/);
  assert.throws(() => ws.saveRole(workspace, { name: "reviewer", prompt: "x" }), /already used/);
  assert.throws(() => ws.saveRole(workspace, { name: "Docs", prompt: "  " }), /instructions|should do/);

  const docs = ws.saveRole(workspace, { name: "Documenter", prompt: 'Keep the "docs"\nin step with `code` and $PATH.' });
  assert.equal(docs.id, "custom-documenter");
  assert.equal(docs.prompt, "Keep the 'docs' in step with 'code' and 'PATH.");
  assert.equal(ws.saveRole(workspace, { name: "Documenter!", prompt: "Other." }).id, "custom-documenter-2");

  workspace.profiles[0].role = docs.id;
  assert.match(standingPrompt("none", docs.id, workspace.roles), /^Keep the 'docs'/);
  ws.saveRole(workspace, { id: docs.id, name: "Docs writer", prompt: "Write docs." });
  assert.equal(ws.load().roles?.find((r) => r.id === docs.id)?.name, "Docs writer");

  ws.removeRole(workspace, docs.id);
  assert.equal(workspace.profiles[0].role, undefined);
  assert.equal(ws.load().roles?.length, 1);
  assert.equal(standingPrompt("none", docs.id, workspace.roles), "");
  assert.throws(() => ws.removeRole(workspace, "tester"), /cannot be removed/);
});

test("role manager edge cases: renaming a role in use, removing an assigned role, duplicate names, a hand-edited file", () => {
  const workspace = ws.load();
  const docs = ws.saveRole(workspace, { name: "Docs", prompt: "Write docs." });
  workspace.profiles[0].role = docs.id;

  // Renaming keeps the id, so the terminal keeps the role under its new name and new instructions.
  ws.saveRole(workspace, { id: docs.id, name: "Docs writer", prompt: "Write good docs." });
  assert.equal(ws.load().profiles[0].role, docs.id);
  assert.equal(standingPrompt("none", ws.load().profiles[0].role, ws.load().roles), "Write good docs.");
  // Changing only the case of its own name is not a clash with itself.
  assert.equal(ws.saveRole(workspace, { id: docs.id, name: "docs WRITER", prompt: "Write good docs." }).name, "docs WRITER");

  // Duplicate names are refused whatever the case or spacing, against built-in roles too.
  for (const name of ["  docs   writer ", "MANAGER", "No role", "builder"]) {
    assert.throws(() => ws.saveRole(workspace, { name, prompt: "x" }), /already used/, name);
  }
  assert.throws(() => ws.saveRole(workspace, { id: "custom-gone", name: "Gone", prompt: "x" }), /not in this workspace/);
  assert.throws(() => ws.saveRole(workspace, { name: "\u0000\t ", prompt: "x" }), /Give the role a name/);
  assert.throws(() => ws.saveRole(workspace, { name: "Long", prompt: "x".repeat(2001) }), /under 2000/);

  // Removing a role a terminal has (running or not) leaves that terminal with no role from its next start.
  ws.removeRole(workspace, docs.id);
  assert.equal(ws.load().profiles[0].role, undefined);
  assert.equal(standingPrompt("none", docs.id, ws.load().roles), "");

  // A hand-edited workspace.json: bad entries are ignored, never crash, and cannot replace a built-in role.
  const broken: any = { ...ws.load(), roles: [null, 7, { id: "builder", name: "Fake", prompt: "Do harm." }, { id: "custom-ok", name: "Ok", prompt: 'Say "hi"\u2019; $x' }] };
  assert.equal(standingPrompt("none", "builder", broken.roles), standingPrompt("none", "builder"));
  assert.equal(standingPrompt("none", "custom-ok", broken.roles), "Say 'hi''; 'x");
  assert.equal(standingPrompt("none", "custom-ok", "not a list"), "");
  ws.saveRole(broken, { name: "Fresh", prompt: "New." });
  assert.deepEqual(broken.roles.map((r: any) => r.id), ["custom-ok", "custom-fresh"]);
});

test("a custom role with curly quotes stays one argument on the PowerShell command line", { skip: process.platform !== "win32" }, async () => {
  const prompt = "Don\u2019t stop\u2018; Write-Output pwned; \u2019 and \u201cquote\u201d it\u2019s fine";
  const command = claudeCommand({ id: "a", name: "A", color: "#fff", configDir: null }, "c.json", undefined, false, standingPrompt("none", "custom-x", [{ id: "custom-x", name: "X", prompt: cleanRolePrompt(prompt) }]));
  // PowerShell's own parser says how many pieces the command line has; the role text must be exactly one.
  const script = `$e=$null;$t=$null;$a=[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$t,[ref]$e);` +
    `if($e.Count){'ERR'}else{$a.EndBlock.Statements[0].PipelineElements[0].CommandElements.Count}`;
  const { spawnSync } = await import("node:child_process");
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: command, encoding: "utf8" });
  assert.equal(out.stdout.trim(), "5", `claude --append-system-prompt <text> --mcp-config <file>: ${command}`);
});

/** A stand-in for Ollama's embedding endpoint: texts about the same subject get the same direction. */
function fakeEmbedder(): Promise<{ url: string; calls: number[]; close: () => void }> {
  const subjects = [/deploy|ship|release|docker/i, /database|postgres|sql/i, /jump|player|enemy|level/i];
  const calls: number[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { input } = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(input.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ embeddings: input.map((text: string) => [...subjects.map((s) => (s.test(text) ? 1 : 0)), 0.05]) }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, calls, close: () => { server.close(); server.closeAllConnections(); } });
  }));
}

test("search finds notes by meaning when an embedding model is available, and by words when not", async (t) => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  addNote(project, "Deploys with Docker on port 8080", "manual");
  addNote(project, "Postgres holds the orders table", "manual");
  const brain = new Brain(() => ws.sources(ws.load()));
  brain.update();

  const plain = await brain.searchSmart("how do we ship it");
  assert.equal(plain.byMeaning, false, "no embedding model: words only");
  assert.equal(plain.matches.length, 0, "no shared word, so nothing is found");

  const embedder = await fakeEmbedder();
  t.after(() => embedder.close());
  process.env.OLLAMA_HOST = embedder.url;
  meaning.reset();
  const smart = await brain.searchSmart("how do we ship it");
  assert.equal(smart.byMeaning, true);
  assert.deepEqual(smart.matches.map((m) => m.text), ["Deploys with Docker on port 8080"]);
  await brain.searchSmart("how do we ship it");
  assert.deepEqual(embedder.calls, [3], "vectors are cached, so the model is asked once");
  assert.ok(fs.existsSync(path.join(root, "home", "brain", "vectors.json")));
});

test("unfinished work is listed with the open project first", () => {
  const shop = path.join(root, "shop"), blog = path.join(root, "blog");
  const claude = path.join(root, "claude-default");
  const write = (folder: string, id: string, title: string) => {
    const dir = path.join(claude, "projects", folder.replace(/[^A-Za-z0-9]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
      { type: "ai-title", aiTitle: title },
      { type: "user", cwd: folder, timestamp: `2026-10-0${id.length}T09:00:00Z`, message: { role: "user", content: [{ type: "text", text: "please do it" }] } },
    ].map((l) => JSON.stringify(l)).join("\n"));
  };
  write(blog, "a", "Blog comments");
  write(shop, "bb", "Cart total");
  write(shop, "ccc", "Finished thing");
  const brain = new Brain(() => ws.sources(ws.load()));
  brain.update();
  const labels: Record<string, sorting.Labels> = {};
  for (const s of brain.sessions) labels[sorting.sessionKey(s)] = { type: "bug fix", typeConfidence: 0.9, finished: s.title === "Finished thing" ? 0.9 : 0.1, decision: 0, modified: s.modified };
  sorting.saveLabels(labels);
  brain.update();
  assert.deepEqual(brain.unfinished(shop).map((u) => `${u.title}:${u.here}`), ["Cart total:true", "Blog comments:false"]);
});

test("a newer release is recognised by its version number", () => {
  assert.equal(newer("v0.10.0", "0.9.1"), true);
  assert.equal(newer("0.5.0", "0.5.0"), false);
  assert.equal(newer("0.4.9", "0.5.0"), false);
  assert.equal(newer("1.0.0", "0.99.99"), true);
  assert.equal(newer("garbage", "0.5.0"), false);
});

test("a raw speech-to-text transcript is cleaned up into a tidier prompt", () => {
  assert.equal(cleanupTranscript("  um so uh fix the the login bug  "), "So fix the login bug.");
  assert.equal(cleanupTranscript("add a a retry button please"), "Add a retry button please.");
  assert.equal(cleanupTranscript("is this already done"), "Is this already done.");
  assert.equal(cleanupTranscript("it works!"), "It works!");
  assert.equal(cleanupTranscript("   "), "");
  assert.equal(cleanupTranscript(""), "");
});
