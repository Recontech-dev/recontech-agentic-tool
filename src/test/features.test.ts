import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";

import { Brain } from "../brain/brain";
import { KITS, ROLES, detectKit, standingPrompt } from "../brain/kits";
import { claudeCommand } from "../brain/launch";
import * as meaning from "../brain/meaning";
import { SHARE_FILE, exportProject, importProject, newSharedNotes, readShared } from "../brain/share";
import * as sorting from "../brain/sorting";
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
