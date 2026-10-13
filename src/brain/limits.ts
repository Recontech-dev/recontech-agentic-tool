// Plan limits: how much of its 5-hour session and its week a Claude account has used, as Anthropic
// reckons it. These are the same percentages the Claude app and Claude Code's /usage show, and the only
// source that counts everything an account did (the Claude app, claude.ai and other computers too).
// They are asked of Anthropic with the account's own sign-in, the way Claude Code itself does; the
// sign-in is only read, never refreshed or changed, so Claude Code stays in charge of it.

import * as fs from "node:fs";
import * as path from "node:path";

export interface Limit {
  /** 0 to 100 (it can go over when extra usage is on). */
  percent: number;
  /** When the window starts over (ms), or 0 when not known. */
  resets: number;
}

export interface PlanLimits {
  session: Limit | null;
  week: Limit | null;
  /** The plan, such as "pro" or "max", from the sign-in. */
  plan: string;
  /** When Anthropic was asked (ms). */
  at: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Anthropic is asked at most this often per account; the figures move slowly. */
const FRESH_MS = 3 * 60_000;
/** How soon a failed first ask is tried again. */
const RETRY_MS = 30_000;

const cache = new Map<string, { limits: PlanLimits | { error: string }; at: number }>();

function limitOf(value: any): Limit | null {
  const percent = Number(value?.utilization);
  if (!value || !Number.isFinite(percent)) return null;
  const resets = Date.parse(value.resets_at);
  return { percent, resets: Number.isFinite(resets) ? resets : 0 };
}

/** Reads the answer of the usage endpoint. Exported for the tests. */
export function readLimits(data: any, plan: string, at: number): PlanLimits {
  return { session: limitOf(data?.five_hour), week: limitOf(data?.seven_day), plan, at };
}

async function ask(configDir: string, now: number): Promise<PlanLimits | { error: string }> {
  let oauth: any;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8"))?.claudeAiOauth;
  } catch {
    return { error: "Not signed in to a Claude account in this folder" };
  }
  if (typeof oauth?.accessToken !== "string") return { error: "Not signed in to a Claude account in this folder" };
  // An expired sign-in is renewed by Claude Code the next time it runs; this app leaves that to it.
  if (Number(oauth.expiresAt) && Number(oauth.expiresAt) < now) return { error: "Sign-in expired: use Claude in this terminal and it renews it" };
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { error: "Could not reach Anthropic" };
  }
  if (response.status === 401 || response.status === 403) return { error: "Sign-in not accepted: use Claude in this terminal and it renews it" };
  if (!response.ok) return { error: `Anthropic answered ${response.status}` };
  try {
    return readLimits(await response.json(), String(oauth.subscriptionType ?? ""), now);
  } catch {
    return { error: "Anthropic's answer could not be read" };
  }
}

/** One account's limits, from Anthropic at most every few minutes. A failed ask keeps the last figures. */
export async function planLimits(configDir: string, now = Date.now()): Promise<PlanLimits | { error: string }> {
  const dir = path.resolve(configDir);
  const known = cache.get(dir);
  if (known && now - known.at < FRESH_MS) return known.limits;
  const limits = await ask(dir, now);
  if ("error" in limits && known && !("error" in known.limits)) {
    cache.set(dir, { limits: known.limits, at: now });
    return known.limits;
  }
  // With no figures to fall back on, a failure (often a hiccup right at startup) is asked again at the
  // next refresh instead of standing for the full time.
  cache.set(dir, { limits, at: "error" in limits ? now - FRESH_MS + RETRY_MS : now });
  return limits;
}
