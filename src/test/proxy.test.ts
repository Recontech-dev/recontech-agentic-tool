import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";

import { FreeProxy, PRESETS, Provider, simplifySchema } from "../proxy/server";
import { StreamTranslator, toAnthropicMessage, toOpenAI } from "../proxy/translate";

test("a Claude Code request becomes an OpenAI request, tools and tool results included", () => {
  const body: any = toOpenAI({
    system: [{ type: "text", text: "You are helpful." }],
    max_tokens: 64000,
    stream: true,
    tools: [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }, { type: "web_search_20260209", name: "web_search" }],
    tool_choice: { type: "any" },
    messages: [
      { role: "user", content: "open a.txt" },
      { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Reading." }, { type: "tool_use", id: "t1", name: "Read", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hello" }] }, { type: "text", text: "now summarise" }] },
    ],
  }, "some-model", 8192);
  assert.equal(body.model, "some-model");
  assert.equal(body.max_tokens, 8192, "capped at what the provider accepts");
  assert.deepEqual(body.messages.map((m: any) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.deepEqual(body.messages[2].tool_calls[0].function, { name: "Read", arguments: '{"path":"a.txt"}' });
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "t1", content: "hello" });
  assert.equal(body.messages[4].content, "now summarise");
  assert.equal(body.tools.length, 1, "built-in server tools are left out");
  assert.equal(body.tool_choice, "required");
});

test("streamed text and tool calls become Anthropic stream events", () => {
  const t = new StreamTranslator("m");
  const events = [
    ...t.push({ choices: [{ delta: { role: "assistant", content: "Let me " } }] }),
    ...t.push({ choices: [{ delta: { content: "look." } }] }),
    ...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"pa' } }] } }] }),
    ...t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
    ...t.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 7 } }),
    ...t.finish(),
  ];
  assert.deepEqual(events.map((e) => e.event), [
    "message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop",
  ]);
  const tool: any = events[5].data;
  assert.deepEqual(tool.content_block, { type: "tool_use", id: "call_1", name: "Read", input: {} });
  assert.equal(events.filter((e) => (e.data as any).delta?.type === "input_json_delta").map((e) => (e.data as any).delta.partial_json).join(""), '{"path":"a.txt"}');
  assert.equal((events[9].data as any).delta.stop_reason, "tool_use");
  assert.equal((events[9].data as any).usage.output_tokens, 7);
  assert.deepEqual(t.finish(), [], "finishing twice sends nothing more");
});

test("a complete answer and a strict schema are converted", () => {
  const message: any = toAnthropicMessage({ id: "x", choices: [{ message: { content: "hi", tool_calls: [{ id: "c", function: { name: "Read", arguments: "{bad json" } }] }, finish_reason: "length" }] }, "m");
  assert.deepEqual(message.content, [{ type: "text", text: "hi" }, { type: "tool_use", id: "c", name: "Read", input: {} }]);
  assert.equal(message.stop_reason, "max_tokens");
  assert.deepEqual(
    simplifySchema({ $schema: "x", type: "object", additionalProperties: false, properties: { mode: { const: "fast", default: "fast" }, n: { type: "integer", exclusiveMinimum: 0 } } }),
    { type: "object", properties: { mode: { enum: ["fast"] }, n: { type: "integer" } } },
  );
});

/** A stand-in provider. The API key decides how it behaves. */
function fakeProvider(): Promise<{ url: string; seen: any[]; close: () => void }> {
  const seen: any[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const key = String(req.headers.authorization).replace("Bearer ", "");
    seen.push({ key, body });
    if (key === "badkey") {
      res.writeHead(400, { "content-type": "application/json" });
      return void res.end('{"error":{"message":"API key not valid. Please pass a valid API key."}}');
    }
    if (key === "limited") {
      res.writeHead(429, { "retry-after": "45", "content-type": "application/json" });
      return void res.end('{"error":{"message":"quota exceeded"}}');
    }
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ id: "1", choices: [{ message: { content: `from ${key}` }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "from " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: key }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, seen, close: () => server.close() });
  }));
}

test("the bridge moves to the next free provider when one is limited, and guards its address", async () => {
  const upstream = await fakeProvider();
  const providers: Provider[] = [
    { id: "a", name: "First", baseUrl: upstream.url, model: "m1", key: "limited", maxOutput: 100 },
    { id: "b", name: "Second", baseUrl: upstream.url, model: "m2", key: "second-key", maxOutput: 100, extraBody: { provider: { data_collection: "deny" } } },
    { id: "c", name: "No key", baseUrl: upstream.url, model: "m3", key: "", maxOutput: 100 },
  ];
  const proxy = new FreeProxy(() => providers);
  await proxy.listen();
  const call = (body: object, headers: Record<string, string> = { "x-api-key": proxy.token }, path = "/v1/messages") =>
    fetch(`http://127.0.0.1:${proxy.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const ask = { model: "claude-x", max_tokens: 5000, messages: [{ role: "user", content: "hi" }] };

  const plain: any = await (await call(ask)).json();
  assert.equal(plain.content[0].text, "from second-key");
  assert.equal(plain.role, "assistant");
  assert.equal(upstream.seen[1].body.model, "m2");
  assert.equal(upstream.seen[1].body.max_tokens, 100);
  assert.deepEqual(upstream.seen[1].body.provider, { data_collection: "deny" }, "the provider's privacy option is sent with every request");
  assert.deepEqual(PRESETS.openrouter.extraBody, { provider: { data_collection: "deny" } });
  assert.ok(Object.values(PRESETS).every((p) => p.privacy.startsWith("Privacy:")), "every provider tells the user how it treats data");

  const streamed = await (await call({ ...ask, stream: true })).text();
  assert.match(streamed, /event: message_start[\s\S]*"text":"from "[\s\S]*"text":"second-key"[\s\S]*"stop_reason":"end_turn"[\s\S]*event: message_stop/);
  assert.deepEqual(upstream.seen.map((s) => s.key), ["limited", "second-key", "second-key"], "the limited provider is skipped while it cools down");

  const status = proxy.status();
  assert.match(status.providers[0].state, /^back in \d+s$/);
  assert.equal(status.providers[1].served, 2);
  assert.equal(status.providers[2].state, "no key");
  assert.match(status.recent[1].skipped[0], /First: limit reached/);

  assert.equal((await call(ask, { "x-api-key": "wrong" })).status, 401);
  assert.equal((await call(ask, { authorization: `Bearer ${proxy.token}` })).status, 200);
  const count: any = await (await call(ask, undefined, "/v1/messages/count_tokens")).json();
  assert.ok(count.input_tokens > 0);

  providers[1].key = "limited";
  const none = await call(ask);
  assert.equal(none.status, 429);
  assert.match(((await none.json()) as any).error.message, /No free provider could answer/);

  // A wrong key is reported at once with an error Claude Code does not keep retrying.
  providers[0].key = "badkey";
  providers[1].key = "";
  const fresh = new FreeProxy(() => providers);
  await fresh.listen();
  const refused = await fetch(`http://127.0.0.1:${fresh.port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": fresh.token }, body: JSON.stringify(ask) });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as any).error.message, /First: API key rejected/);
  fresh.close();
  proxy.close();
  upstream.close();
});
