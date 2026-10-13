// Budget hand-over: a terminal close to its Claude usage limit offers its open tasks to another
// terminal, with a short summary, so the work goes on when the limit is reached. Nothing here acts by
// itself: the app shows the offer and only the user's click on it hands anything over.

import { redact } from "./redact";
import { Task } from "./tasks";

/** A share of the session or weekly limit at or above this counts as near it. */
export const NEAR_PERCENT = 90;

export interface Near {
  which: "session" | "week";
  percent: number;
}

/** The limits Anthropic reports for an account (see limits.ts), as far as this needs them. */
type Limits = { session: { percent: number } | null; week: { percent: number } | null } | { error: string } | null | undefined;

/** Which of an account's limits it is close to, the fuller one; null when neither is, or nothing is known. */
export function nearLimit(limits: Limits, threshold = NEAR_PERCENT): Near | null {
  if (!limits || "error" in limits) return null;
  const found = (["session", "week"] as const)
    .map((which) => ({ which, percent: Number(limits[which]?.percent) }))
    .filter((n) => Number.isFinite(n.percent) && n.percent >= threshold)
    .sort((a, b) => b.percent - a.percent);
  return found[0] ?? null;
}

/** A terminal as the hand-over sees it. */
export interface Member {
  id: string;
  name: string;
  running: boolean;
  /** What its usage counts against: the Claude account's folder, or the terminal's kind for Ollama and Free models. */
  account: string;
  contained: boolean;
  role?: string;
  near: Near | null;
}

export interface Offer {
  from: Member;
  tasks: Task[];
  /** Who could take them, the best first: same role, then any. */
  to: Member[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const open = (t: Task) => t.status !== "done" && t.status !== "failed";

/** The tasks a terminal still has open on the board. */
export function openTasksOf(name: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => open(t) && same(t.to, name));
}

/**
 * Who can take over from `from`: running, not contained (it could not reach the project), on another
 * account (terminals on one account share its limit) and not near a limit itself.
 */
export function takersFor(from: Member, team: Member[]): Member[] {
  return team
    .filter((m) => m.id !== from.id && m.running && !m.contained && m.account !== from.account && !m.near)
    .sort((a, b) => Number(!!from.role && b.role === from.role) - Number(!!from.role && a.role === from.role));
}

/** The hand-over to offer for a terminal near its limit, or null when there is nothing to offer or nobody to take it. */
export function handoverOffer(fromId: string, tasks: Task[], team: Member[]): Offer | null {
  const from = team.find((m) => m.id === fromId);
  if (!from?.near) return null;
  const mine = openTasksOf(from.name, tasks);
  const to = takersFor(from, team);
  return mine.length && to.length ? { from, tasks: mine, to } : null;
}

/** The last lines on a terminal's screen worth passing on: plain text, no secrets, at most `max` characters. */
export function screenTail(screen: string, lines = 12, max = 800): string {
  const kept = String(screen ?? "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[─━│┃╭╮╯╰┌┐└┘├┤┬┴┼═║]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-lines)
    .join("\n");
  return redact(kept).slice(-max);
}

/** The message the taker gets: which tasks, why, where things stood, and how to report. */
export function handoverMessage(from: Member, tasks: Task[], screen = ""): string {
  // A percent of 0 means only that Claude Code said it is close, not how close.
  const why = from.near?.percent
    ? `${from.name} is at ${Math.round(from.near.percent)}% of its ${from.near.which === "week" ? "weekly" : "session"} usage limit`
    : `${from.name} is near its usage limit`;
  const parts = [`${why}, so the user handed its open ${tasks.length === 1 ? "task" : "tasks"} to you.`];
  for (const t of tasks) {
    let line = `Task ${t.id} "${t.title}" (${t.status}${t.from ? `, from ${t.from}` : ""}).`;
    if (t.files.length) line += ` Files: ${t.files.join(", ")}.`;
    if (t.done) line += ` Done means: ${t.done}`;
    if (t.note) line += ` Latest note: ${t.note}`;
    parts.push(line);
  }
  const tail = screenTail(screen);
  if (tail) parts.push(`Last on ${from.name}'s screen:\n${tail}`);
  parts.push(`Carry on from there, and use update_task with each task's id as you go. Check the files first: ${from.name} may have left work half done.`);
  return parts.join("\n");
}
