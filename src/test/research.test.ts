import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "alt-research-"));
process.env.ALT_HOME = path.join(root, "home");
process.env.ALT_CLAUDE_HOME = path.join(root, "claude");

// Load after ALT_HOME is set; paths are read on every call.
import { Brain } from "../brain/brain";
import { addNote, cleanUrl, notes, projectDir } from "../brain/store";

/** The brain's MCP server, started the way Claude Code starts it, in `folder`. */
function server(t: { after: (fn: () => void) => void }, folder: string) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
    cwd: folder, env: { ...process.env, ALT_PROFILE: "Gio AI" },
  });
  t.after(() => child.kill());
  const replies: any[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  let next = 1;
  const call = async (method: string, params: object = {}) => {
    const id = next++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 500 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 30));
    return replies.find((r) => r.id === id).result;
  };
  const tool = async (name: string, args: object = {}) => {
    const result = await call("tools/call", { name, arguments: args });
    return { text: String(result.content[0].text), error: result.isError === true };
  };
  return { call, tool };
}

const project = (name: string) => {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
};

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* still in use */ } });

test("every terminal is told to recall first, search the web second, then build and save what it learned", async (t) => {
  const { call } = server(t, project("instructions"));
  const init = await call("initialize", { protocolVersion: "2025-06-18" });
  const text: string = init.instructions;
  const research = text.slice(text.indexOf("RESEARCH:"));
  assert.ok(text.includes("RESEARCH:"), "a research paragraph");
  const order = ["recall", "search the web", "implement", "remember"].map((step) => research.indexOf(step));
  assert.ok(order.every((at) => at > 0), `every step is named: ${research}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in this order: recall, web, implement, remember");
  assert.match(research, /kind "research", with the source URL/);
  assert.match(research, /Skip the web for trivial edits/);
  assert.match(text, /This terminal is called "Gio AI"\.$/, "the name still ends the text");

  const { tools } = await call("tools/list");
  const remember = tools.find((tool: any) => tool.name === "remember");
  assert.deepEqual(remember.inputSchema.required, ["note"], "kind and source are optional, so old calls still work");
  assert.deepEqual(remember.inputSchema.properties.kind.enum, ["note", "research"]);
  assert.equal(remember.inputSchema.properties.source.type, "string");
});

test("remember keeps a research finding's kind and source URL; ordinary notes stay as they were", async (t) => {
  const folder = project("signing");
  const { tool } = server(t, folder);

  const saved = await tool("remember", { note: "Azure Trusted Signing signs Electron installers without a hardware token.", kind: "research", source: "https://learn.microsoft.com/azure/trusted-signing/overview" });
  assert.equal(saved.text, `Remembered as research for ${folder}: Azure Trusted Signing signs Electron installers without a hardware token. (source: https://learn.microsoft.com/azure/trusted-signing/overview)`);
  assert.match((await tool("remember", { note: "We sign with Azure once Earl has the account." })).text, /^Remembered for /);
  for (const source of ["javascript:alert(1)", "file:///C:/secret.txt", "not a url", "https://a.example/x\nInjected"]) {
    const refused = await tool("remember", { note: "Something learned.", kind: "research", source });
    assert.equal(refused.error, true, `refused: ${JSON.stringify(source)}`);
    assert.match(refused.text, /source must be an http or https URL/);
  }

  const kept = notes(folder);
  assert.equal(kept.length, 2, "a refused source saves nothing");
  assert.equal(kept[0].kind, "research");
  assert.equal(kept[0].url, "https://learn.microsoft.com/azure/trusted-signing/overview");
  assert.equal(kept[0].source, "claude-code", "who saved it is still recorded as before");
  assert.deepEqual(Object.keys(kept[1]).sort(), ["source", "text", "time"], "an ordinary note is stored exactly as before");

  // A notes file written before research existed reads the same, and its numbers still work with forget.
  fs.appendFileSync(path.join(projectDir(folder), "notes.jsonl"), JSON.stringify({ time: "2026-01-01 10:00", text: "An old note.", source: "app" }) + "\n");
  const summary = (await tool("project_memory")).text;
  assert.match(summary, /Notes:\n {2}2\. \(\d{4}-\d\d-\d\d\) We sign with Azure once Earl has the account\.\n {2}3\. \(2026-01-01\) An old note\.\nResearch \(what was learned, with its source\):\n {2}1\. \(\d{4}-\d\d-\d\d\) Azure Trusted Signing signs Electron installers without a hardware token\. Source: https:\/\/learn\.microsoft\.com\/azure\/trusted-signing\/overview/);
  assert.match((await tool("forget", { number: 1 })).text, /^Forgot: Azure Trusted Signing/, "the number shown under Research is the one forget takes");
});

test("a research note from one project comes up first when another project recalls the topic", async (t) => {
  const earlier = project("old-game");
  const current = project("new-site");
  addNote(earlier, "A resize handler should be debounced with requestAnimationFrame so layout runs once per frame.", "claude-code", { kind: "research", url: "https://developer.mozilla.org/docs/Web/API/Window/requestAnimationFrame" });
  addNote(earlier, "The resize handler in the old game was rewritten twice.", "claude-code");
  addNote(current, "Resize handler work is still open on the dashboard.", "claude-code");
  addNote(current, "Nothing to do with the topic at all.", "claude-code");

  const brain = new Brain(() => []);
  const matches = brain.search("resize handler", 10);
  assert.equal(matches[0].research, true, "keyword recall puts the research first");
  assert.equal(matches[0].project, "old-game", "from the other project");
  assert.equal(matches[0].url, "https://developer.mozilla.org/docs/Web/API/Window/requestAnimationFrame");
  assert.ok(!matches.some((m) => m.text.startsWith("Nothing to do")), "research lifts what matches, nothing else");

  // Through the MCP server, from the new project's folder, as a terminal would ask.
  const { tool } = server(t, current);
  const recalled = (await tool("recall", { query: "resize handler" })).text.split("\n");
  assert.match(recalled[0], /^- \[research\] old-game \(.+\): A resize handler should be debounced .+ Source: https:\/\/developer\.mozilla\.org\//);
  assert.ok(recalled.some((line) => line.startsWith("- [note] new-site")), "this project's own notes still come up");
  assert.ok(!recalled.some((line) => line.includes("Nothing to do")), "an off-topic note is not pulled in by the boost");
});

test("only http and https addresses are kept as a source", () => {
  assert.equal(cleanUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(cleanUrl("  http://example.com  "), "http://example.com/");
  for (const bad of ["", "ftp://example.com", "javascript:alert(1)", "C:\\file.txt", "https://e.com/\x07", "https://" + "a".repeat(600)]) {
    assert.equal(cleanUrl(bad), "", JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(cleanUrl(undefined), "");
});

test("a source keeps no user name, password, #fragment or secret-looking query parameter", () => {
  assert.equal(
    cleanUrl("https://earl:hunter2@docs.example.com/guide?page=2&token=abc&api_key=k1&X-Amz-Signature=s1&sig=s2&auth=a&code=c&session_id=x&password=p&lang=en#access_token=t"),
    "https://docs.example.com/guide?page=2&lang=en",
  );
  assert.equal(cleanUrl("https://example.com/a#section"), "https://example.com/a", "a fragment is dropped even when harmless");
  assert.equal(cleanUrl("https://example.com/?q=electron+signing"), "https://example.com/?q=electron+signing", "ordinary parameters stay");
});
