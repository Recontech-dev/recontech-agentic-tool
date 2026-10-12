// The Files panel: what is in the project folder, one level at a time. Every path the window asks
// about is relative to the project folder and must stay inside it.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface Entry {
  name: string;
  /** Path relative to the project folder, with forward slashes. */
  path: string;
  dir: boolean;
}

/** Folders not worth listing: version control internals. */
const HIDDEN = new Set([".git", ".hg", ".svn"]);
/** At most this many entries per folder, so a huge folder does not freeze the window. */
export const MAX_ENTRIES = 2000;

/**
 * Files that a double-click in Windows would run instead of open: programs, scripts and shortcuts.
 * The Files panel shows these in Explorer instead of opening them, so a click never runs anything.
 */
const RUNNABLE = new Set([
  ".exe", ".com", ".bat", ".cmd", ".msi", ".msp", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".mjs", ".cjs", ".wsf", ".wsh",
  ".scr", ".pif", ".lnk", ".url", ".hta", ".cpl", ".reg", ".jar", ".appref-ms", ".application", ".gadget", ".msc", ".sh", ".py", ".pyw",
]);

export function runnable(file: string): boolean {
  return RUNNABLE.has(path.extname(file).toLowerCase());
}

/** The full path of `relative` inside `root`, or an error if it would lead outside it. */
export function inside(root: string, relative: string): string {
  if (!root) throw new Error("Choose a project folder first.");
  const base = path.resolve(root);
  const full = path.resolve(base, String(relative ?? ""));
  const rel = path.relative(base, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("That is outside the project folder.");
  return full;
}

/** One folder's contents: folders first, then files, each alphabetically. */
export function list(root: string, relative = ""): { entries: Entry[]; more: boolean } {
  const dir = inside(root, relative);
  const found = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !(e.isDirectory() && HIDDEN.has(e.name)));
  const entries = found
    .map((e) => ({ name: e.name, path: path.relative(path.resolve(root), path.join(dir, e.name)).split(path.sep).join("/"), dir: e.isDirectory() }))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { entries: entries.slice(0, MAX_ENTRIES), more: entries.length > MAX_ENTRIES };
}

/** Larger files are opened outside the app: the editor is for scripts and code, not data dumps. */
export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const BOM = "\ufeff";

export interface TextFile {
  text: string;
  /** When the file last changed, to notice edits made outside the editor (Claude Code's, for one). */
  mtime: number;
  /** The file started with a UTF-8 byte order mark, so it is written back with one. */
  bom: boolean;
}

/** A text file for the editor, or an error that says why it should be opened elsewhere. */
export function readText(root: string, relative: string): TextFile {
  const full = inside(root, relative);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) throw new Error("That is a folder.");
  if (stat.size > MAX_EDIT_BYTES) throw Object.assign(new Error("Too large to edit here."), { code: "large" });
  const bytes = fs.readFileSync(full);
  // A zero byte near the start means a binary file (an image, an archive, a program), not text.
  if (bytes.subarray(0, 8000).includes(0)) throw Object.assign(new Error("Not a text file."), { code: "binary" });
  const text = bytes.toString("utf8");
  return { text: text.startsWith(BOM) ? text.slice(1) : text, mtime: stat.mtimeMs, bom: text.startsWith(BOM) };
}

/** When a project file last changed, or 0 if it is gone. */
export function changedAt(root: string, relative: string): number {
  try {
    return fs.statSync(inside(root, relative)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Save the editor's text. If the file changed on disk since it was opened (`expected`), nothing is
 * written and `conflict` comes back, unless `force` says the user chose to overwrite it.
 */
export function writeText(root: string, relative: string, text: string, expected: number, bom: boolean, force = false): { mtime: number } | { conflict: true } {
  const full = inside(root, relative);
  if (!force && changedAt(root, relative) !== expected) return { conflict: true };
  fs.writeFileSync(full, (bom ? BOM : "") + String(text), "utf8");
  return { mtime: fs.statSync(full).mtimeMs };
}

/**
 * The file as it was in the last commit, for reviewing what changed since. `null` when the project
 * is not a git repository or the file is new; git is run directly, never through a shell.
 */
export function committed(root: string, relative: string): string | null {
  inside(root, relative);
  try {
    const text = execFileSync("git", ["-C", root, "show", `HEAD:./${relative}`], { encoding: "utf8", maxBuffer: MAX_EDIT_BYTES * 2, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return text.startsWith(BOM) ? text.slice(1) : text;
  } catch {
    return null;
  }
}
