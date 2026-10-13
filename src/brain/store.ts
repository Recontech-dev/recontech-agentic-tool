// Notes kept per project. The layout matches the earlier Python tool, so its notes carry over:
// memory/<folder name>-<hash>/notes.jsonl, one JSON note per line, plus project.json.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { memoryDir } from "./paths";
import { redact } from "./redact";

export interface Note {
  time: string;
  text: string;
  /** Who saved it: "claude-code", "app", ... */
  source: string;
  /** "research" for something learned (from the web, docs, an experiment) rather than decided; absent for an ordinary note. */
  kind?: "research";
  /** Where a research finding came from, so it can be checked again later. */
  url?: string;
}

/** Query parameters that carry a credential in a link: dropped from a stored source whatever redact makes of them. */
const SECRET_PARAM = /token|key|sig|signature|auth|code|session|password|secret|credential/i;

/**
 * A web address worth keeping as a note's source: http or https only, one line, without a user name,
 * password, #fragment or secret-looking query parameter, and secrets masked; otherwise "".
 */
export function cleanUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > 500 || /[\s\x00-\x1f\x7f]/.test(text)) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.delete(name);
    return redact(url.toString());
  } catch {
    return "";
  }
}

export interface Project {
  name: string;
  folder: string;
  notes: Note[];
}

export const STOPWORDS = new Set(
  ("this that with from have will uses using used when then than they them their there which would should " +
    "could about into over also only been being were what your just more most some such each very must make " +
    "made need needs does done still left user wants want project please file files code like it's can't don't " +
    "the and for are but not you all any can had her was one our out his how its let may new now see way who " +
    "did get got him own say she too use yes okay sure thanks claude").split(" "),
);

export function realFolder(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return path.resolve(folder);
  }
}

export function projectDir(folder: string): string {
  const resolved = realFolder(folder);
  const digest = createHash("sha1").update(resolved.toLowerCase()).digest("hex").slice(0, 8);
  const name = path.basename(resolved).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return path.join(memoryDir(), `${name}-${digest}`);
}

function readNotes(file: string): Note[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Note];
      } catch {
        return [];
      }
    });
}

function writeNotes(file: string, notes: Note[]): void {
  fs.writeFileSync(file, notes.map((note) => JSON.stringify(note) + "\n").join(""), "utf8");
}

export function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function notes(folder: string): Note[] {
  return readNotes(path.join(projectDir(folder), "notes.jsonl"));
}

/** A note's text reduced to what matters for spotting a repeat: case, spacing and end punctuation ignored. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!?;,\s]+$/g, "").trim();
}

export function addNote(folder: string, text: string, source: string, extra: { kind?: string; url?: string } = {}): string {
  // Saving the same fact twice would only crowd the memory, so a repeat is not added again.
  const same = notes(folder).find((n) => normalise(n.text) === normalise(redact(text.trim())));
  if (same) return same.text;
  const dir = projectDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ folder: realFolder(folder) }), "utf8");
  const note: Note = { time: stamp(), text: redact(text.trim()), source };
  // Only research carries a kind; older notes and ordinary ones look exactly as they always did.
  if (extra.kind === "research") note.kind = "research";
  const url = cleanUrl(extra.url);
  if (url) note.url = url;
  fs.appendFileSync(path.join(dir, "notes.jsonl"), JSON.stringify(note) + "\n", "utf8");
  return note.text;
}

/** Delete the note with this 1-based number; return it, or null if there is no such note. */
export function removeNote(folder: string, number: number): Note | null {
  const kept = notes(folder);
  if (!(number >= 1 && number <= kept.length)) return null;
  const [removed] = kept.splice(number - 1, 1);
  writeNotes(path.join(projectDir(folder), "notes.jsonl"), kept);
  return removed;
}

/** Every project with notes, most recently updated first. */
export function tree(): Project[] {
  if (!fs.existsSync(memoryDir())) return [];
  const projects: Project[] = [];
  for (const entry of fs.readdirSync(memoryDir(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(memoryDir(), entry.name);
    const kept = readNotes(path.join(dir, "notes.jsonl"));
    if (!kept.length || !fs.existsSync(path.join(dir, "project.json"))) continue;
    const folder = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).folder as string;
    projects.push({ name: path.basename(folder), folder, notes: kept });
  }
  return projects.sort((a, b) => b.notes[b.notes.length - 1].time.localeCompare(a.notes[a.notes.length - 1].time));
}

/** Meaningful words of a text, most frequent first. */
export function words(text: string): string[] {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z0-9_+#-]{3,}/g) ?? []) {
    if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([word]) => word);
}

/** A text shortened to its first few meaningful words, for labels in the picture. */
export function label(text: string, limit = 2): string {
  const found = (text.match(/[A-Za-z][A-Za-z0-9_+#-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w.toLowerCase()));
  return found.slice(0, limit).join(" ") || text.slice(0, 20);
}

/** How many of the query's words appear in the text. */
export function score(query: string, text: string): number {
  const lower = text.toLowerCase();
  // Common words ("the", "how", "with") say nothing about the subject, so they do not count as a match.
  const terms = new Set((query.toLowerCase().match(/\w+/g) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
  let found = 0;
  for (const term of terms) if (lower.includes(term)) found++;
  return found;
}

/** A note's id for reinforcement and consolidation: stable across searches, changes only if the text does. */
export function noteId(folder: string, text: string): string {
  return `n:${createHash("sha1").update(realFolder(folder).toLowerCase() + "\u0000" + text).digest("hex").slice(0, 16)}`;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9_+#-]*/g) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * Okapi BM25: how well each doc matches the query, ranking a rare shared word above a common one and
 * a short doc that says it plainly above a long one that mentions it once in passing.
 */
export function bm25(query: string, docs: string[], k1 = 1.5, b = 0.75): number[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !docs.length) return docs.map(() => 0);
  const docTokens = docs.map(tokenize);
  const lengths = docTokens.map((t) => t.length);
  const avgLength = lengths.reduce((sum, len) => sum + len, 0) / docs.length || 1;
  const docFreq = new Map<string, number>();
  for (const term of queryTerms) docFreq.set(term, docTokens.filter((tokens) => tokens.includes(term)).length);
  const n = docs.length;
  return docTokens.map((tokens, i) => {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let total = 0;
    for (const term of queryTerms) {
      const f = counts.get(term) ?? 0;
      if (!f) continue;
      const df = docFreq.get(term)!;
      const idf = Math.log((n - df + 0.5) / (df + 0.5) + 1);
      const denom = f + k1 * (1 - b + (b * lengths[i]) / avgLength);
      total += idf * ((f * (k1 + 1)) / denom);
    }
    return total;
  });
}
