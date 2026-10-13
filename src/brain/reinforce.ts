// Memories strengthen with use and decay with disuse. "Use" is a recall returning an item, not the
// passage of real time: a logical clock ticks once per recall, so idle days never erase anything, only
// other recalls do. Items recalled together also get an edge between them, for graph expansion later.
//
// The app and every terminal's brain server share one reinforce.json. A recall changes it under a lock
// file held over the whole read, change and write (git's lockfile pattern), so no process overwrites
// another's update, and reads pick up a file another process changed.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { home } from "./paths";

/** Each tick a memory goes untouched, its score and its edges fade by this much. */
export const DECAY_RATE = 0.97;
/** How much a recall raises an item's score, and an edge between two co-recalled items. */
export const USE_BOOST = 1;
/** Scores and edges that faded below this are dropped when the file is written. */
export const PRUNE_BELOW = 0.01;
/** At most this many edges and items are kept, the strongest; 10 hits make 45 edges in one recall. */
export const MAX_EDGES = 5000;
export const MAX_ITEMS = 5000;
/** A lock older than this was left by a process that died while holding it. */
const STALE_LOCK_MS = 5000;
/** How long a recall waits for the lock before it skips reinforcing. The lock is held for milliseconds, so a wait this long only happens when processes start up together. */
const LOCK_WAIT_MS = 2000;

export interface Item {
  score: number;
  uses: number;
  lastTick: number;
}

export interface EdgeEntry {
  weight: number;
  lastTick: number;
}

interface Store {
  clock: number;
  items: Record<string, Item>;
  edges: Record<string, EdgeEntry>;
}

const file = () => path.join(home(), "brain", "reinforce.json");
const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

/** The file as last read, and which version of it that was, so a change by another process is noticed. */
let store: Store | null = null;
let seen = "";

const versionOf = (target: string): string => {
  try {
    const stat = fs.statSync(target);
    return `${target}|${stat.ino}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    return `${target}|none`;
  }
};

/** The current state: read again whenever the file changed since the last read (another process recalled meanwhile). */
function load(): Store {
  const target = file();
  const version = versionOf(target);
  if (store && version === seen) return store;
  try {
    const read = JSON.parse(fs.readFileSync(target, "utf8"));
    store = { clock: Number(read.clock) || 0, items: read.items ?? {}, edges: read.edges ?? {} };
  } catch {
    store = { clock: 0, items: {}, edges: {} };
  }
  seen = version;
  return store;
}

/** Drops what faded below PRUNE_BELOW and keeps only the strongest MAX_ITEMS items and MAX_EDGES edges. */
function prune(s: Store): void {
  const keep = <T>(entries: Record<string, T>, value: (entry: T) => number, max: number): Record<string, T> => {
    const alive = Object.entries(entries).map(([key, entry]) => ({ key, entry, now: value(entry) })).filter((e) => e.now >= PRUNE_BELOW);
    if (alive.length > max) alive.sort((a, b) => b.now - a.now).length = max;
    return Object.fromEntries(alive.map((e) => [e.key, e.entry]));
  };
  s.items = keep(s.items, (item) => decayed(item.score, s.clock - item.lastTick), MAX_ITEMS);
  s.edges = keep(s.edges, (edge) => decayed(edge.weight, s.clock - edge.lastTick), MAX_EDGES);
}

function save(s: Store): void {
  const target = file();
  prune(s);
  // A name of its own per write, so two writers never share (and clobber) one temp file.
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(s), "utf8");
    fs.renameSync(temp, target);
  } finally {
    try { fs.rmSync(temp, { force: true }); } catch { /* already renamed */ }
  }
  store = s;
  seen = versionOf(target);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `change` holding reinforce.json.lock, created exclusively ("wx") so only one process at a time
 * can hold it. Waiting for it never blocks: the app's main process recalls too, and a synchronous wait
 * would freeze the window. A lock left by a process that died is taken over once it is STALE_LOCK_MS
 * old. false when the lock could not be had in time; the change is then skipped, never forced.
 */
async function locked(change: () => void): Promise<boolean> {
  const lock = file() + ".lock";
  await fs.promises.mkdir(path.dirname(lock), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await fs.promises.open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await fs.promises.stat(lock)).mtimeMs > STALE_LOCK_MS) await fs.promises.rm(lock, { force: true });
      } catch {
        // gone already: try again
      }
      if (Date.now() > until) return false;
      await pause(5 + Math.random() * 10);
    }
  }
  try {
    // Synchronous on purpose while the lock is held: it is a few milliseconds, and nothing else in this
    // process can interleave a read of a half-applied change.
    change();
    return true;
  } finally {
    await fs.promises.rm(lock, { force: true });
  }
}

/** For tests: forget everything kept in memory, as a new process would. */
export function reset(): void {
  store = null;
  seen = "";
}

const decayed = (value: number, ticksAgo: number) => value * DECAY_RATE ** Math.max(0, ticksAgo);

/** An id's current score, decayed as of now; 0 for an id never recalled. */
export function scoreOf(id: string): number {
  const s = load();
  const item = s.items[id];
  return item ? decayed(item.score, s.clock - item.lastTick) : 0;
}

/** Every id's current score, decayed as of now, for the ids that have one. */
export function scores(ids: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of ids) {
    const s = scoreOf(id);
    if (s > 0) result[id] = s;
  }
  return result;
}

/** The ids recalled together with `id`, and the decayed strength of that edge, strongest first. */
export function neighbours(id: string): { id: string; weight: number }[] {
  const s = load();
  const found: { id: string; weight: number }[] = [];
  for (const key of Object.keys(s.edges)) {
    const [a, b] = key.split("\u0000");
    const other = a === id ? b : b === id ? a : null;
    if (!other) continue;
    const entry = s.edges[key];
    const weight = decayed(entry.weight, s.clock - entry.lastTick);
    if (weight > 0.01) found.push({ id: other, weight });
  }
  return found.sort((x, y) => y.weight - x.weight);
}

/** Every edge still worth keeping, decayed as of now, for feeding into a centrality score. */
export function allEdges(): { a: string; b: string; weight: number }[] {
  const s = load();
  return Object.entries(s.edges)
    .map(([key, entry]) => {
      const [a, b] = key.split("\u0000");
      return { a, b, weight: decayed(entry.weight, s.clock - entry.lastTick) };
    })
    .filter((e) => e.weight > 0.01);
}

/**
 * A recall just returned these ids together: the logical clock ticks once, each id's score rises
 * (decayed first for the ticks it sat untouched), and every pair recalled together gets a stronger
 * edge between them. Call this once per recall that returns at least one id.
 */
export async function touch(ids: string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (!unique.length) return true;
  return locked(() => touchLocked(unique));
}

function touchLocked(unique: string[]): void {
  // Read under the lock and fresh from disk, so what other processes wrote since is built on, not overwritten.
  seen = "";
  const s = load();
  s.clock += 1;
  for (const id of unique) {
    const before = s.items[id];
    const base = before ? decayed(before.score, s.clock - before.lastTick) : 0;
    s.items[id] = { score: base + USE_BOOST, uses: (before?.uses ?? 0) + 1, lastTick: s.clock };
  }
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const key = pairKey(unique[i], unique[j]);
      const before = s.edges[key];
      const base = before ? decayed(before.weight, s.clock - before.lastTick) : 0;
      s.edges[key] = { weight: base + USE_BOOST, lastTick: s.clock };
    }
  }
  save(s);
}
