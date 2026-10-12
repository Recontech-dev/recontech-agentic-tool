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
