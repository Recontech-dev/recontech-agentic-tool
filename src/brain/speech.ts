// Speech-to-text: a local Whisper model turns a recording into text, and this file turns that
// raw transcript into a tidier prompt (stray filler words, stutters and missing punctuation are
// what speech recognition typically leaves behind). Everything here is plain text, no audio.

/** Hugging Face model id for the local speech-to-text pipeline, run entirely on this computer. */
export const WHISPER_MODEL = process.env.WHISPER_MODEL || "onnx-community/whisper-tiny.en";

const FILLERS = /\b(?:um+|uh+|erm+|hmm+)\b/gi;

/** Turn a raw transcript into a cleaner prompt: no fillers, stutters, extra spaces, and a capital letter and closing punctuation. */
export function cleanupTranscript(raw: string): string {
  let text = raw.trim();
  if (!text) return "";
  text = text.replace(FILLERS, "");
  // A word repeated right after itself ("the the quick") is a stutter, not intent.
  text = text.replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
  text = text.replace(/\s+/g, " ").replace(/\s+([,.?!])/g, "$1").trim();
  if (!text) return "";
  text = text[0].toUpperCase() + text.slice(1);
  if (!/[.?!]$/.test(text)) text += ".";
  return text;
}

/**
 * "Recon", as Whisper tiny.en tends to hear it: "recon", "reckon", "re-con", "rekon" or "raccoon",
 * optionally after "hey" or "okay", and after "hey" also just "con". Only at the very start (after a
 * filler or two), so "I reckon…" or "hey, can you…" never wakes the assistant.
 */
const RECON = String.raw`(?:re[\s-]?(?:c|k|ck|kk)on|rac+o+n)`;
const WAKE_WORD = new RegExp(
  String.raw`^[\s"'.,!?-]*(?:(?:um+|uh+|erm+)\b[\s,.]*)*(?:(?:hey|hay|heh)\b[\s,.!-]*(?:${RECON}|con|kon)|(?:(?:ok|okay)\b[\s,.!-]*)?${RECON})\b[\s"'.,!?:;-]*`,
  "i",
);

/**
 * What was said after "Recon": null when the transcript does not start with the wake word, ""
 * when it was only the wake word (the user is waiting to be asked), otherwise the command that ran on
 * in the same breath, as Whisper wrote it (pass it through cleanupTranscript before using it).
 */
export function afterWakeWord(transcript: string): string | null {
  const match = WAKE_WORD.exec(String(transcript ?? ""));
  return match ? transcript.slice(match[0].length).trim() : null;
}

/** True when a transcript starts with someone saying "Recon" to start the assistant. */
export const matchesWakeWord = (transcript: string): boolean => afterWakeWord(transcript) !== null;

/** Turning the voice feature off by voice: "turn off the mic", "mic off", "stop listening", "mute the microphone". */
const MIC_OFF = /\b(?:(?:turn|switch|shut)\s+(?:the\s+|your\s+)?(?:mic|microphone|voice)(?:\s+feature)?\s+off|(?:turn|switch|shut)\s+off\s+(?:the\s+|your\s+)?(?:mic|microphone|voice)|mic(?:rophone)?\s+off|stop\s+listening|mute\s+(?:the\s+)?(?:mic|microphone))\b/i;
/** Ending a conversation without turning the mic off: it then waits for "Recon" again. */
const SLEEP = /^(?:ok(?:ay)?[\s,]+)?(?:that'?s\s+(?:all|it)|that\s+is\s+all|go\s+to\s+sleep|good\s*bye|bye(?:\s+bye)?|never\s*mind|stop(?:\s+talking)?|thanks?(?:\s+you)?,?\s+that'?s\s+(?:all|it))\b/i;
/** Commands are short; a longer sentence that mentions the mic ("tell the builder to turn off the mic button") is a request. */
const MAX_COMMAND_WORDS = 8;

/**
 * A spoken instruction to the voice assistant itself, handled on this computer rather than sent to
 * the Manager: "off" turns the voice feature off, "sleep" ends the conversation. null for anything else.
 */
export function voiceCommand(transcript: string): "off" | "sleep" | null {
  const text = String(transcript ?? "").replace(/[^\w\s',-]/g, " ").replace(/\s+/g, " ").trim();
  if (!text || text.split(" ").length > MAX_COMMAND_WORDS) return null;
  if (MIC_OFF.test(text)) return "off";
  if (SLEEP.test(text)) return "sleep";
  return null;
}

/**
 * A Manager's message made fit to be read aloud: no Markdown marks, code blocks or long links, which
 * speech synthesis would spell out symbol by symbol.
 */
export function speakable(text: string): string {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " (code shown on screen) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s*(?:#+|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_~#>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "Open the Ecoshift project", "switch to AI Terminal", "go to the NewFields folder": the project name
 * asked for, or "" for "open a project" with no name (the folder picker). null when it is not such a
 * request. `explicit` says the user said "project" or "folder", so a name that matches nothing is
 * worth telling them about; otherwise ("open the readme") it is a request for the Manager instead.
 */
export function openProjectRequest(transcript: string): { name: string; explicit: boolean } | null {
  const text = String(transcript ?? "").replace(/[^\w\s'.-]/g, " ").replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");
  if (!text || text.split(" ").length > MAX_COMMAND_WORDS) return null;
  const match = /^(?:(?:please|can you|could you)\s+)?(?:open(?:\s+up)?|switch\s+to|go\s+to|load|work\s+(?:on|in))\s+(?:(?:the|my|a|an|another|other)\s+)?(.*?)(?:\s+(project|folder|repo|repository))?(?:\s+(?:folder|please))?$/i.exec(text);
  if (!match) return null;
  const name = match[1].replace(/^(?:project|folder)\s+/i, "").trim();
  const explicit = !!match[2] || /^(?:project|folder)\b/i.test(match[1]);
  if (/^(?:project|folder|new|different)?$/i.test(name)) return explicit || !name ? { name: "", explicit: true } : null;
  return { name, explicit };
}

/** Lower case, letters and digits only: "A.I. Terminal" and "ai-terminal" read the same. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * The known project folder a spoken name means, matched on the folder's own name the way speech
 * recognition tends to write it: spacing and punctuation ignored, small mishearings forgiven.
 */
export function matchProject(spoken: string, folders: string[]): string | null {
  const want = squash(spoken);
  if (!want) return null;
  const named = folders.map((folder) => ({ folder, name: squash(folder.split(/[\/]+/).filter(Boolean).pop() ?? "") })).filter((f) => f.name);
  const exact = named.find((f) => f.name === want);
  if (exact) return exact.folder;
  const partial = named.filter((f) => want.length >= 3 && (f.name.startsWith(want) || f.name.includes(want)));
  if (partial.length === 1) return partial[0].folder;
  let best: { folder: string; score: number } | null = null;
  for (const f of named) {
    const score = 1 - editDistance(want, f.name) / Math.max(want.length, f.name.length);
    if (score >= 0.75 && (!best || score > best.score)) best = { folder: f.folder, score };
  }
  return best?.folder ?? null;
}
