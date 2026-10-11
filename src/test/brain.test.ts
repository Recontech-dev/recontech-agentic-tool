import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "alt-test-"));
let root = "";

beforeEach(() => {
  root = tmp();
  process.env.ALT_HOME = path.join(root, "home");
  process.env.ALT_CLAUDE_HOME = path.join(root, "claude-default");
});

// Load after ALT_HOME is set; paths are read on every call, so one import serves every test.
import { Brain } from "../brain/brain";
import { findTokens, redact } from "../brain/redact";
import { readTranscript, typedText } from "../brain/sessions";
import { addNote, label, notes, projectDir, removeNote, tree } from "../brain/store";
import * as ws from "../brain/workspace";

function transcript(configDir: string, folder: string, id: string, lines: object[]): string {
  const dir = path.join(configDir, "projects", folder.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const user = (text: string, cwd: string, extra = {}) => ({
  type: "user", cwd, timestamp: "2026-10-10T09:00:00Z", message: { role: "user", content: [{ type: "text", text }] }, ...extra,
});
const assistant = (text: string, cwd: string) => ({
  type: "assistant", cwd, timestamp: "2026-10-10T09:05:00Z", message: { role: "assistant", content: [{ type: "text", text }] },
});

test("notes are kept per project, masked, and can be removed", () => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  const key = "sk-" + "ant-api03-" + "a".repeat(30);
  assert.equal(addNote(project, `Deploy key is ${key}`, "manual"), "Deploy key is [secret removed]");
  addNote(project, "Uses Postgres 16", "manual");
  assert.deepEqual(notes(project).map((n) => n.text), ["Deploy key is [secret removed]", "Uses Postgres 16"]);
  assert.equal(removeNote(project, 1)?.text, "Deploy key is [secret removed]");
  assert.equal(removeNote(project, 9), null);
  assert.equal(tree()[0].name, "shop");
  assert.match(path.basename(projectDir(project)), /^shop-[0-9a-f]{8}$/);
});

test("secrets are found and plain text is left alone", () => {
  assert.deepEqual(findTokens("gsk_" + "b".repeat(30)), ["gsk_" + "b".repeat(30)]);
  assert.equal(redact("password: hunter2secret"), "password: [secret removed]");
  assert.equal(redact("The token limit is 4096."), "The token limit is 4096.");
});

test("a Claude Code transcript becomes a session with title, prompts and words", () => {
  const folder = path.join(root, "shop");
  const file = transcript(path.join(root, "claude"), folder, "s1", [
    { type: "ai-title", aiTitle: "Speed up the login endpoint" },
    user("<ide_opened_file>x.py</ide_opened_file>The login endpoint is slow, can you profile it?", folder),
    { type: "user", cwd: folder, message: { role: "user", content: [{ type: "tool_result", content: "ignored" }] } },
    assistant("The login query has no index on email; adding an index fixes it.", folder),
    user("ignore me", folder, { isSidechain: true }),
    user("add the index migration please", folder),
  ]);
  const session = readTranscript(file, "Work")!;
  assert.equal(session.title, "Speed up the login endpoint");
  assert.equal(session.folder, folder);
  assert.deepEqual(session.prompts, ["The login endpoint is slow, can you profile it?", "add the index migration please"]);
  assert.equal(session.replies, 1);
  assert.ok(session.keywords.includes("login") && session.keywords.includes("index"));
  assert.equal(typedText("<system-reminder>hidden</system-reminder> hello"), "hello");
  assert.equal(label("Uses Flask with Postgres"), "Flask Postgres");
});

test("the brain finds sessions from every profile and draws them with notes and topics", () => {
  const shop = path.join(root, "shop");
  fs.mkdirSync(shop);
  const workspace = ws.load();
  workspace.folder = shop;
  const work = ws.addProfile(workspace, "Work");
  transcript(path.join(root, "unused"), shop, "x", []);
  transcript(work.configDir!, shop, "s1", [user("why is the docker build slow", shop), assistant("The docker cache is not used.", shop)]);
  transcript(work.configDir!, path.join(root, "blog"), "s2", [user("set up docker for the blog", path.join(root, "blog"))]);
  addNote(shop, "Docker images are built in CI", "manual");

  const brain = new Brain(() => ws.sources(workspace));
  assert.equal(brain.update(), true);
  assert.equal(brain.update(), false, "unchanged transcripts are not read again");
  assert.equal(brain.sessions.length, 2);
  assert.equal(brain.sessions[0].profile, "Work");

  const kinds = (k: string) => brain.graph(shop).nodes.filter((n) => n.kind === k);
  assert.equal(kinds("project").length, 2);
  assert.equal(kinds("project").filter((n) => n.open).length, 1);
  assert.equal(kinds("session").length, 2);
  assert.ok(kinds("topic").some((n) => n.label === "docker"));

  const found = brain.search("docker build");
  assert.equal(found[0].kind, "session");
  assert.ok(found.some((m) => m.kind === "note"));
  assert.match(brain.projectSummary(shop), /Docker images are built in CI[\s\S]*why is the docker build slow/);
});

test("profiles: own config folder, unique names, at most six, never zero", () => {
  const workspace = ws.load();
  assert.equal(workspace.profiles[0].configDir, null);
  const a = ws.addProfile(workspace, "Work");
  assert.ok(fs.existsSync(a.configDir!));
  assert.throws(() => ws.addProfile(workspace, "work"), /already used/);
  for (const name of ["B", "C", "D", "E"]) ws.addProfile(workspace, name);
  assert.throws(() => ws.addProfile(workspace, "F"), /at most 6/);
  assert.equal(ws.load().profiles.length, 6);
  for (const p of [...workspace.profiles].slice(1)) ws.removeProfile(workspace, p.id);
  assert.throws(() => ws.removeProfile(workspace, workspace.profiles[0].id), /at least one/);
});

test("the MCP server answers like Claude Code expects and shares the brain", async () => {
  const project = path.join(root, "shop");
  fs.mkdirSync(project);
  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
    cwd: project, env: { ...process.env, ALT_HOME: process.env.ALT_HOME },
  });
  const replies: any[] = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  const send = (message: object) => server.stdin.write(JSON.stringify(message) + "\n");
  const waitFor = async (id: number) => {
    for (let i = 0; i < 100 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 30));
    return replies.find((r) => r.id === id);
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  const init = await waitFor(1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /long-term memory/);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((await waitFor(2)).result.tools.map((t: any) => t.name), ["remember", "recall", "project_memory", "forget"]);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { note: "Payments use Stripe test mode" } } });
  assert.match((await waitFor(3)).result.content[0].text, /Remembered/);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall", arguments: { query: "stripe" } } });
  assert.match((await waitFor(4)).result.content[0].text, /Payments use Stripe test mode/);
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "remember", arguments: {} } });
  assert.equal((await waitFor(5)).result.isError, true);
  send({ jsonrpc: "2.0", id: 6, method: "nope" });
  assert.equal((await waitFor(6)).error.code, -32601);
  server.kill();
  assert.equal(notes(project)[0].source, "claude-code");
});

