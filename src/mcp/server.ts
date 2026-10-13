// The brain as an MCP server. Claude Code starts it for every session in the workspace, so all
// profiles read and write the same memory and can reach each other's terminals.
// It speaks JSON-RPC over stdin/stdout, one message per line.

import * as fs from "node:fs";
import * as readline from "node:readline";

import { Brain } from "../brain/brain";
import { addNote, cleanUrl, removeNote } from "../brain/store";
import { STATUSES, Task, TaskStatus, Teammate, addTask, boardSummary, checkerFor, handOffMessage, moveTask, readTasks, whyNotMove } from "../brain/tasks";
import { sources } from "../brain/workspace";

const PROTOCOL_VERSION = "2025-06-18";

/** The name of the terminal this server belongs to, and where the app's terminal link listens. */
const SELF = process.env.ALT_PROFILE || "";
const CONTROL_FILE = process.env.ALT_CONTROL || "";
/** A contained terminal (the free one, by default) gets no memory and cannot read other terminals. */
const CONTAINED = process.env.ALT_CONTAINED === "1";
const CONTAINED_TOOLS = new Set(["list_terminals", "message_terminal"]);

const CONTAINED_INSTRUCTIONS =
  "This session runs in a container inside the Recontech Agentic Tool app: it has its own empty folder and no access to the user's " +
  "projects, memory or other terminals' screens. Work only with what the user or another terminal gives you in a message. " +
  "A message from another terminal arrives as a prompt starting with [Message from the \"<name>\" terminal]; do what it asks and " +
  "send your answer back with message_terminal to the terminal it came from. Use list_terminals to see the terminals' names. " +
  "Keep messages short and stop once the question is settled.";

const INSTRUCTIONS =
  "This server is the user's long-term memory across all their Claude Code sessions and projects, and the link to the other " +
  "Claude Code terminals open in the same Recontech Agentic Tool window. " +
  "MEMORY: when you start work in a project, call project_memory once to see what was decided and done before. " +
  "When a decision is made, a fact about the project is learned, or work is left unfinished, save it with remember: " +
  "one short sentence that makes sense on its own. Use recall to look up earlier work, including other projects. " +
  "Never save passwords, keys or tokens. " +
  "OTHER TERMINALS: when the user mentions another terminal, session or profile by name (for example \"the work terminal\" or " +
  "\"Account 1\"), use list_terminals to find it, read_terminal to see what is on its screen, and message_terminal to send it a " +
  "message. A message arrives there as a prompt starting with [Message from the \"<name>\" terminal]. When you receive such a " +
  "prompt, do what it asks and send your answer back with message_terminal to the terminal it came from. Keep messages short " +
  "and concrete, stop once the question is settled, and never keep a back-and-forth going without a purpose: every message " +
  "uses the user's usage on both sides. " +
  "RESEARCH: for any non-trivial task, work in this order. First recall (and project_memory) to see what this and other projects " +
  "already learned about it; second, search the web for how it is done well (official docs, well-regarded sources); then implement. " +
  "Save what was learned with remember, kind \"research\", with the source URL in source, so the next project finds it. " +
  "Skip the web for trivial edits." +
  (SELF ? ` This terminal is called "${SELF}".` : "");

const projectArg = { type: "string", description: "Project folder. Leave out to use the current folder." };

