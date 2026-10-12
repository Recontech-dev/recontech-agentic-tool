// Token usage: how many tokens Claude Code used this week, month, year and in total, counted from
// the usage figures Claude Code writes into its own session transcripts. Transcripts can add up to
// gigabytes, so each file is read once and afterwards only from where the last read stopped; the
// counts per message are kept in a small cache file. Nothing is sent anywhere.

import * as fs from "node:fs";
import * as path from "node:path";

import { home } from "./paths";

export interface Tokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /**
   * Input, output and cache writes. Cache reads are left out: each turn reads the whole conversation
   * back from the cache, so they are usually over 95% of the raw sum and would drown out the rest.
   */
  total: number;
}

export interface UsageSummary {
  week: Tokens;
  month: Tokens;
  year: Tokens;
  all: Tokens;
  /** When the first counted message was sent (ms), or 0 when there is none. */
  since: number;
  /** The same per Claude Code folder (keyed by its resolved path), for each terminal's own bar. */
  folders: Record<string, FolderUsage>;
}

/** One Claude Code folder's usage (one Claude account): its periods, and what a terminal's own bar shows. */
export interface FolderUsage {
  week: Tokens;
  month: Tokens;
  year: Tokens;
  all: Tokens;
  since: number;
  /** The 5-hour session window in progress (Claude's session limit counts per window), or null when none is. */
  session: { start: number; end: number; tokens: Tokens } | null;
  /** When its latest answer was sent (ms), or 0. */
  last: number;
}

/** Claude's session limits count usage in windows of 5 hours from the first message of a window. */
export const SESSION_MS = 5 * 60 * 60 * 1000;

/** One answer from the model: when it was sent, and its input, output, cache-write and cache-read tokens. */
type Entry = [time: number, input: number, output: number, cacheWrite: number, cacheRead: number];

interface FileState {
  size: number;
  modified: number;
  /** How far the file has been read: always the end of a complete line. */
  offset: number;
  messages: Record<string, Entry>;
}

interface Cache {
  version: number;
  files: Record<string, FileState>;
}

// 2: an answer written over several lines keeps its largest counts, not the first line's.
const VERSION = 2;
export const usageFile = () => path.join(home(), "brain", "usage.json");

function loadCache(): Cache {
  try {
    const data = JSON.parse(fs.readFileSync(usageFile(), "utf8"));
    if (data?.version === VERSION && data.files && typeof data.files === "object") return data;
    // From version 1, transcripts still on disk are counted again. Ones Claude Code has since deleted
    // (it removes old ones by itself) are only in this cache, so their counts are kept.
    if (data?.version === 1 && data.files && typeof data.files === "object") {
      for (const file of Object.keys(data.files)) if (fs.existsSync(file)) delete data.files[file];
      return { version: VERSION, files: data.files };
    }
  } catch {
    // Missing or unreadable: everything is counted again from the transcripts.
  }
  return { version: VERSION, files: {} };
}

/** Every transcript under a Claude Code folder, including the ones its subagents write. */
function transcripts(configDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  };
  walk(path.join(configDir, "projects"), 0);
  return found;
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The usage on one transcript line, with the key that identifies its message, or null. */
export function usageOf(line: string): [string, Entry] | null {
  // Most lines are prompts, tool output and the like; only the model's answers carry usage.
  if (!line.includes('"usage"')) return null;
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = data?.message?.usage;
  const id = data?.message?.id;
  const time = Date.parse(data?.timestamp);
  if (!usage || typeof id !== "string" || !Number.isFinite(time)) return null;
  // One answer is written as several lines (one per content block), each with the same usage.
  const key = `${id}:${data.requestId ?? ""}`;
  const entry: Entry = [time, count(usage.input_tokens), count(usage.output_tokens), count(usage.cache_creation_input_tokens), count(usage.cache_read_input_tokens)];
  return entry[1] + entry[2] + entry[3] + entry[4] ? [key, entry] : null;
}

/** Reads a transcript from `start`, up to the end of its last complete line. Returns where it stopped. */
async function readFrom(file: string, start: number, into: Record<string, Entry>): Promise<number> {
  const handle = await fs.promises.open(file, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    let offset = start;
    let carry = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset + carry.length);
      if (!bytesRead) break;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      // Only whole lines are read; a last line without its newline may still be being written.
      let from = 0;
      for (let at = data.indexOf(0x0a); at !== -1; at = data.indexOf(0x0a, from)) {
        const found = usageOf(data.toString("utf8", from, at));
        // The lines of one answer can carry growing counts while it streams; the largest are its final ones.
        // Its time stays that of its first line.
        if (found) into[found[0]] = into[found[0]] ? (into[found[0]].map((n, i) => (i ? Math.max(n, found[1][i]) : n)) as Entry) : found[1];
        from = at + 1;
      }
      offset += from;
      carry = data.subarray(from);
    }
    return offset;
  } finally {
    await handle.close();
  }
}

