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
  source: string;
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

export function addNote(folder: string, text: string, source: string): string {
  const dir = projectDir(folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ folder: realFolder(folder) }), "utf8");
  const note: Note = { time: stamp(), text: redact(text.trim()), source };
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
  const terms = new Set((query.toLowerCase().match(/\w+/g) ?? []).filter((w) => w.length > 2));
  let found = 0;
  for (const term of terms) if (lower.includes(term)) found++;
  return found;
}
