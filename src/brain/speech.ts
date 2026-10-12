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
 * "Hey Recon", as Whisper tiny.en tends to hear it: "hey recon", "hey reckon", "hey re-con",
 * "hey raccoon", or just "hey con". Only at the very start (after a filler or two), and only with an
 * "o" sound, so ordinary talk such as "hey, can you…" or "hey, contact…" never wakes the assistant.
 */
const WAKE_WORD = /^[\s"'.,!?-]*(?:(?:um+|uh+|erm+)\b[\s,.]*)*(?:hey|hay|heh)\b[\s,.!-]*(?:re[\s-]?(?:c|k|ck|kk)on|rac+o+n|con|kon)\b[\s"'.,!?:;-]*/i;

/**
 * What was said after "Hey Recon": null when the transcript does not start with the wake word, ""
 * when it was only the wake word (the user is waiting to be asked), otherwise the command that ran on
 * in the same breath, as Whisper wrote it (pass it through cleanupTranscript before using it).
 */
export function afterWakeWord(transcript: string): string | null {
  const match = WAKE_WORD.exec(String(transcript ?? ""));
  return match ? transcript.slice(match[0].length).trim() : null;
}

/** True when a transcript starts with someone saying "Hey Recon" to start the assistant. */
export const matchesWakeWord = (transcript: string): boolean => afterWakeWord(transcript) !== null;
