// Project kits and terminal roles: short standing instructions given to Claude Code when a terminal
// starts, so it works the way that kind of project, and that terminal's job, needs.

import * as fs from "node:fs";
import * as path from "node:path";

export interface Kit {
  id: string;
  name: string;
  prompt: string;
}

export const KITS: Kit[] = [
  { id: "none", name: "General", prompt: "" },
  {
    id: "web",
    name: "Website",
    prompt:
      "This is a website project. Before changing code, read package.json to learn the framework, scripts and package manager, and use those scripts to build, test and lint. " +
      "Keep pages working on phone widths, keep text readable and controls reachable by keyboard, and never put secrets in code that runs in the browser. " +
      "After a change, say which page or route to open to see it.",
  },
  {
    id: "mobile",
    name: "Mobile app",
    prompt:
      "This is a mobile app project. First find out the stack (Flutter, React Native, Expo, Capacitor or native) from its config files and use the commands of that stack. " +
      "Think about both Android and iOS: permissions, screen sizes, offline behaviour and app-store rules. " +
      "When an error comes from a device or emulator, ask for the log lines around it. After a change, say how to run it on a device or emulator.",
  },
  {
    id: "unity",
    name: "Unity game",
    prompt:
      "This is a Unity game project. Scripts are C# under Assets; check ProjectSettings/ProjectVersion.txt for the Unity version and Packages/manifest.json for packages before using an API. " +
      "Never hand-edit .unity, .prefab, .asset or .meta files; describe the change to make in the Editor instead, or write an Editor script that makes it. " +
      "Keep work out of Update when it can be event-driven, avoid allocations in per-frame code, and name the GameObject or component a script belongs on. " +
      "For errors, ask for the Console message with its stack trace. After a change, say what to do in the Editor to test it.",
  },
  {
    id: "godot",
    name: "Godot game",
    prompt:
      "This is a Godot game project. Read project.godot for the Godot version and settings, and use GDScript unless the project uses C#. " +
      "Scenes (.tscn) and resources (.tres) are text but fragile: prefer describing changes to make in the editor, and keep edits to them small and exact. " +
      "Use signals instead of polling, typed GDScript where the project does, and node paths that match the scene tree. " +
      "For errors, ask for the Debugger or Output message. After a change, say which scene to run to test it.",
  },
];

export interface Role {
  id: string;
  name: string;
  prompt: string;
}

export const ROLES: Role[] = [
  { id: "", name: "No role", prompt: "" },
  {
    id: "manager",
    name: "Manager",
    prompt:
      "Your role in this workspace is Manager: you plan and hand out the work; you do not write the code yourself. " +
      "When the user asks for something, split it into small tasks, use list_terminals to see which terminals are Builder, Reviewer or Tester, and send each task to the right one with message_terminal, naming the files and what done looks like. " +
      "Keep track of who is doing what, pass a finished change from the Builder to a Reviewer or Tester, send their findings back to the Builder, and tell the user plainly what is done and what is still open.",
  },
  {
    id: "builder",
    name: "Builder",
    prompt:
      "Your role in this workspace is Builder: you write and change the code. Make the smallest change that does the job and run the tests or checks of the project. " +
      "When a piece of work is ready, use list_terminals to find a Reviewer or Tester terminal and send it a short message with what changed and which files, asking for its findings; then fix what it reports.",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    prompt:
      "Your role in this workspace is Reviewer: you read changes and find problems; you do not rewrite the code yourself. " +
      "When another terminal asks for a review, read the files it names, then answer it with message_terminal: the problems most serious first, each with the file and line and a concrete fix, or a clear statement that you found none.",
  },
  {
    id: "tester",
    name: "Tester",
    prompt:
      "Your role in this workspace is Tester: you check that things work. Run the tests, try the normal cases and the edge cases, and write missing tests. " +
      "Report what you ran and exactly what failed, with the output, to the terminal that asked, using message_terminal. Do not fix product code yourself; describe the failure so the Builder can.",
  },
];

const exists = (folder: string, ...parts: string[]) => fs.existsSync(path.join(folder, ...parts));

function packageJson(folder: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Guess the kind of project from the files in its folder. */
export function detectKit(folder: string): string {
  if (!folder || !fs.existsSync(folder)) return "none";
  if (exists(folder, "ProjectSettings", "ProjectVersion.txt") || (exists(folder, "Assets") && exists(folder, "ProjectSettings"))) return "unity";
  if (exists(folder, "project.godot")) return "godot";
  const pkg = packageJson(folder);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (exists(folder, "pubspec.yaml") || (exists(folder, "android") && exists(folder, "ios")) || deps["react-native"] || deps["expo"] || deps["@capacitor/core"]) return "mobile";
  if (["next", "react", "vue", "svelte", "astro", "vite", "nuxt", "@angular/core", "solid-js"].some((name) => deps[name]) || exists(folder, "index.html")) return "web";
  return "none";
}

export const kitById = (id: string | undefined) => KITS.find((k) => k.id === id) ?? KITS[0];

/** Roles the user made in the role manager carry ids with this prefix, so they never clash with a built-in one. */
export const CUSTOM_ROLE_PREFIX = "custom-";
export const MAX_ROLE_NAME = 30;
export const MAX_ROLE_PROMPT = 2000;
export const MAX_CUSTOM_ROLES = 20;

export const isBuiltInRole = (id: string) => ROLES.some((r) => r.id === id);

/**
 * The built-in roles followed by the user's own. workspace.json can be edited by hand, so custom
 * entries that are not well-formed, or that try to take a built-in role's id, are left out.
 */
export function allRoles(custom?: unknown): Role[] {
  const own = (Array.isArray(custom) ? custom : []).filter(
    (r): r is Role => !!r && typeof r.id === "string" && r.id.startsWith(CUSTOM_ROLE_PREFIX) && typeof r.name === "string" && typeof r.prompt === "string",
  );
  return [...ROLES, ...own];
}
export const roleById = (id: string | undefined, custom?: unknown) => allRoles(custom).find((r) => r.id === id) ?? ROLES[0];

/**
 * A role's instructions as they can be stored and later passed on a command line: one line, and
 * without the characters the launch command drops anyway (double quotes, backticks, dollar signs).
 */
export function cleanRolePrompt(prompt: string): string {
  return String(prompt ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // PowerShell reads curly quotes as real ones, so a pasted "don’t" would end the quoted text early.
    .replace(/[‘’‚‛“”„‟]/g, "'")
    .replace(/["`$]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The standing instructions for a terminal, as one line (it is passed on a command line). */
export function standingPrompt(kitId: string | undefined, roleId: string | undefined, custom?: unknown): string {
  // Cleaned again here, for custom roles written into workspace.json by hand.
  return cleanRolePrompt([kitById(kitId).prompt, roleById(roleId, custom).prompt].filter(Boolean).join(" "));
}
