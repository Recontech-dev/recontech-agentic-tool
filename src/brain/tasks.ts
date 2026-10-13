// The task board: who was handed what, and how far it got. A hand-off is structured (a title, the
// files, what done looks like) instead of free text, so the board and Recon can follow the work.
// Kept per project as tasks.jsonl beside its notes: one event per line, only ever appended, because
// every terminal's brain server writes here and appending one short line never clobbers another's.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { projectDir } from "./store";
import { redact } from "./redact";

export type TaskStatus = "sent" | "working" | "review" | "done" | "failed";
export const STATUSES: readonly TaskStatus[] = ["sent", "working", "review", "done", "failed"];

export interface Task {
  id: string;
  title: string;
  /** The terminal that handed it out, and the one doing it now. */
  from: string;
  to: string;
  files: string[];
  /** What done looks like. */
  done: string;
  status: TaskStatus;
  /** The latest word on it: a result, a finding, why it failed. */
  note: string;
  /** The Builder whose finished work is being checked, so a failed check goes back to them. */
  builder?: string;
  created: string;
  updated: string;
}

export interface NewTask {
  title: string;
  from: string;
  to: string;
  files?: string[];
  done?: string;
}

type Event =
  | { kind: "new"; time: string; task: Omit<Task, "status" | "note" | "created" | "updated"> }
  | { kind: "move"; time: string; id: string; status: TaskStatus; to?: string; note?: string; builder?: string };

const LIMITS = { title: 200, name: 60, file: 260, files: 30, done: 1000, note: 1000 };

/** One line of plain text, at most `max` characters, with secrets masked. */
function clean(value: unknown, max: number): string {
  return redact(String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/ {2,}/g, " ").trim()).slice(0, max);
}

export const tasksFile = (folder: string) => path.join(projectDir(folder), "tasks.jsonl");

function append(folder: string, event: Event): void {
  const file = tasksFile(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // After a crash halfway through a write the file ends mid-line; start a new one so this event is not lost with it.
  fs.appendFileSync(file, (endsMidLine(file) ? "\n" : "") + JSON.stringify(event) + "\n");
}

function endsMidLine(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (!size) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Hand a task to a terminal. */
export function addTask(folder: string, input: NewTask): Task {
  const title = clean(input?.title, LIMITS.title);
  const from = clean(input?.from, LIMITS.name);
  const to = clean(input?.to, LIMITS.name);
  if (!title) throw new Error("A task needs a title.");
  if (!from || !to) throw new Error("A task needs the terminal handing it out and the one doing it.");
  const files = (Array.isArray(input.files) ? input.files : []).map((f) => clean(f, LIMITS.file)).filter(Boolean).slice(0, LIMITS.files);
  const event: Event = { kind: "new", time: new Date().toISOString(), task: { id: randomUUID().slice(0, 8), title, from, to, files, done: clean(input.done, LIMITS.done) } };
  append(folder, event);
  return { ...event.task, status: "sent", note: "", created: event.time, updated: event.time };
}

/**
 * Move a task on: started, ready for review, done or failed; `to` hands it to another terminal and
 * `builder` records whose work a review is checking.
 */
export function moveTask(folder: string, id: string, status: TaskStatus, note = "", to?: string, builder?: string): Task {
  if (!STATUSES.includes(status)) throw new Error(`A task's status is one of: ${STATUSES.join(", ")}.`);
  const task = readTasks(folder).find((t) => t.id === id);
  if (!task) throw new Error(`There is no task ${clean(id, 20)}.`);
  const event: Event = { kind: "move", time: new Date().toISOString(), id: task.id, status, note: clean(note, LIMITS.note) };
  const next = clean(to, LIMITS.name);
  if (next) event.to = next;
  const by = clean(builder, LIMITS.name);
  if (by) event.builder = by;
  append(folder, event);
  return { ...task, status, note: event.note ?? "", to: next || task.to, builder: by || task.builder, updated: event.time };
}

/** Every task of the project, oldest first. A broken line (a crash halfway through a write) is skipped. */
export function readTasks(folder: string): Task[] {
  const file = tasksFile(folder);
  if (!fs.existsSync(file)) return [];
  const tasks = new Map<string, Task>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event: Event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind === "new" && event.task?.id && !tasks.has(event.task.id)) {
      tasks.set(event.task.id, { ...event.task, files: event.task.files ?? [], status: "sent", note: "", created: event.time, updated: event.time });
    } else if (event?.kind === "move" && STATUSES.includes(event.status)) {
      const task = tasks.get(event.id);
      if (!task) continue;
      task.status = event.status;
      task.note = event.note ?? "";
      if (event.to) task.to = event.to;
      if (event.builder) task.builder = event.builder;
      task.updated = event.time;
    }
  }
  return [...tasks.values()];
}

