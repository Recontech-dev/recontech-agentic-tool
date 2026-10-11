import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { Control, MAX_MESSAGES } from "../main/control";

function setup() {
  const delivered: [string, string][] = [];
  const control = new Control({
    terminals: () => [
      { name: "Work", kind: "claude", running: true },
      { name: "Account 1", kind: "claude", running: true },
      { name: "Free models", kind: "free", running: false },
    ],
    read: async (name, lines) => `screen of ${name}, ${lines} lines`,
    deliver: (name, text) => void delivered.push([name, text]),
    contained: (name) => name === "Free models",
  });
  return { control, delivered };
}

test("terminals can be listed, read and messaged, with a limit on back-and-forth", async (t) => {
  const { control, delivered } = setup();
  await control.listen();
  t.after(() => control.close());
  const call = async (route: string, body: object, token = control.token) => {
    const response = await fetch(`http://127.0.0.1:${control.port}${route}`, {
      method: "POST", headers: { "content-type": "application/json", "x-alt-token": token }, body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };

  assert.equal((await call("/terminals", {}, "wrong")).status, 401);
  assert.deepEqual((await call("/terminals", {})).data.terminals.map((t: any) => t.name), ["Work", "Account 1", "Free models"]);

  assert.equal((await call("/read", { name: "work", lines: 20 })).data.text, "screen of Work, 20 lines");
  assert.equal((await call("/read", { name: "account" })).data.name, "Account 1", "a clear part of the name is enough");
  assert.equal((await call("/read", { name: "nobody" })).status, 404);
  assert.equal((await call("/read", { name: "Free models" })).status, 409);
  const fenced = await call("/read", { from: "Free models", name: "Work" });
  assert.equal(fenced.status, 403, "a contained terminal cannot read the others");
  assert.match(fenced.data.error, /container/);

  const sent = await call("/send", { from: "Account 1", to: "Work", message: "Please review src/app.ts\nand report back." });
  assert.equal(sent.data.delivered, "Work");
  assert.deepEqual(delivered[0], ["Work", '[Message from the "Account 1" terminal] Please review src/app.ts\nand report back.']);
  assert.equal((await call("/send", { from: "Work", to: "Work", message: "x" })).status, 400);
  assert.equal((await call("/send", { from: "Work", to: "Free models", message: "x" })).status, 409);
  assert.equal((await call("/send", { from: "Work", to: "Account 1", message: "  " })).status, 400);

  for (let i = 1; i < MAX_MESSAGES; i++) assert.equal((await call("/send", { from: "Account 1", to: "Work", message: `m${i}` })).status, 200);
  const blocked = await call("/send", { from: "Account 1", to: "Work", message: "one too many" });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /let the user decide/);
  assert.equal((await call("/send", { from: "Work", to: "Account 1", message: "the other direction has its own count" })).status, 200);
  control.close();
});

test("Claude Code reaches the other terminals through the brain's MCP server", async (t) => {
  const { control, delivered } = setup();
  await control.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alt-control-"));
  const controlFile = path.join(dir, "control.json");
  control.writeAddress(controlFile);

  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
    cwd: dir, env: { ...process.env, ALT_HOME: path.join(dir, "home"), ALT_CLAUDE_HOME: path.join(dir, "claude"), ALT_PROFILE: "Account 1", ALT_CONTROL: controlFile },
  });
  t.after(() => {
    server.kill();
    control.close();
  });
  const replies: any[] = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  let next = 1;
  const tool = async (name: string, args: object = {}) => {
    const id = next++;
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    for (let i = 0; i < 500 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 30));
    return replies.find((r) => r.id === id).result;
  };

  const list = await tool("list_terminals");
  assert.match(list.content[0].text, /- Work: claude, running\n- Account 1 \(this terminal\): claude, running\n- Free models: free, not started/);
  assert.match((await tool("read_terminal", { name: "Work", lines: 30 })).content[0].text, /Screen of the "Work" terminal:\nscreen of Work, 30 lines/);
  assert.match((await tool("message_terminal", { to: "Work", message: "Can you check the login test?" })).content[0].text, /Delivered to "Work"/);
  assert.deepEqual(delivered[0], ["Work", '[Message from the "Account 1" terminal] Can you check the login test?']);
  const missing = await tool("message_terminal", { to: "Nobody", message: "hi" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /no terminal named "Nobody"/);

  control.close();
  const closed = await tool("list_terminals");
  assert.equal(closed.isError, true);
  assert.match(closed.content[0].text, /not answering/);
  server.kill();
});

test("a contained terminal gets no memory and no way to read others", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alt-contained-"));
  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
    cwd: dir, env: { ...process.env, ALT_HOME: path.join(dir, "home"), ALT_CLAUDE_HOME: path.join(dir, "claude"), ALT_PROFILE: "Free models", ALT_CONTAINED: "1" },
  });
  t.after(() => server.kill());
  const replies: any[] = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    replies.push(...lines.filter(Boolean).map((l) => JSON.parse(l)));
  });
  const ask = async (id: number, method: string, params: object = {}) => {
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 500 && !replies.some((r) => r.id === id); i++) await new Promise((r) => setTimeout(r, 30));
    return replies.find((r) => r.id === id).result;
  };
  assert.match((await ask(1, "initialize")).instructions, /runs in a container/);
  assert.deepEqual((await ask(2, "tools/list")).tools.map((x: any) => x.name), ["list_terminals", "message_terminal"]);
  for (const [id, name] of [[3, "project_memory"], [4, "recall"], [5, "read_terminal"], [6, "remember"]] as const) {
    const refused = await ask(id, "tools/call", { name, arguments: { query: "x", name: "Work", note: "x" } });
    assert.equal(refused.isError, true, `${name} is refused`);
  }
  assert.equal(fs.existsSync(path.join(dir, "home", "memory")), false, "nothing was written to memory");
});