const TOOLS = [
  {
    name: "remember",
    description: "Save a short note about the project for future sessions: a decision, a fact about the code or setup, a preference, or unfinished work. For something learned from research, set kind to \"research\" and give the source URL.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string" },
        kind: { type: "string", enum: ["note", "research"], description: "\"research\" for a finding learned from the web or docs; \"note\" (the default) for a decision or fact" },
        source: { type: "string", description: "For research: the URL it came from" },
        project: projectArg,
      },
      required: ["note"], additionalProperties: false,
    },
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
  {
    name: "list_terminals",
    description: "List the Claude Code terminals open in the same app window (the other profiles), and whether each is running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_terminal",
    description: "Read the text currently on another terminal's screen, to see what that Claude Code session is doing or has answered.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "The terminal's name, as shown by list_terminals" }, lines: { type: "integer", description: "How many lines from the bottom (default 60, at most 300)" } },
      required: ["name"], additionalProperties: false,
    },
  },
  {
    name: "message_terminal",
    description: "Send a message to another terminal. It arrives there as a prompt, so that Claude Code session acts on it and can answer with its own message_terminal. Use it to ask for a review, hand over a task, or discuss an approach.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "The terminal's name, as shown by list_terminals" }, message: { type: "string" } },
      required: ["to", "message"], additionalProperties: false,
    },
  },
  {
    name: "hand_task",
    description: "Hand a task to another terminal and put it on the project's task board: a short title, the files, and what done looks like. The terminal is sent the task as a message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "The terminal's name, as shown by list_terminals" },
        title: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        done: { type: "string", description: "What done looks like" },
        project: projectArg,
      },
      required: ["to", "title"], additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description: "Move a task on the board: working, review, done or failed, with a short note. A Builder's task marked done is sent to a Reviewer or Tester terminal to check.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", enum: [...STATUSES] }, note: { type: "string" }, project: projectArg },
      required: ["id", "status"], additionalProperties: false,
    },
  },
  {
    name: "task_board",
    description: "The project's task board: every task, who has it and how far it got.",
    inputSchema: { type: "object", properties: { project: projectArg }, additionalProperties: false },
  },
];

/** One task as a line of the board. */
const taskLine = (t: Task) => `- ${t.id} [${t.status}] "${t.title}", ${t.to} (from ${t.from})${t.note ? `: ${t.note}` : ""}`;

const brain = new Brain(() => sources());

