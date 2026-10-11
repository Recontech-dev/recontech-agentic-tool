// Translation between the API Claude Code speaks (Anthropic Messages) and the API free providers
// speak (OpenAI chat completions). Pure functions, so they can be tested without a network.

export interface AnthropicRequest {
  model?: string;
  system?: string | { type: string; text?: string }[];
  messages: { role: "user" | "assistant"; content: string | any[] }[];
  tools?: any[];
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n")
      : "";

/** Build the request for an OpenAI-compatible provider. */
export function toOpenAI(request: AnthropicRequest, model: string, maxOutput: number): Record<string, unknown> {
  const messages: any[] = [];
  const system = textOf(request.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of request.messages ?? []) {
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    if (message.role === "assistant") {
      const text = textOf(blocks);
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue; // only thinking blocks, which other providers cannot read
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must directly follow the assistant message that asked for them, before any new text.
    for (const block of blocks.filter((b) => b.type === "tool_result")) {
      const output = textOf(block.content) || (typeof block.content === "string" ? block.content : "");
      messages.push({ role: "tool", tool_call_id: block.tool_use_id, content: (block.is_error ? "Error: " : "") + (output || "(no output)") });
    }
    const parts: any[] = [];
    for (const block of blocks) {
      if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
      else if (block.type === "image" && block.source?.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } });
      }
    }
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: Math.min(request.max_tokens ?? maxOutput, maxOutput),
    stream: !!request.stream,
  };
  if (request.stream) body.stream_options = { include_usage: true };
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (request.stop_sequences?.length) body.stop = request.stop_sequences.slice(0, 4);

  // Only tools with a schema can be passed on; Anthropic's built-in server tools have none.
  const tools = (request.tools ?? []).filter((t) => t?.name && t.input_schema);
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    const choice = request.tool_choice;
    if (choice?.type === "any") body.tool_choice = "required";
    else if (choice?.type === "tool" && choice.name) body.tool_choice = { type: "function", function: { name: choice.name } };
    else if (choice?.type === "none") body.tool_choice = "none";
  }
  return body;
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };
export const stopReason = (finish: string | null | undefined) => STOP_REASONS[finish ?? "stop"] ?? "end_turn";

function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

/** Turn a complete (non-streamed) OpenAI answer into an Anthropic message. */
export function toAnthropicMessage(response: any, model: string): Record<string, unknown> {
  const choice = response?.choices?.[0] ?? {};
  const content: any[] = [];
  if (choice.message?.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message?.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) });
  }
  return {
    id: `msg_${response?.id ?? Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: response?.usage?.prompt_tokens ?? 0, output_tokens: response?.usage?.completion_tokens ?? 0 },
  };
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Converts a stream of OpenAI chunks into Anthropic stream events.
 * Feed it each parsed chunk with push(); call finish() when the upstream ends.
 */
export class StreamTranslator {
  private started = false;
  private index = -1;
  private textOpen = false;
  /** OpenAI tool-call index -> our content block index */
  private toolBlocks = new Map<number, number>();
  private finishReason: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0 };
  private done = false;

  constructor(private model: string) {}

  private start(events: SseEvent[]): void {
    if (this.started) return;
    this.started = true;
    events.push({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${Date.now().toString(36)}`, type: "message", role: "assistant", model: this.model, content: [],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
  }

  private closeText(events: SseEvent[]): void {
    if (!this.textOpen) return;
    this.textOpen = false;
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.index } });
  }

  push(chunk: any): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.done) return events;
    this.start(events);
    if (chunk?.usage) {
      this.usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk?.choices?.[0];
    if (!choice) return events;
    const delta = choice.delta ?? {};

    if (typeof delta.content === "string" && delta.content) {
      if (!this.textOpen) {
        this.textOpen = true;
        this.index++;
        events.push({ event: "content_block_start", data: { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } } });
      }
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: delta.content } } });
    }

    for (const call of delta.tool_calls ?? []) {
      const key = call.index ?? 0;
      if (!this.toolBlocks.has(key)) {
        this.closeText(events);
        this.index++;
        this.toolBlocks.set(key, this.index);
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start", index: this.index,
            content_block: { type: "tool_use", id: call.id || `toolu_${Date.now().toString(36)}${key}`, name: call.function?.name ?? "", input: {} },
          },
        });
      }
      const fragment = call.function?.arguments;
      if (fragment) {
        events.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index: this.toolBlocks.get(key)!, delta: { type: "input_json_delta", partial_json: fragment } },
        });
      }
    }
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    return events;
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.done) return events;
    this.done = true;
    this.start(events);
    this.closeText(events);
    for (const block of this.toolBlocks.values()) events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: block } });
    const reason = this.toolBlocks.size ? "tool_use" : stopReason(this.finishReason);
    events.push({
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens, input_tokens: this.usage.input_tokens } },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    return events;
  }
}

/** A rough token count for requests Claude Code sends only to measure size. */
export function estimateTokens(request: AnthropicRequest): number {
  return Math.ceil(JSON.stringify({ s: request.system, m: request.messages, t: request.tools }).length / 4);
}
