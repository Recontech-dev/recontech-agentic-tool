// The workspace settings: Claude Code profiles and the folder they work in.

import * as fs from "node:fs";
import * as path from "node:path";

import { defaultClaudeDir, profilesDir, workspaceFile } from "./paths";
import { Source } from "./sessions";

export const MAX_PROFILES = 6;
export const COLORS = ["#e06c75", "#61afef", "#98c379", "#e5c07b", "#c678dd", "#56b6c2"];

export interface Profile {
  id: string;
  name: string;
  color: string;
  /** Claude Code's config folder for this profile; null means Claude Code's normal one (~/.claude). */
  configDir: string | null;
  /**
   * "claude" signs in to Claude as usual; "ollama" runs Claude Code on a local Ollama model, offline;
   * "free" runs it on the user's free AI providers and is started by hand, for when a limit is hit.
   */
  kind?: "claude" | "ollama" | "free";
  /** The Ollama model, for an "ollama" profile. */
  model?: string;
}

export interface NewProfile {
  name: string;
  kind?: "claude" | "ollama";
  model?: string;
  /** Reuse a Claude Code folder that is already signed in, instead of making a new one. */
  configDir?: string;
}

export interface Workspace {
  folder: string;
  profiles: Profile[];
  layout: "grid" | "tabs";
  /** Existing Claude Code folders the user chose not to add, so the app does not offer them again. */
  dismissedFolders?: string[];
  /** Smart sorting (Laya) is off unless the user turns it on; its model is stored in modelDir. */
  sorting?: { enabled: boolean; modelDir: string };
}

/** Claude Code folders that already exist, such as ~/.claude-account1 made by an earlier multi-terminal setup. */
export function existingClaudeFolders(): string[] {
  // The folder that holds ~/.claude, so tests can point it somewhere else.
  const home = path.dirname(defaultClaudeDir());
  try {
    return fs
      .readdirSync(home, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\.claude-[\w-]+$/.test(e.name))
      .map((e) => path.join(home, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** "Account 1" for ~/.claude-account1, otherwise the part after ".claude-". */
export function nameForFolder(folder: string): string {
  return path.basename(folder).replace(/^\.claude-/, "").replace(/^account(\d+)$/i, "Account $1");
}

/** Signed-in Claude Code folders on this computer that are neither a profile yet nor dismissed. */
export function unusedClaudeFolders(workspace: Workspace): string[] {
  const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  return existingClaudeFolders().filter(
    (folder) =>
      !workspace.profiles.some((p) => p.configDir && same(p.configDir, folder)) &&
      !(workspace.dismissedFolders ?? []).some((d) => same(d, folder)),
  );
}

/** Add each unused folder as a profile, as far as the limit allows. Returns how many were added. */
export function adoptFolders(workspace: Workspace): number {
  let added = 0;
  for (const folder of unusedClaudeFolders(workspace)) {
    if (workspace.profiles.length >= MAX_PROFILES) break;
    let name = nameForFolder(folder);
    for (let n = 2; workspace.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()); n++) name = `${nameForFolder(folder)} ${n}`;
    addProfile(workspace, { name, configDir: folder });
    added++;
  }
  return added;
}

export function dismissFolders(workspace: Workspace): void {
  workspace.dismissedFolders = [...(workspace.dismissedFolders ?? []), ...unusedClaudeFolders(workspace)];
  save(workspace);
}

export function load(): Workspace {
  try {
    const data = JSON.parse(fs.readFileSync(workspaceFile(), "utf8"));
    if (Array.isArray(data.profiles) && data.profiles.length) return { layout: "grid", ...data };
  } catch {
    // First start, or an unreadable file: begin with the normal Claude Code sign-in,
    // plus any signed-in Claude Code folders already on this computer.
  }
  const profiles: Profile[] = [{ id: "default", name: "Main", color: COLORS[0], configDir: null, kind: "claude" }];
  for (const folder of existingClaudeFolders().slice(0, MAX_PROFILES - 1)) {
    const name = nameForFolder(folder);
    profiles.push({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, color: COLORS[profiles.length], configDir: folder, kind: "claude" });
  }
  return { folder: "", layout: "grid", profiles };
}

export function save(workspace: Workspace): void {
  fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
  fs.writeFileSync(workspaceFile(), JSON.stringify(workspace, null, 2), "utf8");
}

export function addProfile(workspace: Workspace, request: NewProfile | string): Profile {
  const wanted = typeof request === "string" ? { name: request } : request;
  const clean = String(wanted.name ?? "").trim().slice(0, 30);
  const kind = wanted.kind === "ollama" ? "ollama" : "claude";
  if (!clean) throw new Error("Give the profile a name.");
  if (workspace.profiles.length >= MAX_PROFILES) throw new Error(`There can be at most ${MAX_PROFILES} profiles.`);
  if (workspace.profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new Error("That name is already used.");
  if (kind === "ollama" && !wanted.model?.trim()) throw new Error("Choose an Ollama model.");
  if (wanted.configDir && !fs.existsSync(wanted.configDir)) throw new Error("That Claude Code folder does not exist.");
  if (wanted.configDir && workspace.profiles.some((p) => p.configDir && path.resolve(p.configDir) === path.resolve(wanted.configDir!))) {
    throw new Error("Another profile already uses that folder.");
  }
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
  let id = slug;
  for (let n = 2; workspace.profiles.some((p) => p.id === id); n++) id = `${slug}-${n}`;
  const used = new Set(workspace.profiles.map((p) => p.color));
  const profile: Profile = {
    id, name: clean, kind,
    color: COLORS.find((c) => !used.has(c)) ?? COLORS[0],
    configDir: wanted.configDir || path.join(profilesDir(), id),
  };
  if (kind === "ollama") profile.model = wanted.model!.trim();
  fs.mkdirSync(profile.configDir!, { recursive: true });
  workspace.profiles.push(profile);
  save(workspace);
  return profile;
}

export const FREE_PROFILE_ID = "free-models";

/** Add the special Free models terminal if it is not there yet. */
export function enableFreeProfile(workspace: Workspace): void {
  if (workspace.profiles.some((p) => p.kind === "free")) return;
  if (workspace.profiles.length >= MAX_PROFILES) throw new Error(`Remove a profile first: there can be at most ${MAX_PROFILES}.`);
  const configDir = path.join(profilesDir(), FREE_PROFILE_ID);
  fs.mkdirSync(configDir, { recursive: true });
  workspace.profiles.push({ id: FREE_PROFILE_ID, name: "Free models", color: "#56b6c2", configDir, kind: "free" });
  save(workspace);
}

export function removeProfile(workspace: Workspace, id: string): void {
  if (workspace.profiles.length <= 1) throw new Error("Keep at least one profile.");
  workspace.profiles = workspace.profiles.filter((p) => p.id !== id);
  save(workspace);
}

/** Where each profile's Claude Code keeps its session transcripts. */
export function sources(workspace: Workspace = load()): Source[] {
  return workspace.profiles.map((p) => ({ profile: p.name, configDir: p.configDir ?? defaultClaudeDir() }));
}
