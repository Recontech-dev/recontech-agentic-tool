// Team sharing: a project's memory written to a file inside the project, so it travels with the
// project (for example through its git repository) and teammates can import it into their own brain.
// Only notes and the titles of unfinished work are shared; prompts and conversations never are.

import * as fs from "node:fs";
import * as path from "node:path";

import { redact } from "./redact";
import { addNote, normalise, notes } from "./store";

export const SHARE_FILE = ".alt-brain.json";

export interface Shared {
  version: 1;
  project: string;
  exported: string;
  notes: { time: string; text: string }[];
  unfinished: { title: string; ended: string }[];
}

export const shareFile = (folder: string) => path.join(folder, SHARE_FILE);

/** Write the project's notes (and the unfinished work passed in) to the share file. Returns the note count. */
export function exportProject(folder: string, unfinished: { title: string; ended: string }[] = []): number {
  const shared: Shared = {
    version: 1,
    project: path.basename(folder),
    exported: new Date().toISOString().slice(0, 10),
    // Notes are masked when stored; masking again covers anything stored before a pattern was added.
    notes: notes(folder).map((n) => ({ time: n.time, text: redact(n.text) })),
    unfinished: unfinished.map((u) => ({ title: redact(u.title), ended: u.ended.slice(0, 10) })),
  };
  fs.writeFileSync(shareFile(folder), JSON.stringify(shared, null, 2) + "\n", "utf8");
  return shared.notes.length;
}

export function readShared(folder: string): Shared | null {
  try {
    const data = JSON.parse(fs.readFileSync(shareFile(folder), "utf8"));
    if (data?.version !== 1 || !Array.isArray(data.notes)) return null;
    return { ...data, unfinished: Array.isArray(data.unfinished) ? data.unfinished : [] };
  } catch {
    return null;
  }
}

/** Notes in the share file that this brain does not have yet. */
export function newSharedNotes(folder: string): { time: string; text: string }[] {
  const shared = readShared(folder);
  if (!shared) return [];
  const have = new Set(notes(folder).map((n) => normalise(n.text)));
  return shared.notes.filter((n) => typeof n?.text === "string" && n.text.trim() && !have.has(normalise(n.text)));
}

/** Add the share file's new notes to this brain. Returns how many were added. */
export function importProject(folder: string): number {
  const fresh = newSharedNotes(folder);
  for (const note of fresh) addNote(folder, note.text.slice(0, 1000), "shared");
  return fresh.length;
}
