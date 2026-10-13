// A git worktree per Builder: each Builder terminal works in its own checkout on its own branch, so two
// Builders in one project never write over each other's files. The worktrees live beside the project,
// in "<project>.worktrees/<terminal>", on branches named "recon/<terminal>"; the Manager merges them.
// git runs without a shell and never blocks: every call here is asynchronous.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

/** A terminal id that is safe as a folder and branch name. */
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/i;

export interface Worktree {
  dir: string;
  /** The branch checked out there, without "refs/heads/"; "" for a detached HEAD. */
  branch: string;
}

export interface WorktreeStatus {
  /** Files changed and not committed. */
  dirty: number;
  /** Commits on the worktree's branch that the base branch does not have yet. */
  ahead: number;
  /** Commits on the base branch that the worktree's branch does not have yet. */
  behind: number;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

function checkId(id: string): void {
  if (!SAFE_ID.test(String(id ?? ""))) throw new Error("That terminal name cannot be used for a worktree.");
}

/** Paths as git and Windows may spell them differently: slashes, and case on Windows. */
function samePath(a: string, b: string): boolean {
  // A real path, so a short 8.3 name (C:\Users\ADMIN~1) and the long one git prints compare equal.
  const real = (p: string) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const norm = (p: string) => (process.platform === "win32" ? real(p).toLowerCase() : real(p));
  return norm(a) === norm(b);
}

export const branchFor = (id: string) => `recon/${id}`;

/** Where a terminal's worktree for the project at `root` goes: beside the project, never inside it. */
export function worktreeDir(root: string, id: string): string {
  checkId(id);
  const base = path.resolve(root);
  return path.join(path.dirname(base), `${path.basename(base)}.worktrees`, id);
}

/** The top folder of the git repository `folder` is in, or null when it is not in one. */
export async function repoRoot(folder: string): Promise<string | null> {
  try {
    return path.resolve((await git(folder, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
}

/** Every checkout of the repository, the main one first. */
export async function listWorktrees(root: string): Promise<Worktree[]> {
  const found: Worktree[] = [];
  for (const block of (await git(root, ["worktree", "list", "--porcelain"])).split(/\r?\n\r?\n/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    if (!dir) continue;
    found.push({ dir: path.resolve(dir), branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "" });
  }
  return found;
}

/**
 * The terminal's worktree, made if it is not there yet. A branch left from an earlier worktree is
 * checked out again, so its work carries on; otherwise a new branch starts from the project's HEAD.
 */
export async function ensureWorktree(root: string, id: string): Promise<Worktree & { created: boolean }> {
  const dir = worktreeDir(root, id);
  const branch = branchFor(id);
  const existing = (await listWorktrees(root)).find((w) => samePath(w.dir, dir));
  if (existing) return { ...existing, created: false };
  if (fs.existsSync(dir)) throw new Error(`${dir} exists but is not a worktree of this project; move it away first.`);
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    throw new Error("The project needs at least one commit before Builders can get their own worktree.");
  }
  let known = true;
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    known = false;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(root, known ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"]);
  return { dir, branch, created: true };
}

/** How far a worktree is from the base branch it will be merged into. */
export async function worktreeStatus(dir: string, base: string): Promise<WorktreeStatus> {
  const dirty = (await git(dir, ["status", "--porcelain"])).split(/\r?\n/).filter(Boolean).length;
  const [behind, ahead] = (await git(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`])).trim().split(/\s+/).map(Number);
  return { dirty, ahead: ahead || 0, behind: behind || 0 };
}

/**
 * Take a terminal's worktree away. Its branch stays, so committed work is never lost. Uncommitted
 * changes are: the worktree is kept unless `force` says to throw them away.
 */
export async function removeWorktree(root: string, id: string, force = false): Promise<void> {
  const dir = worktreeDir(root, id);
  if (!(await listWorktrees(root)).some((w) => samePath(w.dir, dir))) return;
  if (!force && (await git(dir, ["status", "--porcelain"])).trim()) throw new Error("The worktree has uncommitted changes; commit them or remove it anyway.");
  await git(root, force ? ["worktree", "remove", "--force", dir] : ["worktree", "remove", dir]);
}
