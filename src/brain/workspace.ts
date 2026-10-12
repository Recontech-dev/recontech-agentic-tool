// The workspace settings: Claude Code profiles and the folder they work in.

import * as fs from "node:fs";
import * as path from "node:path";

import { CUSTOM_ROLE_PREFIX, MAX_CUSTOM_ROLES, MAX_ROLE_NAME, MAX_ROLE_PROMPT, Role, allRoles, cleanRolePrompt, isBuiltInRole } from "./kits";
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
  /** The terminal's job in the workspace: "builder", "reviewer", "tester", one of the user's own roles, or none. */
  role?: string;
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
  /** Project kit chosen by hand, per project folder. A folder without an entry uses the detected kit. */
  kits?: Record<string, string>;
  /** Terminal text size and the brain panel's width, as the user left them. */
  fontSize?: number;
  brainWidth?: number;
  /** Whether the Files panel (the project folder's files) is shown. */
  filesOpen?: boolean;
  /** Whether Hey Recon listens for its wake word. On unless the user turned it off. */
  voiceOn?: boolean;
  /**
   * Whether the Free models terminal is kept in a container: its own empty folder, no project files,
   * no memory, no reading of other terminals. On unless the user turns it off.
   */
  freeContained?: boolean;
  /** Existing Claude Code folders the user chose not to add, so the app does not offer them again. */
  dismissedFolders?: string[];
  /** Terminal roles the user made in the role manager, next to the built-in ones. */
  roles?: Role[];
  /** Smart sorting (Laya) is off unless the user turns it on; its model is stored in modelDir. */
  sorting?: { enabled: boolean; modelDir: string };
  /**
   * Token budgets the user set for one 5-hour session and one week, which each Claude terminal's bar
   * fills toward. Claude's real limits are not on this computer, so these are the user's own figures.
   */
  usageBudget?: { session?: number; week?: number };
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

/** Set by load() when workspace.json existed but could not be read, so the caller can tell the user. */
let recoveryNotice: string | null = null;
/** The notice from the last load(), if any; reading it clears it so it is shown only once. */
export function takeRecoveryNotice(): string | null {
  const notice = recoveryNotice;
  recoveryNotice = null;
  return notice;
}

export function load(): Workspace {
  const file = workspaceFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data.profiles) && data.profiles.length) return { layout: "grid", ...data };
  } catch (error) {
    // A missing file is just a first start. A file that exists but fails to parse, or has no
    // profiles, is moved aside instead of silently replaced, since the next save would erase it.
    if (fs.existsSync(file)) {
      const backup = `${file}.bad-${Date.now()}`;
      try {
        fs.renameSync(file, backup);
        recoveryNotice = `Your workspace file could not be read (${(error as Error).message}). It was saved as ${backup} and the workspace was reset to defaults.`;
      } catch {
        // Could not even move it aside; fall through to defaults without a notice.
      }
    }
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

/** True when this profile's terminal must be kept away from the user's projects and memory. */
export function isContained(workspace: Workspace, profile: Profile | undefined): boolean {
  return profile?.kind === "free" && workspace.freeContained !== false;
}

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

/**
 * Renames a profile. The id (what sessions, the graph and control messages key off once a
 * terminal has started) never changes, only the display name validated the same way addProfile does.
 */
export function renameProfile(workspace: Workspace, id: string, name: string): Profile {
  const profile = workspace.profiles.find((p) => p.id === id);
  if (!profile) throw new Error("That profile is not in this workspace any more.");
  const clean = String(name ?? "").trim().slice(0, 30);
  if (!clean) throw new Error("Give the profile a name.");
  if (workspace.profiles.some((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase())) throw new Error("That name is already used.");
  profile.name = clean;
  save(workspace);
  return profile;
}

/**
 * Adds a role of the user's own, or changes one (when id names an existing custom role).
 * Built-in roles cannot be changed; copy one into a new role instead.
 */
export function saveRole(workspace: Workspace, request: { id?: string; name: string; prompt: string }): Role {
  const id = String(request.id ?? "");
  if (id && isBuiltInRole(id)) throw new Error("Built-in roles cannot be changed. Copy it into a new role instead.");
  // Only well-formed custom roles count; anything else in a hand-edited file is dropped on the next save.
  const custom = allRoles(workspace.roles).filter((r) => !isBuiltInRole(r.id));
  const existing = id ? custom.find((r) => r.id === id) : undefined;
  if (id && !existing) throw new Error("That role is not in this workspace any more.");
  const name = String(request.name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_ROLE_NAME);
  const prompt = cleanRolePrompt(request.prompt);
  if (!name) throw new Error("Give the role a name.");
  if (!prompt) throw new Error("Write what a terminal with this role should do.");
  if (prompt.length > MAX_ROLE_PROMPT) throw new Error(`Keep the instructions under ${MAX_ROLE_PROMPT} characters.`);
  // Compared by object, not id: a new role has no id yet, and neither has the built-in "No role".
  if (allRoles(custom).some((r) => r !== existing && r.name.toLowerCase() === name.toLowerCase())) throw new Error("That name is already used.");
  if (existing) {
    // The id stays, so terminals that have this role keep it under its new name.
    existing.name = name;
    existing.prompt = prompt;
    workspace.roles = custom;
    save(workspace);
    return existing;
  }
  if (custom.length >= MAX_CUSTOM_ROLES) throw new Error(`There can be at most ${MAX_CUSTOM_ROLES} roles of your own.`);
  const slug = CUSTOM_ROLE_PREFIX + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role");
  let newId = slug;
  for (let n = 2; custom.some((r) => r.id === newId); n++) newId = `${slug}-${n}`;
  const role: Role = { id: newId, name, prompt };
  workspace.roles = [...custom, role];
  save(workspace);
  return role;
}

/** Removes a role of the user's own. Terminals that had it are left without a role. */
export function removeRole(workspace: Workspace, id: string): void {
  if (isBuiltInRole(id)) throw new Error("Built-in roles cannot be removed.");
  workspace.roles = allRoles(workspace.roles).filter((r) => !isBuiltInRole(r.id) && r.id !== id);
  for (const profile of workspace.profiles) if (profile.role === id) delete profile.role;
  save(workspace);
}

/** Where each profile's Claude Code keeps its session transcripts. */
export function sources(workspace: Workspace = load()): Source[] {
  return workspace.profiles.map((p) => ({ profile: p.name, configDir: p.configDir ?? defaultClaudeDir() }));
}
