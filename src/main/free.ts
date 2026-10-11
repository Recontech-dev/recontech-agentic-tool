// Free models: the user's free-provider settings and API keys, and the bridge that serves them.
// Keys are encrypted with the operating system's own protection (Windows DPAPI, macOS Keychain)
// before they are written to disk, and never leave this process except to their own provider.

import { safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

import { home } from "../brain/paths";
import { FreeProxy, PRESETS, Provider } from "../proxy/server";

export interface FreeSettings {
  /** Model per provider id, when the user changed it from the preset. */
  models: Record<string, string>;
}

const keysFile = () => path.join(home(), "free-keys.json");
const settingsFile = () => path.join(home(), "free-models.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function loadKeys(): Record<string, string> {
  const stored = readJson<Record<string, string>>(keysFile(), {});
  const keys: Record<string, string> = {};
  for (const [id, value] of Object.entries(stored)) {
    try {
      keys[id] = safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      // Encrypted on another computer or account; the user enters the key again.
    }
  }
  return keys;
}

export class FreeModels {
  private keys: Record<string, string> = {};
  private settings: FreeSettings = { models: {} };
  readonly proxy: FreeProxy;

  constructor(onChange: () => void) {
    this.proxy = new FreeProxy(() => this.providers(), onChange);
  }

  /** Call once the app is ready (the OS key protection is not available earlier). */
  async start(): Promise<void> {
    this.keys = loadKeys();
    this.settings = readJson<FreeSettings>(settingsFile(), { models: {} });
    await this.proxy.listen();
  }

  /** Providers in the order they are tried. */
  providers(): Provider[] {
    return Object.entries(PRESETS).map(([id, preset]) => ({
      id, name: preset.name, baseUrl: preset.baseUrl, maxOutput: preset.maxOutput, strictSchema: preset.strictSchema,
      model: this.settings.models[id] || preset.model, key: this.keys[id] ?? "",
    }));
  }

  hasAnyKey(): boolean {
    return Object.values(this.keys).some(Boolean);
  }

  /** What the settings dialog shows. Keys themselves are never sent to the window. */
  describe() {
    return {
      canEncrypt: safeStorage.isEncryptionAvailable(),
      providers: this.providers().map((p) => ({
        id: p.id, name: p.name, model: p.model, hasKey: !!p.key, keyUrl: PRESETS[p.id].keyUrl, note: PRESETS[p.id].note,
      })),
      status: this.proxy.status(),
    };
  }

  /** Save what the dialog sent: a new key (empty string removes it; undefined keeps it) and the model. */
  save(entries: { id: string; key?: string; model?: string }[]): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer cannot encrypt saved keys, so they are not stored.");
    for (const entry of entries) {
      if (!PRESETS[entry.id]) continue;
      if (typeof entry.key === "string") {
        if (entry.key.trim()) this.keys[entry.id] = entry.key.trim();
        else delete this.keys[entry.id];
      }
      if (typeof entry.model === "string") {
        const model = entry.model.trim();
        if (model && model !== PRESETS[entry.id].model) this.settings.models[entry.id] = model;
        else delete this.settings.models[entry.id];
      }
    }
    const encrypted = Object.fromEntries(Object.entries(this.keys).map(([id, key]) => [id, safeStorage.encryptString(key).toString("base64")]));
    writeJson(keysFile(), encrypted);
    writeJson(settingsFile(), this.settings);
  }

  /** Send one tiny request to each provider that has a key, to check the key and the model name. */
  async test(): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    await Promise.all(this.providers().filter((p) => p.key).map(async (p) => {
      try {
        const response = await fetch(`${p.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
          body: JSON.stringify({ model: p.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the word OK." }] }),
          signal: AbortSignal.timeout(30_000),
        });
        if (response.ok) results[p.id] = "working";
        else results[p.id] = `failed (${response.status}): ${(await response.text()).replace(/\s+/g, " ").slice(0, 160)}`;
      } catch (error) {
        results[p.id] = `could not be reached: ${(error as Error).message}`;
      }
    }));
    return results;
  }

  /** What a free terminal's Claude Code needs to talk to the bridge. */
  connection(): { url: string; token: string } {
    return { url: `http://127.0.0.1:${this.proxy.port}`, token: this.proxy.token };
  }
}
