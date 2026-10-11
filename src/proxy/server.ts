// A small server on this computer that lets Claude Code use free AI providers.
// Claude Code talks to it as if it were Claude's API; each request is translated and sent to the
// user's free providers in order, moving to the next one when a provider is limited or failing.

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as http from "node:http";

import { AnthropicRequest, StreamTranslator, estimateTokens, toAnthropicMessage, toOpenAI } from "./translate";

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  key: string;
  /** Largest answer the provider accepts, in tokens. */
  maxOutput: number;
  /** Some providers reject parts of JSON Schema that Claude Code's tools use. */
  strictSchema?: boolean;
}

/** Starting points for the providers with a free tier. Models change often, so the user can edit them. */
export const PRESETS: Record<string, Omit<Provider, "key" | "id"> & { keyUrl: string; note: string }> = {
  gemini: {
    name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", maxOutput: 16000,
    strictSchema: true, keyUrl: "https://aistudio.google.com/apikey", note: "Generous free tier; the best free choice for Claude Code.",
  },
  openrouter: {
    name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen3-coder:free", maxOutput: 8192,
    keyUrl: "https://openrouter.ai/keys", note: "Models ending in :free cost nothing, with a small daily request limit.",
  },
  cerebras: {
    name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", maxOutput: 8192,
    keyUrl: "https://cloud.cerebras.ai", note: "Very fast; free tier with daily limits.",
  },
  groq: {
    name: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", maxOutput: 8192,
    keyUrl: "https://console.groq.com/keys", note: "Fast, but its free tier allows few tokens per minute; Claude Code's long instructions may not fit.",
  },
};

const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "$id", "additionalProperties", "default", "propertyNames", "exclusiveMinimum", "exclusiveMaximum", "patternProperties", "minItems", "maxItems", "minLength", "maxLength", "pattern", "format", "examples", "title"]);

/** Remove the JSON Schema parts strict providers reject, keeping the shape of the tool's input. */
export function simplifySchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(simplifySchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "const") out.enum = [value];
    else if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, simplifySchema(sub)]));
    } else out[key] = simplifySchema(value);
  }
  return out;
}

interface Attempt {
  provider: string;
  problem: string;
  limited: boolean;
  /** Waiting will not help: a wrong key or a rejected request. */
  permanent?: boolean;
}

export interface ProxyStatus {
  providers: { id: string; name: string; model: string; state: string; served: number; lastProblem: string }[];
  recent: { time: string; used: string; skipped: string[] }[];
}

export class FreeProxy {
  readonly token = randomBytes(24).toString("base64url");
  port = 0;
  private server: http.Server | null = null;
  private cooldowns = new Map<string, number>();
  private served = new Map<string, number>();
  private problems = new Map<string, string>();
  private recent: ProxyStatus["recent"] = [];