import { claudeCommand, profileEnv } from "../brain/launch";

test("first start picks up Claude Code folders that are already signed in", () => {
  for (const name of [".claude-account1", ".claude-account2", ".claude-old"]) fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, ".claude-notafolder"), "");
  const workspace = ws.load();
  assert.deepEqual(workspace.profiles.map((p) => p.name), ["Main", "Account 1", "Account 2", "old"]);
  assert.equal(workspace.profiles[1].configDir, path.join(root, ".claude-account1"));
  assert.throws(() => ws.addProfile(workspace, { name: "Again", configDir: path.join(root, ".claude-account1") }), /already uses/);
});

test("an Ollama profile runs Claude Code on the local model, offline", () => {
  const workspace = ws.load();
  assert.throws(() => ws.addProfile(workspace, { name: "Offline", kind: "ollama" }), /Ollama model/);
  const offline = ws.addProfile(workspace, { name: "Offline", kind: "ollama", model: "qwen3:8b" });
  const env = profileEnv(offline, { PATH: "x", ELECTRON_RUN_AS_NODE: "1", ANTHROPIC_API_KEY: "real", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDECODE: "1" });
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, "settings of an outer Claude Code session are not inherited");
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:11434");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.CLAUDE_CONFIG_DIR, offline.configDir);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.match(claudeCommand(offline, "cfg.json"), /^claude --model 'qwen3:8b' --mcp-config 'cfg.json'$/);

  const main = workspace.profiles[0];
  const mainEnv = profileEnv(main, { CLAUDE_CONFIG_DIR: "elsewhere", ANTHROPIC_API_KEY: "kept" });
  assert.equal(mainEnv.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(mainEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(mainEnv.ANTHROPIC_API_KEY, "kept");
  assert.equal(claudeCommand(main, "c.json", "abc-123"), "claude --resume abc-123 --mcp-config 'c.json'");
  assert.equal(claudeCommand(main, "c.json", "bad; rm -rf"), "claude --mcp-config 'c.json'");
});

test("session circles carry their profile colour and how to resume them", () => {
  const shop = path.join(root, "shop");
  const workspace = ws.load();
  const work = ws.addProfile(workspace, "Work");
  transcript(work.configDir!, shop, "abc", [user("fix the cart total", shop)]);
  const brain = new Brain(() => ws.sources(workspace));
  brain.update();
  const session = brain.graph(shop, { Work: "#123456" }).nodes.find((n) => n.kind === "session")!;
  assert.equal(session.color, "#123456");
  assert.deepEqual(session.resume, { profile: "Work", id: "abc", folder: shop });
});

import * as sorting from "../brain/sorting";

test("smart sorting labels settled sessions and the brain uses the labels", async () => {
  const shop = path.join(root, "shop");
  const workspace = ws.load();
  const file = transcript(path.join(root, "claude-default"), shop, "s1", [
    { type: "ai-title", aiTitle: "Fix the cart total" }, user("the cart total is wrong", shop), assistant("Found the rounding bug.", shop),
  ]);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  transcript(path.join(root, "claude-default"), shop, "s2", [user("still working on this", shop)]);

  const brain = new Brain(() => ws.sources(workspace));
  brain.update();
  const todo = sorting.pending(brain.sessions, sorting.loadLabels());
  assert.deepEqual(todo.map((s) => s.id), ["s1"], "a session still being worked on waits");
  assert.match(sorting.describe(todo[0]), /Title: Fix the cart total[\s\S]*- the cart total is wrong/);

  const asked: any[] = [];
  const fake: sorting.Model = {
    async systemOne(state, questions) {
      asked.push({ state, questions });
      return { answers: { type: { choice: "bug fix", confidence: 0.8 }, finished: { noul: 0.2 }, decision: { noul: 0.7 } } };
    },
  };
  const labels = { [sorting.sessionKey(todo[0])]: await sorting.classify(fake, todo[0]) };
  sorting.saveLabels(labels);
  assert.deepEqual(asked.map((a) => Object.keys(a.questions)), [["type", "decision"], ["finished"]]);
  assert.equal(asked[1].state, "The user's last message: the cart total is wrong\nThe assistant's last reply: Found the rounding bug.");
  assert.equal(sorting.isUnfinished({ ...labels[sorting.sessionKey(todo[0])], finished: null }), false, "no ending, no guess");
  assert.equal(sorting.pending(brain.sessions, sorting.loadLabels()).length, 0);

  assert.equal(brain.update(), true, "new labels count as a change");
  const node = brain.graph(shop).nodes.find((n) => n.kind === "session" && n.text === "Fix the cart total")!;
  assert.equal(node.tag, "bug fix");
  assert.equal(node.unfinished, true);
  assert.match(node.detail, /bug fix · unfinished/);
  assert.match(brain.projectSummary(shop), /Unfinished work[\s\S]*Fix the cart total/);
  assert.match(brain.search("cart")[0].text, /^\[bug fix, unfinished\] Fix the cart total/);

  fs.utimesSync(file, new Date(), new Date());
  brain.update();
  assert.equal(brain.graph(shop).nodes.find((n) => n.text === "Fix the cart total")!.tag, undefined, "labels of an older transcript are not shown");
});

test("sign-in folders found later are offered once, added on request, or dismissed", () => {
  const workspace = ws.load();
  ws.save(workspace);
  for (const name of [".claude-account1", ".claude-account2"]) fs.mkdirSync(path.join(root, name));
  const later = ws.load();
  assert.deepEqual(later.profiles.map((p) => p.name), ["Main"], "an existing workspace is not changed behind the user's back");
  assert.equal(ws.unusedClaudeFolders(later).length, 2);
  assert.equal(ws.adoptFolders(later), 2);
  assert.deepEqual(ws.load().profiles.map((p) => p.name), ["Main", "Account 1", "Account 2"]);
  assert.equal(ws.load().profiles[1].configDir, path.join(root, ".claude-account1"));
  assert.equal(ws.unusedClaudeFolders(later).length, 0);

  fs.mkdirSync(path.join(root, ".claude-account3"));
  ws.dismissFolders(later);
  assert.equal(ws.unusedClaudeFolders(ws.load()).length, 0, "dismissed folders are not offered again");
});

import { signedInAs } from "../brain/launch";

test("a profile reports the email it is signed in with, and nothing else", () => {
  const workspace = ws.load();
  const work = ws.addProfile(workspace, "Work");
  assert.equal(signedInAs(work), "");
  fs.writeFileSync(path.join(work.configDir!, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com", accessToken: "never-read" } }));
  fs.writeFileSync(path.join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com" } }));
  if (process.platform !== "darwin") assert.equal(signedInAs(work), "", "an email without a saved login does not count");
  fs.writeFileSync(path.join(work.configDir!, ".credentials.json"), "{}");
  fs.mkdirSync(path.join(root, "claude-default"), { recursive: true });
  fs.writeFileSync(path.join(root, "claude-default", ".credentials.json"), "{}");
  assert.equal(signedInAs(work), "work@example.com");
  assert.equal(signedInAs(workspace.profiles[0]), "me@example.com");
  assert.equal(signedInAs(ws.addProfile(workspace, { name: "Offline", kind: "ollama", model: "m" })), "");
});

test("the Free models terminal is one special profile that talks to the bridge", () => {
  const workspace = ws.load();
  ws.enableFreeProfile(workspace);
  ws.enableFreeProfile(workspace);
  const free = workspace.profiles.filter((p) => p.kind === "free");
  assert.equal(free.length, 1);
  const env = profileEnv(free[0], { ANTHROPIC_API_KEY: "real" }, { url: "http://127.0.0.1:5555", token: "secret-token" });
  assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:5555");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "secret-token");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.CLAUDE_CONFIG_DIR, free[0].configDir);
  assert.match(claudeCommand(free[0], "c.json"), /^claude --model free-models --mcp-config 'c.json'$/);
  assert.equal(signedInAs(free[0]), "");
});
