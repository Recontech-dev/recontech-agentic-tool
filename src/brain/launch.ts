// How each profile's Claude Code is started, plus the checks for the internet and for Ollama.
// Kept free of Electron so it can be tested on its own.

import * as fs from "node:fs";
import * as path from "node:path";

import { defaultClaudeDir } from "./paths";
import { Profile } from "./workspace";

export const OLLAMA_URL = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");

/** Environment for a profile's terminal. `bridge` is the free-models bridge, needed for a "free" profile. */
export function profileEnv(profile: Profile, base: NodeJS.ProcessEnv, bridge?: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // Settings left behind by a Claude Code session the app itself was started from would change
    // how the new sessions behave (for example, turn transcript saving off), so they are not passed on.
    if (value !== undefined && !/^CLAUDE_?CODE/i.test(key)) env[key] = value;
  }
  delete env.ELECTRON_RUN_AS_NODE;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  if (profile.kind === "ollama") {
    // Ollama answers Claude Code's requests itself, so this profile works with no internet and no Claude sign-in.
    env.ANTHROPIC_BASE_URL = OLLAMA_URL;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";
    env.ANTHROPIC_API_KEY = "";
  }
  if (profile.kind === "free" && bridge) {
    // Claude Code talks to the bridge inside this app, which passes each request to a free provider.
    env.ANTHROPIC_BASE_URL = bridge.url;
    env.ANTHROPIC_AUTH_TOKEN = bridge.token;
    env.ANTHROPIC_API_KEY = "";
    // The bridge has no telemetry or update endpoints, so Claude Code is told not to call them.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  }
  return env;
}

/** Built-in Claude Code tools a contained terminal does not get, on top of what restricted mode removes. */
export const CONTAINED_OFF = ["SendMessage", "ListAgents", "WebSearch", "DesignSync", "Skill"];

/** The command typed into a profile's terminal to start Claude Code. */
export function claudeCommand(profile: Profile, mcpConfig: string, resume?: string, contained = false, standing = ""): string {
  const quote = process.platform === "win32" ? (s: string) => `'${s.replace(/'/g, "''")}'` : (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ["claude"];
  if (profile.kind === "ollama" && profile.model) parts.push("--model", quote(profile.model));
  // The bridge picks the real model; this name only labels the session.
  if (profile.kind === "free") parts.push("--model", "free-models");
  // Contained: Claude Code's restricted mode removes the tools that run commands or fetch web pages and
  // keeps file access inside the folder it starts in; only the app's own MCP server is loaded.
  // Claude Code's own ways of reaching other sessions and the web are switched off as well, so the
  // only way out of the container is the app's message_terminal.
  if (contained) parts.push("--restricted", "--strict-mcp-config", "--disallowedTools", quote(CONTAINED_OFF.join(",")));
  if (resume && /^[\w-]+$/.test(resume)) parts.push("--resume", resume);
  // Standing instructions (project kit and terminal role), kept to one line with plain quotes.
  const extra = standing.replace(/[\r\n]+/g, " ").replace(/["`$]/g, "").trim();
  if (extra) parts.push("--append-system-prompt", quote(extra));
  parts.push("--mcp-config", quote(mcpConfig));
  return parts.join(" ");
}

export function configDirOf(profile: Profile): string {
  return profile.configDir ?? defaultClaudeDir();
}

/**
 * The email a profile's Claude Code is signed in with, or "" when it is not signed in.
 * Claude Code writes this (not the login itself) in a settings file: ~/.claude.json for the normal
 * sign-in, <config folder>/.claude.json for the others. Only the email is read.
 */
export function signedInAs(profile: Profile): string {
  if (profile.kind === "ollama" || profile.kind === "free") return "";
  const file = profile.configDir ? path.join(profile.configDir, ".claude.json") : path.join(path.dirname(defaultClaudeDir()), ".claude.json");
  // The settings file can name an account without a login being saved (for example after an
  // interrupted sign-in). On Windows and Linux the saved login is a file, so its absence means
  // "not signed in"; macOS keeps it in the Keychain, where it cannot be checked this way.
  if (process.platform !== "darwin" && !fs.existsSync(path.join(configDirOf(profile), ".credentials.json"))) return "";
  try {
    const email = JSON.parse(fs.readFileSync(file, "utf8")).oauthAccount?.emailAddress;
    return typeof email === "string" ? email : "";
  } catch {
    return "";
  }
}

export function sameDir(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function reachable(url: string, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/** True when Claude's servers can be reached. Any HTTP answer counts; only no answer means offline. */
export async function online(): Promise<boolean> {
  return (await reachable("https://api.anthropic.com/", 4000)) !== null;
}

/** The models downloaded in Ollama, or null when Ollama is not running. */
export async function ollamaModels(): Promise<string[] | null> {
  const response = await reachable(`${OLLAMA_URL}/api/tags`, 2000);
  if (!response?.ok) return null;
  const data = (await response.json()) as { models?: { name: string }[] };
  // Embedding-only models (e.g. nomic-embed-text) can't run Claude Code's agent loop; keep them out of the picker.
  return (data.models ?? []).map((m) => m.name).filter((name) => !/embed/i.test(name)).sort();
}