let scanning: Promise<UsageSummary> | null = null;

/**
 * Brings the counts up to date with the transcripts in these Claude Code folders and sums them up.
 * Calls made while a scan is running share it.
 */
export function tokenUsage(configDirs: string[], now = new Date()): Promise<UsageSummary> {
  scanning ??= scan(configDirs, now).finally(() => (scanning = null));
  return scanning;
}

async function scan(configDirs: string[], now: Date): Promise<UsageSummary> {
  const cache = loadCache();
  const seen = new Set<string>();
  let changed = false;
  for (const dir of new Set(configDirs.map((d) => path.resolve(d)))) {
    for (const file of transcripts(dir)) {
      seen.add(file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      const known = cache.files[file];
      if (known && known.size === stat.size && known.modified === stat.mtimeMs) continue;
      // Transcripts only grow. One that shrank was rewritten, so it is read again from the start.
      const state: FileState = known && stat.size >= known.size ? known : { size: 0, modified: 0, offset: 0, messages: {} };
      try {
        state.offset = await readFrom(file, state.offset, state.messages);
      } catch {
        continue;
      }
      state.size = stat.size;
      state.modified = stat.mtimeMs;
      cache.files[file] = state;
      changed = true;
    }
  }
  // A transcript that was deleted still counts: the tokens were used all the same. Only files of
  // folders that are no longer profiles drop out, as they are not passed in.
  const wanted = [...new Set(configDirs.map((d) => path.resolve(d, "projects") + path.sep))];
  for (const file of Object.keys(cache.files)) {
    if (!seen.has(file) && !wanted.some((root) => file.startsWith(root))) {
      delete cache.files[file];
      changed = true;
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(cache), "utf8");
  }
  const folders: Record<string, FolderUsage> = {};
  for (const dir of new Set(configDirs.map((d) => path.resolve(d)))) {
    const root = path.join(dir, "projects") + path.sep;
    folders[dir] = folderUsage(Object.entries(cache.files).filter(([file]) => file.startsWith(root)).map(([, state]) => state), now);
  }
  return { ...summarize(Object.values(cache.files), now), folders };
}

/**
 * One folder's week and current session window. A window starts at the hour of the first message
 * after the previous window ended and lasts 5 hours, which is how Claude's session limit is reckoned
 * as far as it can be seen from the outside; the real limit and its exact window are not on disk.
 */
export function folderUsage(files: { messages: Record<string, Entry> }[], now = new Date()): FolderUsage {
  const entries = new Map<string, Entry>();
  for (const file of files) for (const [key, entry] of Object.entries(file.messages)) if (!entries.has(key)) entries.set(key, entry);
  const sorted = [...entries.values()].sort((a, b) => a[0] - b[0]);
  let start = 0;
  for (const [time] of sorted) {
    if (time > now.getTime()) break;
    if (!start || time >= start + SESSION_MS) start = Math.floor(time / 3_600_000) * 3_600_000;
  }
  let session: FolderUsage["session"] = null;
  if (start && now.getTime() < start + SESSION_MS) {
    const tokens = empty();
    for (const entry of sorted) if (entry[0] >= start && entry[0] <= now.getTime()) add(tokens, entry);
    session = { start, end: start + SESSION_MS, tokens };
  }
  return { ...summarize(files, now), session, last: sorted.length ? sorted[sorted.length - 1][0] : 0 };
}

const empty = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 });
function add(t: Tokens, [, input, output, cacheWrite, cacheRead]: Entry): void {
  t.input += input;
  t.output += output;
  t.cacheWrite += cacheWrite;
  t.cacheRead += cacheRead;
  t.total += input + output + cacheWrite;
}

/** Sums the messages per period: this week (from Monday), this month and this year, in local time, and all of it. */
export function summarize(files: { messages: Record<string, Entry> }[], now = new Date()): Omit<UsageSummary, "folders"> {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(day);
  week.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  const starts = { week: week.getTime(), month: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), year: new Date(now.getFullYear(), 0, 1).getTime() };
  const summary: Omit<UsageSummary, "folders"> = { week: empty(), month: empty(), year: empty(), all: empty(), since: 0 };
  // The same answer can be in two transcripts (a resumed session copies its history); it counts once.
  const counted = new Set<string>();
  for (const file of files) {
    for (const [key, entry] of Object.entries(file.messages)) {
      if (counted.has(key)) continue;
      counted.add(key);
      const time = entry[0];
      add(summary.all, entry);
      if (time >= starts.year) add(summary.year, entry);
      if (time >= starts.month) add(summary.month, entry);
      if (time >= starts.week) add(summary.week, entry);
      if (!summary.since || time < summary.since) summary.since = time;
    }
  }
  return summary;
}
