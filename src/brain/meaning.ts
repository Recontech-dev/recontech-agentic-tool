// Search by meaning. If Ollama is running with a small embedding model, notes and sessions are
// compared with the question by meaning, so "how do we ship it" finds a note about "deploy".
// Everything happens on this computer; without Ollama the brain falls back to matching words.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { home } from "./paths";

export const EMBED_MODEL = process.env.ALT_EMBED_MODEL || "nomic-embed-text";
// Read on every call, so the address can be changed while the app runs.
const ollama = () => (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const MAX_CACHE = 5000;

const cacheFile = () => path.join(home(), "brain", "vectors.json");
const keyOf = (text: string) => createHash("sha1").update(EMBED_MODEL + "\u0000" + text).digest("hex").slice(0, 20);

let cache: Record<string, number[]> | null = null;
let unavailableUntil = 0;

function loadCache(): Record<string, number[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    cache = {};
  }
  return cache!;
}

function saveCache(): void {
  const entries = Object.entries(loadCache());
  // Oldest entries go first when the cache grows too large.
  if (entries.length > MAX_CACHE) cache = Object.fromEntries(entries.slice(entries.length - MAX_CACHE));
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(cache), "utf8");
}

/** For tests: forget the cache and the "not available" pause. */
export function reset(): void {
  cache = null;
  unavailableUntil = 0;
}

async function request(texts: string[]): Promise<number[][] | null> {
  try {
    const response = await fetch(`${ollama()}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { embeddings?: number[][] };
    return Array.isArray(data.embeddings) && data.embeddings.length === texts.length ? data.embeddings : null;
  } catch {
    return null;
  }
}

/**
 * Vectors for the texts, or null when Ollama or the model is not available.
 * After a failure it is not asked again for a minute, so searching stays fast.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (Date.now() < unavailableUntil) return null;
  const known = loadCache();
  const missing = [...new Set(texts.filter((t) => !known[keyOf(t)]))];
  for (let i = 0; i < missing.length; i += 64) {
    const batch = missing.slice(i, i + 64);
    const vectors = await request(batch.map((t) => t.slice(0, 2000)));
    if (!vectors) {
      unavailableUntil = Date.now() + 60_000;
      return null;
    }
    batch.forEach((text, n) => (known[keyOf(text)] = vectors[n].map((v) => Math.round(v * 1e4) / 1e4)));
  }
  if (missing.length) saveCache();
  return texts.map((t) => known[keyOf(t)]);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** How close each text is to the query (0 to 1), or null when searching by meaning is not available. */
export async function closeness(query: string, texts: string[]): Promise<number[] | null> {
  if (!query.trim() || !texts.length) return texts.map(() => 0);
  const vectors = await embed([query, ...texts]);
  if (!vectors) return null;
  return vectors.slice(1).map((v) => cosine(vectors[0], v));
}
