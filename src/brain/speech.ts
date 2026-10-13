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
 * What Whisper writes when it heard nothing worth writing: silence and room noise come out as the
 * closing lines of the YouTube videos it learned from, or as a tag in brackets. Whole transcripts only,
 * compared after punctuation and case are dropped, so "thank you, that's all" or "subscribe the
 * builder to the task board" still get through. Short real answers the voice flow waits for ("yes",
 * "okay", "bye", "stop") are deliberately not here.
 */
const HALLUCINATIONS = new Set([
  "you", "thank you", "thank you very much", "thank you so much", "thanks", "thanks a lot",
  "thank you for watching", "thanks for watching", "thank you for watching and see you next time",
  "please subscribe", "subscribe", "like and subscribe", "please like and subscribe",
  "dont forget to like and subscribe", "see you next time", "see you in the next video",
  "i'll see you in the next video", "ill see you in the next video", "so", "oh", "ah", "uh", "um", "hmm", "mm", "huh",
  "the end", "silence", "blank audio", "music", "applause", "laughter", "inaudible", "foreign",
]);
/** A tag in brackets, parentheses or asterisks: "[BLANK_AUDIO]", "(coughs)", "*sigh*", "[Music]". */
const TAG = /[[(*][^\])*]{0,40}[\])*]/g;
/** Credits Whisper copies from subtitle files, anywhere in the text. */
const CREDITS = /\b(?:subtitles?|captions?|transcri(?:bed|ption))\s+(?:by|from)\b|amara\.org|\bwww\.|\.com\b/i;

/**
 * Why a raw transcript is noise rather than something the user said, or null when it is real speech:
 * empty, only tags or music notes, a known Whisper hallucination, a subtitle credit, or one word said
 * over and over ("you you you you", which Whisper writes for a hum or a fan).
 */