/** What everyone is doing, short enough to read aloud: open tasks by terminal, then a count of the finished ones. */
export function boardSummary(tasks: Task[]): string {
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "failed");
  const finished = tasks.length - open.length;
  if (!tasks.length) return "There are no tasks yet.";
  const say: Record<"sent" | "working" | "review", (t: Task) => string> = {
    sent: (t) => `${t.to} has been sent "${t.title}".`,
    working: (t) => `${t.to} is working on "${t.title}".`,
    review: (t) => `"${t.title}" is in review with ${t.to}.`,
  };
  const lines = open.map((t) => say[t.status as "sent" | "working" | "review"](t));
  if (!open.length) lines.push("Nothing is open.");
  if (finished) lines.push(`${finished} ${finished === 1 ? "task is" : "tasks are"} finished.`);
  return lines.join(" ");
}

/** A terminal as the app's terminal link lists it. */
export interface Teammate {
  name: string;
  running: boolean;
  /** The role's display name ("Builder"), and its id when the app sends it. */
  role?: string;
  roleId?: string;
}

const roleOf = (t: Teammate | undefined) => String(t?.roleId ?? t?.role ?? "").toLowerCase();
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Why `by` may not move this task to `status`, or null when it may. Only the terminal that has the
 * task or the one that handed it out moves it, and while it is in review only the checker says
 * whether it is done or failed, so a Builder cannot close its own work by marking it done twice.
 */
export function whyNotMove(task: Task, by: string, status: TaskStatus): string | null {
  if (task.status === "review" && (status === "done" || status === "failed") && !same(by, task.to)) {
    return `Task ${task.id} is being checked by ${task.to}; only ${task.to} can mark it ${status}.`;
  }
  if (!by || (!same(by, task.to) && !same(by, task.from))) {
    return `Only ${task.to}, who has task ${task.id}, or ${task.from}, who handed it out, can move it.`;
  }
  return null;
}

/**
 * Who checks a finished task: when the terminal that holds it is a Builder, a running Reviewer, or a
 * Tester when there is no Reviewer; never the Builder itself. null when the task is not a Builder's or
 * nobody is there to check it, so it simply stays done.
 */
export function checkerFor(task: Task, team: Teammate[]): Teammate | null {
  const holder = team.find((t) => same(t.name, task.to));
  if (roleOf(holder) !== "builder") return null;
  const free = team.filter((t) => t.running && !same(t.name, task.to));
  return free.find((t) => roleOf(t) === "reviewer") ?? free.find((t) => roleOf(t) === "tester") ?? null;
}

/** The message that hands a Builder's finished task to its checker: what, where, what done means, and how to answer. */
export function handOffMessage(task: Task, builder: string, note = ""): string {
  const parts = [`Task ${task.id} "${task.title}" was finished by ${builder} and needs checking before it counts as done.`];
  if (task.files.length) parts.push(`Files: ${task.files.join(", ")}.`);
  if (task.done) parts.push(`Done means: ${task.done}`);
  if (note) parts.push(`${builder}'s note: ${note}`);
  parts.push(
    `Check it, then call update_task with id "${task.id}": status "done" if it holds, or "failed" with your findings in the note; ` +
    `a failed check goes back to ${builder} with your note, automatically.`,
  );
  return parts.join(" ");
}
