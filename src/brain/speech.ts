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
