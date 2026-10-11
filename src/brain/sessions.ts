// Past Claude Code sessions. Claude Code saves every session as a transcript in
// <config dir>/projects/<folder>/<session id>.jsonl; this reads them into a small index
// (title, folder, dates, the user's prompts, main words) so nothing is lost when a session ends.

import * as fs from "node:fs";
import * as path from "node:path";

import { defaultClaudeDir, sessionIndexFile } from "./paths";
import { redact } from "./redact";
import { words } from "./store";

export interface Session {
  id: string;
  profile: string;
  folder: string;
  title: string;
  started: string;
  ended: string;
  prompts: string[];
  replies: number;
  keywords: string[];
  file: string;
  modified: number;
}

export interface Source {
  profile: string;
  configDir: string;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PROMPTS = 12;
const PROMPT_CHARS = 300;

/** Text the user typed, without the context blocks the editor and Claude Code add around it. */
export function typedText(text: string): string {
  return text
    .replace(/<(system-reminder|ide_[a-z_]+|command-[a-z-]+|local-command-[a-z-]+|pasted_content)[^>]*>[\s\S]*?<\/\1[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
}

export function readTranscript(file: string, profile: string): Session | null {
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) return null;
  let folder = "", title = "", started = "", ended = "", replies = 0;
  const prompts: string[] = [];
  const said: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "ai-title" && entry.aiTitle) title = String(entry.aiTitle);
    if (entry.timestamp) {
      started ||= entry.timestamp;
      ended = entry.timestamp;
    }
    if (entry.cwd && !folder) folder = entry.cwd;
    if (entry.isSidechain || entry.isMeta || !entry.message) continue;
    if (entry.type === "user") {
      for (const block of textBlocks(entry.message.content)) {
        const typed = typedText(block);
        if (typed && !typed.startsWith("[Request interrupted")) {
          said.push(typed);
          if (prompts.length < MAX_PROMPTS) prompts.push(redact(typed.slice(0, PROMPT_CHARS)));
        }
      }
    } else if (entry.type === "assistant") {
      const text = textBlocks(entry.message.content).join(" ");
      if (text) {
        replies++;
        said.push(text);
      }
    }
  }
  if (!prompts.length || !folder) return null;
  return {
    id: path.basename(file, ".jsonl"),
    profile,
    folder,
    title: redact(title || prompts[0].slice(0, 80)),
    started,
    ended,
    prompts,
    replies,
    keywords: words(said.join(" ")).slice(0, 8),
    file,
    modified: stat.mtimeMs,
  };
}

/** A transcript with nothing to keep (no prompts yet), remembered so it is not read again until it changes. */
interface Skipped {
  skipped: true;
  modified: number;
}

type Index = Record<string, Session | Skipped>;

export function loadIndex(): Index {
  try {
    return JSON.parse(fs.readFileSync(sessionIndexFile(), "utf8"));
  } catch {
    return {};
  }
}

/** Bring the index up to date with the transcripts on disk. Unchanged files are not read again. */
export function refresh(sources: Source[]): { sessions: Session[]; changed: boolean } {
  const index = loadIndex();
  let changed = false;
  const seen = new Set<string>();
  const all = sources.length ? sources : [{ profile: "default", configDir: defaultClaudeDir() }];
  for (const { profile, configDir } of all) {
    const root = path.join(configDir, "projects");
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(root, dir.name))) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(root, dir.name, name);
        const key = `${profile}:${name}`;
        seen.add(key);
        let modified: number;
        try {
          modified = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (index[key]?.modified === modified) continue;
        const session = readTranscript(file, profile);
        const before = index[key];
        index[key] = session ?? { skipped: true, modified };
        if (session || (before && !("skipped" in before))) changed = true;
      }
    }
  }
  // Keep sessions whose transcript was deleted: the brain is meant to outlive Claude Code's own files.
  if (changed) {
    fs.mkdirSync(path.dirname(sessionIndexFile()), { recursive: true });
    fs.writeFileSync(sessionIndexFile(), JSON.stringify(index), "utf8");
  }
  const sessions = Object.values(index)
    .filter((entry): entry is Session => !("skipped" in entry))
    .sort((a, b) => b.ended.localeCompare(a.ended));
  // Skipped files are recorded too, so the index is saved whenever it grew, even when nothing visible changed.
  if (!changed && Object.keys(index).length !== Object.keys(loadIndex()).length) {
    fs.mkdirSync(path.dirname(sessionIndexFile()), { recursive: true });
    fs.writeFileSync(sessionIndexFile(), JSON.stringify(index), "utf8");
  }
  return { sessions, changed };
}

export function sameFolder(a: string, b: string): boolean {
  const clean = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return clean(a) === clean(b);
}
