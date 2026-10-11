// How each profile's Claude Code is started, plus the checks for the internet and for Ollama.
// Kept free of Electron so it can be tested on its own.

import * as fs from "node:fs";
import * as path from "node:path";

import { defaultClaudeDir } from "./paths";
import { Profile } from "./workspace";

export const OLLAMA_URL = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");

/** Environment for a profile's terminal. */
export function profileEnv(profile: Profile, base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RUN_AS_NODE;
  if (profile.configDir) env.CLAUDE_CONFIG_DIR = profile.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  if (profile.kind === "ollama") {
    // Ollama answers Claude Code's requests itself, so this profile works with no internet and no Claude sign-in.
    env.ANTHROPIC_BASE_URL = OLLAMA_URL;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";
    env.ANTHROPIC_API_KEY = "";
  }
  return env;
}

/** The command typed into a profile's terminal to start Claude Code. */
export function claudeCommand(profile: Profile, mcpConfig: string, resume?: string): string {
  const quote = process.platform === "win32" ? (s: string) => `'${s.replace(/'/g, "''")}'` : (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = ["claude"];
  if (profile.kind === "ollama" && profile.model) parts.push("--model", quote(profile.model));
  if (resume && /^[\w-]+$/.test(resume)) parts.push("--resume", resume);
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
  if (profile.kind === "ollama") return "";
  const file = profile.configDir ? path.join(profile.configDir, ".claude.json") : path.join(path.dirname(defaultClaudeDir()), ".claude.json");
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
  return (data.models ?? []).map((m) => m.name).sort();
}
