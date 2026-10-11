// The brain as an MCP server. Claude Code starts it for every session in the workspace, so all
// profiles read and write the same memory. It speaks JSON-RPC over stdin/stdout, one message per line.

import * as readline from "node:readline";

import { Brain } from "../brain/brain";
import { addNote, removeNote } from "../brain/store";
import { sources } from "../brain/workspace";

const PROTOCOL_VERSION = "2025-06-18";

const INSTRUCTIONS =
  "This server is the user's long-term memory across all their Claude Code sessions and projects. " +
  "When you start work in a project, call project_memory once to see what was decided and done before. " +
  "When a decision is made, a fact about the project is learned, or work is left unfinished, save it with remember: " +
  "one short sentence that makes sense on its own. Use recall to look up earlier work, including other projects. " +
  "Never save passwords, keys or tokens.";

const projectArg = { type: "string", description: "Project folder. Leave out to use the current folder." };

const TOOLS = [
  {
    name: "remember",
    description: "Save a short note about the project for future sessions: a decision, a fact about the code or setup, a preference, or unfinished work.",
    inputSchema: { type: "object", properties: { note: { type: "string" }, project: projectArg }, required: ["note"], additionalProperties: false },
  },
  {
    name: "recall",
    description: "Search the notes and past Claude Code sessions of every project for the given words.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "project_memory",
    description: "Everything remembered about a project: its notes and its recent sessions.",
    inputSchema: { type: "object", properties: { project: projectArg }, additionalProperties: false },
  },
  {
    name: "forget",
    description: "Delete one of a project's notes by the number shown in project_memory.",
    inputSchema: { type: "object", properties: { number: { type: "integer" }, project: projectArg }, required: ["number"], additionalProperties: false },
  },
];

const brain = new Brain(() => sources());

function runTool(name: string, args: any): string {
  const folder = typeof args?.project === "string" && args.project ? args.project : process.cwd();
  switch (name) {
    case "remember": {
      if (typeof args?.note !== "string" || !args.note.trim()) throw new Error("note must be a non-empty string");
      return `Remembered for ${folder}: ${addNote(folder, args.note, "claude-code")}`;
    }
    case "recall": {
      brain.update();
      const matches = brain.search(String(args?.query ?? ""));
      if (!matches.length) return "Nothing in memory matches.";
      return matches.map((m) => `- [${m.kind}] ${m.project} (${m.when}): ${m.text}`).join("\n");
    }
    case "project_memory":
      brain.update();
      return brain.projectSummary(folder);
    case "forget": {
      const removed = removeNote(folder, Number(args?.number));
      return removed ? `Forgot: ${removed.text}` : "There is no note with that number.";
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function handle(message: any): object | null {
  const { id, method, params } = message;
  const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
  if (id === undefined || id === null) return null; // notifications need no answer
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agentic-lazy-tool-brain", version: "0.4.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        return reply({ content: [{ type: "text", text: runTool(params?.name, params?.arguments) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: String((error as Error).message ?? error) }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function main(): void {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let response: object | null;
    try {
      response = handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}

if (require.main === module) main();