export function transcriptNoise(raw: string): string | null {
  const text = String(raw ?? "").replace(TAG, " ").replace(/[♪♫♬🎵🎶]/gu, " ").trim();
  if (!text) return "empty";
  if (CREDITS.test(text)) return "subtitle credit";
  const words = text.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "no words";
  const plain = words.join(" ");
  if (HALLUCINATIONS.has(plain) || HALLUCINATIONS.has(plain.replace(/'/g, ""))) return "hallucination";
  // Fillers alone ("um, uh, hmm") are nothing to send.
  if (words.every((word) => /^(?:u+m+|u+h+|e+r+m*|h+m+|m+h*m*|a+h+|o+h+)$/.test(word))) return "filler";
  // The same word four or more times and nothing else is a hum or a fan, not a command ("yes yes yes" stays).
  if (words.length >= 4 && new Set(words).size === 1) return "repeated word";
  // Long runs of one short phrase ("I'm sorry. I'm sorry. I'm sorry.") are Whisper looping on noise.
  if (words.length >= 6 && new Set(words).size <= 2) return "repeated phrase";
  return null;
}

/** "Thank you" or "thanks" said on its own: how people close a conversation, and also Whisper's favourite hallucination. */
const THANKS = /^(?:thank\s+you|thanks)(?:\s+(?:very|so)\s+much|\s+a\s+lot)?(?:\s+recon)?$/i;

/**
 * Whether a transcript is a plain thank-you. transcriptNoise calls it a hallucination, which is right
 * for text that would be typed into a terminal; in a voice conversation it is how the user says goodbye,
 * so the transcriber lets it through and voiceCommand reads it as "sleep". Whisper writing it for a
 * sound that was not speech then ends a conversation at worst, never sends anything.
 */
export function isThanks(raw: string): boolean {
  return THANKS.test(String(raw ?? "").replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim());
}

/** Recordings shorter than this are a click or a tap of the key, not a word. */
export const MIN_SPEECH_MS = 300;
/** A 20 ms frame this loud (RMS, samples from -1 to 1) has a voice in it; the page starts recording at 0.025. */
export const SPEECH_RMS = 0.012;
/** How much of a recording must be that loud: a short word is about a tenth of a second. */
export const MIN_VOICED_MS = 120;

/**
 * Why a 16 kHz mono recording is not worth transcribing, or null when it may hold speech: too short,
 * or never loud enough for long enough to be a voice (a quiet room, a fan, the mic picking up a click).
 * Checked before Whisper runs, since Whisper writes something even for silence.
 */
export function audioNoise(pcm: ArrayLike<number>, rate = 16_000): string | null {
  const length = pcm?.length ?? 0;
  if ((length / rate) * 1000 < MIN_SPEECH_MS) return "too short";
  const frame = Math.max(1, Math.round(rate / 50));
  let voiced = 0;
  for (let start = 0; start + frame <= length; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) {
      const value = Number(pcm[i]) || 0;
      sum += value * value;
    }
    if (Math.sqrt(sum / frame) >= SPEECH_RMS) voiced++;
  }
  return voiced * 20 < MIN_VOICED_MS ? "too quiet" : null;
}

/**
 * "Recon", as Whisper tiny.en tends to hear it: "recon", "reckon", "re-con", "rekon", "recom" or
 * "raccoon", and, said with a longer "ee" as British voices do, "reekon", "reacon", "reeken" or
 * "reakin'"; optionally after "hey" or "okay", and after "hey" also just "con". Only at the very start
 * (after a filler or two), so "I reckon…" or "hey, can you…" never wakes the assistant. In noise "hey"
 * can lose its h and come out as "a"; "A recon" counts only when it stands alone ("A recon, open…"),
 * since "A recon mission…" is ordinary talk.
 */
const RECON = String.raw`(?:r(?:e|ee|ea|ie)[\s-]?(?:c|k|ck|kk)[oaie][nm]|rac+o+n)`;
const WAKE_WORD = new RegExp(
  String.raw`^[\s"'.,!?-]*(?:(?:um+|uh+|erm+)\b[\s,.]*)*(?:(?:hey|hay|heh)\b[\s,.!-]*(?:${RECON}|con|kon)|(?:(?:ok|okay)\b[\s,.!-]*)?${RECON}|a[\s,]+${RECON}(?=\s*(?:[,.!?:;]|$)))\b[\s"'.,!?:;-]*`,
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
  if (SLEEP.test(text) || isThanks(text)) return "sleep";
  return null;
}

/**
 * A Manager's message made fit to be read aloud: no Markdown marks, code blocks or long links, which
 * speech synthesis would spell out symbol by symbol. A heading, list item or table row ends with a
 * pause, as it would when read out by a person; ordinary lines just run on, since prose can be wrapped.
 */
export function speakable(text: string): string {
  const lines = String(text ?? "")
    .replace(/```[\s\S]*?```/g, "\n(code shown on screen)\n")
    .replace(/`([^`]*)`/g, "$1")
    // [label](address) and images: only the label is read.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .split("\n");
  const spoken: string[] = [];
  for (const raw of lines) {
    // A table's rule row (|---|:--:|) says nothing.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(raw)) continue;
    const row = /^\s*\|.*\|\s*$/.test(raw);
    const item = row || /^\s*(?:#+|[-*•]|\d+[.)])\s+/.test(raw);
    let line = row ? raw.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()).filter(Boolean).join(", ") : raw;
    line = line
      .replace(/^\s*(?:#+|[-*•]|\d+[.)])\s+/, "")
      .replace(/~(?=\d)/g, "about ")
      // Emphasis marks go, but the underscores inside names like voice_reply stay.
      .replace(/(^|[^\w])_{1,2}([^_\n]+?)_{1,2}(?=[^\w]|$)/g, "$1$2")
      .replace(/[*~#>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    spoken.push(item && !/[.!?:;,]$/.test(line) ? `${line}.` : line);
  }
  return spoken.join(" ");
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
  const match = /^(?:(?:please|can you|could you)\s+)?(?:open(?:\s+up)?|switch(?:ed)?\s+to|go\s+to|load|work\s+(?:on|in))\s+(?:(?:the|my|a|an|another|other)\s+)?(.*?)(?:\s+(project|folder|repo|repository))?(?:\s+(?:folder|please))?$/i.exec(text);
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
  // Only the folder's own name counts, never the folders above it; Windows paths use backslashes.
  const named = folders.map((folder) => ({ folder, name: squash(folder.split(/[\\/]+/).filter(Boolean).pop() ?? "") })).filter((f) => f.name);
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
