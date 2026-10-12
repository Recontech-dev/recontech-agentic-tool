// The link between terminals. Each terminal's Claude Code reaches the brain's MCP server, and the
// MCP server reaches this small local server to list the other terminals, read their screens and
// send them messages. It listens only on this computer and needs a token that only the app's own
// MCP servers are given.

import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

export interface TerminalInfo {
  name: string;
  kind: string;
  running: boolean;
  /** The terminal's job, if it was given one: Builder, Reviewer or Tester. */
  role?: string;
}

export interface Hooks {
  terminals(): TerminalInfo[];
  /** The text currently on a terminal's screen, last `lines` lines. */
  read(name: string, lines: number): Promise<string>;
  /**
   * Type a message into a terminal as a prompt. "queued" means it waits until the user stops typing
   * in that terminal.
   */
  deliver(name: string, text: string, from?: string): "sent" | "queued" | void;
  /** True for a terminal kept in a container, which may not read the other terminals' screens. */
  contained?(name: string): boolean;
}

/** How many messages one terminal may send another in a window of time, so two sessions cannot loop forever. */
export const MAX_MESSAGES = 12;
export const WINDOW_MS = 15 * 60 * 1000;

export class Control {
  readonly token = randomBytes(24).toString("base64url");
  port = 0;
  private server: http.Server | null = null;
  private sent = new Map<string, number[]>();

  constructor(private hooks: Hooks) {}

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => this.reply(res, 500, { error: String(error?.message ?? error) })));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  close(): void {
    this.server?.close();
    // Connections kept open by clients would otherwise keep being served after closing.
    this.server?.closeAllConnections();
    this.server = null;
  }

  /** Write where to find this server, for the MCP servers the app starts. */
  writeAddress(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${this.port}`, token: this.token }), { encoding: "utf8", mode: 0o600 });
  }

  private reply(res: http.ServerResponse, status: number, data: object): void {
    const body = JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  private allowed(req: http.IncomingMessage): boolean {
    if (![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(req.headers.host ?? "")) return false;
    const a = Buffer.from(String(req.headers["x-alt-token"] ?? "")), b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private find(name: string): TerminalInfo | undefined {
    const wanted = String(name ?? "").trim().toLowerCase();
    const all = this.hooks.terminals();
    return all.find((t) => t.name.toLowerCase() === wanted) ?? all.find((t) => t.name.toLowerCase().includes(wanted) && wanted.length >= 2);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST" || !this.allowed(req)) return this.reply(res, 401, { error: "not allowed" });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return this.reply(res, 400, { error: "bad request" });
    }
    const names = () => this.hooks.terminals().map((t) => t.name).join(", ");

    if (req.url === "/terminals") return this.reply(res, 200, { terminals: this.hooks.terminals() });

    if (req.url === "/read") {
      if (this.hooks.contained?.(String(body.from ?? ""))) {
        return this.reply(res, 403, { error: "This terminal is kept in a container and cannot read other terminals. Another terminal can send it what it needs." });
      }
      const target = this.find(body.name);
      if (!target) return this.reply(res, 404, { error: `There is no terminal named "${body.name}". Terminals: ${names()}` });
      if (!target.running) return this.reply(res, 409, { error: `${target.name}'s terminal has not been started.` });
      const lines = Math.max(5, Math.min(Number(body.lines) || 60, 300));
      return this.reply(res, 200, { name: target.name, text: await this.hooks.read(target.name, lines) });
    }

    if (req.url === "/send") {
      const from = String(body.from ?? "").trim() || "another terminal";
      const message = String(body.message ?? "").trim();
      const target = this.find(body.to);
      if (!target) return this.reply(res, 404, { error: `There is no terminal named "${body.to}". Terminals: ${names()}` });
      if (target.name.toLowerCase() === from.toLowerCase()) return this.reply(res, 400, { error: "That is this terminal itself." });
      if (!target.running) return this.reply(res, 409, { error: `${target.name}'s terminal has not been started, so it cannot receive messages.` });
      if (!message) return this.reply(res, 400, { error: "The message is empty." });
      const key = `${from.toLowerCase()}>${target.name.toLowerCase()}`;
      const recent = (this.sent.get(key) ?? []).filter((t) => Date.now() - t < WINDOW_MS);
      if (recent.length >= MAX_MESSAGES) {
        return this.reply(res, 429, {
          error: `${MAX_MESSAGES} messages were already sent from ${from} to ${target.name} in the last ${WINDOW_MS / 60000} minutes. Stop here, summarise where things stand, and let the user decide how to continue.`,
        });
      }
      this.sent.set(key, [...recent, Date.now()]);
      const how = this.hooks.deliver(target.name, `[Message from the "${from}" terminal] ${message.slice(0, 6000)}`, from);
      return this.reply(res, 200, { delivered: target.name, queued: how === "queued", remaining: MAX_MESSAGES - recent.length - 1 });
    }
    this.reply(res, 404, { error: "unknown" });
  }
}