  constructor(private providers: () => Provider[], private onChange: () => void = () => {}) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => this.fail(res, 500, "api_error", String(error?.message ?? error))));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  status(): ProxyStatus {
    const now = Date.now();
    return {
      providers: this.providers().map((p) => {
        const wait = Math.max((this.cooldowns.get(p.id) ?? 0) - now, 0);
        return {
          id: p.id, name: p.name, model: p.model, served: this.served.get(p.id) ?? 0, lastProblem: this.problems.get(p.id) ?? "",
          state: !p.key ? "no key" : wait ? `back in ${Math.ceil(wait / 1000)}s` : "ready",
        };
      }),
      recent: this.recent,
    };
  }

  private fail(res: http.ServerResponse, status: number, type: string, message: string): void {
    if (res.headersSent) return void res.end();
    const body = JSON.stringify({ type: "error", error: { type, message } });
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  private allowed(req: http.IncomingMessage): boolean {
    // Only this app's own Claude Code terminals know the token; the Host check blocks web pages
    // that reach the port through a look-alike name.
    if (![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host ?? "")) return false;
    const given = String(req.headers["x-api-key"] ?? "") || String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.allowed(req)) return this.fail(res, 401, "authentication_error", "This address is only for the Agentic Lazy Tool app's own terminals.");
    const route = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(route)) {
      return this.fail(res, 404, "not_found_error", "Not supported by the free-models bridge.");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let request: AnthropicRequest;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return this.fail(res, 400, "invalid_request_error", "The request is not valid JSON.");
    }
    if (route.endsWith("count_tokens")) {
      const body = JSON.stringify({ input_tokens: estimateTokens(request) });
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(body);
    }
    await this.complete(request, res);
  }

  private async complete(request: AnthropicRequest, res: http.ServerResponse): Promise<void> {
    const attempts: Attempt[] = [];
    for (const provider of this.providers()) {
      if (!provider.key) continue;
      if ((this.cooldowns.get(provider.id) ?? 0) > Date.now()) {
        const problem = this.problems.get(provider.id) ?? "still limited";
        attempts.push({ provider: provider.name, problem, limited: !/key rejected/.test(problem), permanent: /key rejected/.test(problem) });
        continue;
      }
      const body = toOpenAI(request, provider.model, provider.maxOutput);
      if (provider.strictSchema && Array.isArray(body.tools)) {
        body.tools = (body.tools as any[]).map((t) => ({ ...t, function: { ...t.function, parameters: simplifySchema(t.function.parameters) } }));
      }
      let upstream: Response;
      try {
        upstream = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${provider.key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(600_000),
        });
      } catch (error) {
        this.skip(provider, attempts, "could not be reached", 30, false);
        continue;
      }
      if (!upstream.ok) {
        const detail = (await upstream.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
        const retry = Number(upstream.headers.get("retry-after"));
        // Some providers answer a wrong key with a plain 400, so the message is checked as well.
        const badKey = upstream.status === 401 || upstream.status === 403 || (upstream.status === 400 && /api[ _-]?key/i.test(detail));
        if (upstream.status === 429) this.skip(provider, attempts, `limit reached (${detail})`, Number.isFinite(retry) && retry > 0 ? retry : 60, true);
        else if (badKey) this.skip(provider, attempts, "API key rejected; check it in Free models", 300, false, true);
        else if (upstream.status === 402) this.skip(provider, attempts, "out of credit", 3600, true);
        else if (upstream.status >= 500) this.skip(provider, attempts, `provider error ${upstream.status}`, 30, false);
        else this.skip(provider, attempts, `request rejected (${upstream.status}): ${detail}`, 0, upstream.status === 413, upstream.status !== 413);
        continue;
      }
      this.served.set(provider.id, (this.served.get(provider.id) ?? 0) + 1);
      this.problems.delete(provider.id);
      this.remember(provider.name, attempts);
      if (request.stream) await this.pipeStream(upstream, res, provider.model);
      else {
        const message = JSON.stringify(toAnthropicMessage(await upstream.json(), provider.model));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(message);
      }
      return;
    }
    this.remember("-", attempts);
    const allLimited = attempts.length > 0 && attempts.every((a) => a.limited);
    // When waiting cannot help (no keys, wrong keys), answer with an error Claude Code shows at once
    // instead of one it retries ten times.
    const hopeless = attempts.every((a) => a.permanent);
    const detail = attempts.map((a) => `${a.provider}: ${a.problem}`).join("; ") || "no free provider has an API key yet";
    const [status, type] = hopeless ? [400, "invalid_request_error"] : allLimited ? [429, "rate_limit_error"] : [529, "overloaded_error"];
    this.fail(res, status, type, `No free provider could answer. ${detail}`);
  }

  private skip(provider: Provider, attempts: Attempt[], problem: string, cooldownSeconds: number, limited: boolean, permanent = false): void {
    if (cooldownSeconds) this.cooldowns.set(provider.id, Date.now() + cooldownSeconds * 1000);
    this.problems.set(provider.id, problem);
    attempts.push({ provider: provider.name, problem, limited, permanent });
  }

  private remember(used: string, attempts: Attempt[]): void {
    this.recent.unshift({ time: new Date().toTimeString().slice(0, 8), used, skipped: attempts.map((a) => `${a.provider}: ${a.problem}`) });
    this.recent.length = Math.min(this.recent.length, 30);
    this.onChange();
  }

  private async pipeStream(upstream: Response, res: http.ServerResponse, model: string): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const translator = new StreamTranslator(model);
    const write = (events: { event: string; data: object }[]) => {
      for (const { event, data } of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of upstream.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            write(translator.push(JSON.parse(data)));
          } catch {
            // a keep-alive or a partial line; nothing to translate
          }
        }
      }
    } catch {
      // The provider cut the stream; end the answer cleanly with what arrived.
    }
    write(translator.finish());
    res.end();
  }
}
