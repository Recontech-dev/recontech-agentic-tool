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
  {
    id: "unreal",
    name: "Unreal game",
    prompt:
      "This is an Unreal Engine game project. Read the .uproject file for the engine version, modules and plugins, and keep C++ under Source in the module it belongs to. " +
      "Blueprints, maps and other .uasset and .umap files are binary: never edit them as text; describe the change to make in the Editor instead. " +
      "Follow Unreal conventions: UCLASS, UPROPERTY and UFUNCTION macros, the A, U, F and E name prefixes, and garbage-collection-safe object references. Keep Tick light and prefer timers and events. " +
      "Changes to headers or reflected types need a full rebuild, not Live Coding; say when. For errors, ask for the Output Log or build log lines. After a change, say what to do in the Editor to test it.",
  },
  {
    id: "desktop",
    name: "Desktop app",
    prompt:
      "This is a desktop app project (Electron or Tauri). Read package.json, or src-tauri for Tauri, to learn the scripts and how the app is built and packaged, and use them. " +
      "Keep the main or backend process and the page apart: the page gets only what the preload script or commands expose, never full Node or system access, and every message from the page is checked before it is acted on. " +
      "Think about Windows, macOS and Linux: paths, line endings, file permissions and installers. Never block the main process with slow work. " +
      "After a change, say how to start the app to see it, and whether it also needs a new installer build.",
  },
  {
    id: "server",
    name: "Server or API",
    prompt:
      "This is a server or API project. First find the framework, how it is started and tested, and how it is configured (environment variables, config files) from the project files. " +
      "Check every input from a request, keep secrets in configuration and out of code and logs, use parameterised queries, and return clear errors with the right status codes. " +
      "Treat database changes as migrations that can be applied to existing data, and keep changes to a public endpoint backward compatible unless told otherwise. " +
      "After a change, say how to call the endpoint to see it, for example with a curl command.",
  },
  {
    id: "python",
    name: "Python",
    prompt:
      "This is a Python project. Find out the Python version and how dependencies are managed (pyproject.toml, requirements.txt, uv, poetry or a virtual environment) and use that, never the system Python for installs. " +
      "Follow the style and type hints the project already uses, run its tests (usually pytest) and its linters after a change, and add a dependency only to the file the project manages them in. " +
      "After a change, say which command to run to see it.",
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

/** The text of the Python dependency files, lower case, to look for a framework in; "" when there are none. */
function pythonDeps(folder: string): string {
  return ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]
    .map((file) => {
      try {
        return fs.readFileSync(path.join(folder, file), "utf8").toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

/** Guess the kind of project from the files in its folder. */
export function detectKit(folder: string): string {
  if (!folder || !fs.existsSync(folder)) return "none";
  if (exists(folder, "ProjectSettings", "ProjectVersion.txt") || (exists(folder, "Assets") && exists(folder, "ProjectSettings"))) return "unity";
  if (exists(folder, "project.godot")) return "godot";
  let files: string[] = [];
  try {
    files = fs.readdirSync(folder);
  } catch {
    // Unreadable: the checks by name below still work.
  }
  if (files.some((name) => name.toLowerCase().endsWith(".uproject"))) return "unreal";
  const pkg = packageJson(folder);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (exists(folder, "pubspec.yaml") || (exists(folder, "android") && exists(folder, "ios")) || deps["react-native"] || deps["expo"] || deps["@capacitor/core"]) return "mobile";
  // Before websites: a desktop app usually has React or an index.html of its own too.
  if (deps["electron"] || deps["@tauri-apps/api"] || deps["@tauri-apps/cli"] || exists(folder, "src-tauri")) return "desktop";
  if (["next", "react", "vue", "svelte", "astro", "vite", "nuxt", "@angular/core", "solid-js"].some((name) => deps[name]) || exists(folder, "index.html")) return "web";
  if (["express", "fastify", "@nestjs/core", "koa", "hono", "@hapi/hapi"].some((name) => deps[name])) return "server";
  const python = pythonDeps(folder);
  if (exists(folder, "manage.py") || /\b(django|fastapi|flask|starlette|aiohttp)\b/.test(python)) return "server";
  if (python || files.some((name) => name.endsWith(".py"))) return "python";
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

/** Escape sequences whole: OSC, DCS, SOS, PM and APC strings, CSI (ESC [ or the one-byte \x9b), and two-byte ESC forms. */
const ESCAPE_SEQUENCES = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -\/]*[@-~]?|\x1b[ -\/]*[0-~]?/g;

/**
 * Text with no control characters left: escape sequences go whole (so no "[201~" or "[2J" is left
 * behind), then every C0 character, DEL and the C1 range become a space. For text typed into a shell,
 * where any of them would be a keystroke: Ctrl+C (\x03) drops the line typed so far and runs the rest.
 */
export function plainText(text: unknown): string {
  return String(text ?? "").replace(ESCAPE_SEQUENCES, " ").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ");
}

/**
 * A role's instructions as they can be stored and later passed on a command line: one line, and
 * without the characters the launch command drops anyway (double quotes, backticks, dollar signs).
 */
export function cleanRolePrompt(prompt: string): string {
  return plainText(prompt)
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