/** Ask the app's terminal link. The app writes its address to a file when it starts. */
async function control(route: string, body: object): Promise<any> {
  let address: { url: string; token: string };
  try {
    address = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
  } catch {
    throw new Error("Other terminals can only be reached while this session runs inside the Recontech Agentic Tool app.");
  }
  let response: Response;
  try {
    response = await fetch(address.url + route, {
      method: "POST",
      headers: { "content-type": "application/json", "x-alt-token": address.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The Recontech Agentic Tool app is not answering. Is its window still open?");
  }
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The app refused the request (${response.status}).`);
  return data;
}

async function runTool(name: string, args: any): Promise<string> {
  if (CONTAINED && !CONTAINED_TOOLS.has(name)) throw new Error("Not available: this terminal is kept in a container.");
  const folder = typeof args?.project === "string" && args.project ? args.project : process.cwd();
  switch (name) {
    case "remember": {
      if (typeof args?.note !== "string" || !args.note.trim()) throw new Error("note must be a non-empty string");
      const research = args?.kind === "research";
      const url = cleanUrl(args?.source);
      if (args?.source && !url) throw new Error("source must be an http or https URL");
      const text = addNote(folder, args.note, "claude-code", { kind: research ? "research" : undefined, url });
      return `Remembered${research ? " as research" : ""} for ${folder}: ${text}${url ? ` (source: ${url})` : ""}`;
    }
    case "recall": {
      brain.update();
      const { matches } = await brain.searchSmart(String(args?.query ?? ""));
      if (!matches.length) return "Nothing in memory matches.";
      return matches.map((m) => `- [${m.research ? "research" : m.kind}] ${m.project} (${m.when}): ${m.text}${m.url ? ` Source: ${m.url}` : ""}`).join("\n");
    }
    case "project_memory":
      brain.update();
      return brain.projectSummary(folder);
    case "forget": {
      const removed = removeNote(folder, Number(args?.number));
      return removed ? `Forgot: ${removed.text}` : "There is no note with that number.";
    }
    case "list_terminals": {
      const { terminals } = await control("/terminals", {});
      return terminals
        .map((t: any) => `- ${t.name}${t.name === SELF ? " (this terminal)" : ""}: ${t.role ? `${t.role}, ` : ""}${t.kind}, ${t.running ? "running" : "not started"}`)
        .join("\n");
    }
    case "read_terminal": {
      const { name: found, text } = await control("/read", { from: SELF, name: args?.name, lines: args?.lines });
      return `Screen of the "${found}" terminal:\n${text || "(nothing on screen yet)"}`;
    }
    case "message_terminal": {
      const { delivered, queued, remaining } = await control("/send", { from: SELF, to: args?.to, message: args?.message });
      if (queued) {
        return `Queued for "${delivered}": the user is typing there, so the message arrives as soon as they send or clear what they are typing. Do not send it again. Its reply arrives here as a new prompt. ${remaining} more messages allowed for now.`;
      }
      return `Delivered to "${delivered}". It will act on the message and can answer with its own message; its reply arrives here as a new prompt. ${remaining} more messages allowed for now.`;
    }
    case "hand_task": {
      const task = addTask(folder, { title: args?.title, from: SELF || "another terminal", to: args?.to, files: args?.files, done: args?.done });
      const lines = [`You are handed task ${task.id}: "${task.title}".`];
      if (task.files.length) lines.push(`Files: ${task.files.join(", ")}.`);
      if (task.done) lines.push(`Done means: ${task.done}`);
      lines.push(`Call update_task with id "${task.id}" as you go: "working" when you start, "done" when it is finished.`);
      try {
        await control("/send", { from: SELF, to: task.to, message: lines.join(" ") });
      } catch (error) {
        return `Task ${task.id} is on the board for ${task.to}, but it could not be sent: ${(error as Error).message}`;
      }
      return `Task ${task.id} is on the board and was sent to ${task.to}.`;
    }
    case "update_task": {
      const status = String(args?.status ?? "") as TaskStatus;
      const note = String(args?.note ?? "");
      const id = String(args?.id ?? "");
      const task = readTasks(folder).find((t) => t.id === id);
      if (task && STATUSES.includes(status)) {
        const refused = whyNotMove(task, SELF, status);
        if (refused) throw new Error(refused);
      }
      // A failed check goes back to the Builder, findings and all, to fix and mark done again (which sends it back for review).
      if (status === "failed" && task?.status === "review" && task.builder) {
        const back = moveTask(folder, task.id, "working", note, task.builder);
        try {
          await control("/send", {
            from: SELF, to: task.builder,
            message: `Task ${task.id} "${task.title}" did not pass ${task.to}'s check: ${back.note || "no details given"} Fix it, then call update_task with id "${task.id}" and status "done" again.`,
          });
        } catch (error) {
          return `Task ${task.id} is back with ${task.builder}, but the message could not be sent: ${(error as Error).message}`;
        }
        return `Task ${task.id} failed the check and went back to ${task.builder} with your note.`;
      }
      if (status === "done" && task && task.status !== "review") {
        // A Builder's finished work goes to a Reviewer or Tester first; it is only done once they say so.
        let team: Teammate[] = [];
        try {
          team = (await control("/terminals", {})).terminals ?? [];
        } catch {
          // The app is not reachable: there is nobody to hand it to, so it is simply done.
        }
        const checker = checkerFor(task, team);
        if (checker) {
          const moved = moveTask(folder, task.id, "review", note, checker.name, task.to);
          try {
            await control("/send", { from: SELF, to: checker.name, message: handOffMessage(moved, task.to, moved.note) });
          } catch (error) {
            return `Task ${task.id} is waiting for review by ${checker.name}, but the message could not be sent: ${(error as Error).message}`;
          }
          return `Task ${task.id} was sent to ${checker.name} (${checker.role}) to check. It counts as done once ${checker.name} marks it so.`;
        }
      }
      const moved = moveTask(folder, id, status, note);
      return `Task ${moved.id} is now ${moved.status}.`;
    }
    case "task_board": {
      const tasks = readTasks(folder);
      return [boardSummary(tasks), ...tasks.map(taskLine)].join("\n");
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

async function handle(message: any): Promise<object | null> {
  const { id, method, params } = message;
  const reply = (result: object) => ({ jsonrpc: "2.0", id, result });
  if (id === undefined || id === null) return null; // notifications need no answer
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "recontech-agentic-tool-brain", version: "0.12.0" },
        instructions: CONTAINED ? CONTAINED_INSTRUCTIONS + (SELF ? ` This terminal is called "${SELF}".` : "") : INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: CONTAINED ? TOOLS.filter((t) => CONTAINED_TOOLS.has(t.name)) : TOOLS });
    case "tools/call":
      try {
        return reply({ content: [{ type: "text", text: await runTool(params?.name, params?.arguments) }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: String((error as Error).message ?? error) }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export function main(): void {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    if (!line.trim()) return;
    let response: object | null;
    try {
      response = await handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}

if (require.main === module) main();
