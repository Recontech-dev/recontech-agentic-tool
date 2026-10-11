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
}

export interface Workspace {
  folder: string;
  profiles: Profile[];
  layout: "grid" | "tabs";
}

export function load(): Workspace {
  try {
    const data = JSON.parse(fs.readFileSync(workspaceFile(), "utf8"));
    if (Array.isArray(data.profiles) && data.profiles.length) return { layout: "grid", ...data };
  } catch {
    // First start, or an unreadable file: begin with one profile using the normal Claude Code login.
  }
  return { folder: "", layout: "grid", profiles: [{ id: "default", name: "Main", color: COLORS[0], configDir: null }] };
}

export function save(workspace: Workspace): void {
  fs.mkdirSync(path.dirname(workspaceFile()), { recursive: true });
  fs.writeFileSync(workspaceFile(), JSON.stringify(workspace, null, 2), "utf8");
}

export function addProfile(workspace: Workspace, name: string): Profile {
  const clean = name.trim().slice(0, 30);
  if (!clean) throw new Error("Give the profile a name.");
  if (workspace.profiles.length >= MAX_PROFILES) throw new Error(`There can be at most ${MAX_PROFILES} profiles.`);
  if (workspace.profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new Error("That name is already used.");
  const slug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
  let id = slug;
  for (let n = 2; workspace.profiles.some((p) => p.id === id); n++) id = `${slug}-${n}`;
  const used = new Set(workspace.profiles.map((p) => p.color));
  const profile: Profile = {
    id, name: clean, color: COLORS.find((c) => !used.has(c)) ?? COLORS[0], configDir: path.join(profilesDir(), id),
  };
  fs.mkdirSync(profile.configDir!, { recursive: true });
  workspace.profiles.push(profile);
  save(workspace);
  return profile;
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
