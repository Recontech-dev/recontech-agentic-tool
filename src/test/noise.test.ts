import assert from "node:assert/strict";
import { test } from "node:test";

import { MIN_SPEECH_MS, afterWakeWord, audioNoise, isThanks, transcriptNoise, voiceCommand } from "../brain/speech";

/** What Whisper writes for silence, a fan, a cough or a click: none of it may reach a terminal. */
const JUNK = [
  "", "   ", "[BLANK_AUDIO]", " [BLANK_AUDIO] ", "(silence)", "[Music]", "♪", "♪♪♪", "♪ Thank you ♪", "*sigh*", "(coughs)",
  "[inaudible]", "[ Silence ]", "[MUSIC PLAYING]", "Thank you.", "Thank you!", "thank you", "THANK YOU.", "Thanks.",
  "Thank you very much.", "Thank you for watching.", "Thanks for watching!", "Please subscribe.", "Like and subscribe.",
  "Don't forget to like and subscribe.", "See you next time.", "I'll see you in the next video.", "you", "You.", "So.",
  "Oh.", "Um.", "Uh, um, hmm.", "Hmm...", "...", ".", "?!", "Foreign.", "Subtitles by the Amara.org community",
  "Transcribed by ESO, translated by —", "www.example.com", "you you you you", "The the the the.",
  "I'm sorry. I'm sorry. I'm sorry.", "Bye-bye. Bye-bye. Bye-bye.",
];

/** Real things said to Recon or into push-to-talk, the short answers the voice flow waits for included. */
const REAL = [
  "Recon", "Hey Recon", "Recon, open the AI Terminal project.", "Ask the builder to run the tests.",
  "Tell Gio AI the build is broken.", "Thank you, that's all.", "Thanks, that's it.", "yes", "Yeah.", "Okay.", "OK",
  "Sure, go ahead.", "no", "Bye.", "Goodbye.", "Stop.", "Never mind.", "Turn off the mic.", "That's all.",
  "Subscribe the reviewer to the task board.", "Fix the bug where thank you is shown twice.", "yes yes yes",
  "Run npm test.", "What's the status?", "Open the files panel", "Go go go.", "Commit it.", "Undo.", "Help",
];

test("Whisper hallucinations, tags, fillers and repeats are noise", () => {
  for (const junk of JUNK) assert.ok(transcriptNoise(junk), `blocked: ${JSON.stringify(junk)}`);
});

test("real commands and the short answers Recon waits for still get through", () => {
  for (const real of REAL) assert.equal(transcriptNoise(real), null, `kept: ${JSON.stringify(real)}`);
  // What the voice flow does with them afterwards is untouched.
  assert.equal(afterWakeWord("Recon, open the AI Terminal project."), "open the AI Terminal project.");
  assert.equal(voiceCommand("Thank you, that's all."), "sleep");
  assert.equal(voiceCommand("Turn off the mic."), "off");
});

test("odd input is noise, never a crash", () => {
  assert.ok(transcriptNoise(undefined as unknown as string));
  assert.ok(transcriptNoise(null as unknown as string));
  assert.ok(transcriptNoise("\x03\x1b\x07"));
});

const RATE = 16_000;
/** A 220 Hz tone at the given amplitude, as a stand-in for a voice. */
const tone = (ms: number, amplitude: number): number[] =>
  Array.from({ length: Math.round((RATE * ms) / 1000) }, (_, i) => amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE));
const silence = (ms: number): number[] => new Array(Math.round((RATE * ms) / 1000)).fill(0);
/** Low hiss, like a fan or a quiet room, from a fixed seed so the test is repeatable. */
function hiss(ms: number, amplitude: number): number[] {
  let seed = 7;
  return Array.from({ length: Math.round((RATE * ms) / 1000) }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return amplitude * (seed / 2 ** 30 - 1);
  });
}

test("too short or too quiet recordings are not sent to Whisper", () => {
  assert.equal(audioNoise([]), "too short");
  assert.equal(audioNoise(tone(MIN_SPEECH_MS - 50, 0.3)), "too short", "a click or a tap of the key");
  assert.equal(audioNoise(silence(1600 / 16)), "too short", "the page's 0.1 s warm-up");
  assert.equal(audioNoise(silence(2000)), "too quiet");
  assert.equal(audioNoise(hiss(2000, 0.008)), "too quiet", "a fan or a quiet room");
  assert.equal(audioNoise([...silence(900), ...tone(60, 0.3), ...silence(900)]), "too quiet", "a single knock");
});

test("a recording with a voice in it is transcribed, a quiet speaker included", () => {
  assert.equal(audioNoise(tone(1000, 0.2)), null);
  assert.equal(audioNoise([...silence(800), ...tone(250, 0.05), ...silence(800)]), null, "one short word in a long clip");
  assert.equal(audioNoise([...hiss(500, 0.004), ...tone(400, 0.03)]), null, "a quiet mic");
  assert.equal(audioNoise(Float32Array.from(tone(500, 0.1))), null, "a Float32Array works the same");
});

test("a plain thank-you is noise as typed text but closes a voice conversation", () => {
  for (const thanks of ["Thank you.", "thank you", "Thanks!", "Thank you very much.", "Thanks a lot."]) {
    assert.ok(transcriptNoise(thanks), `never typed into a terminal: ${thanks}`);
    assert.ok(isThanks(thanks), `let through to Recon: ${thanks}`);
    assert.equal(voiceCommand(thanks), "sleep", `ends the conversation: ${thanks}`);
  }
  assert.equal(transcriptNoise("Thank you, Recon."), null, "said to Recon by name, it is plainly speech");
  assert.equal(voiceCommand("Thank you, Recon."), "sleep");
  // Only the thank-you itself: other hallucinations stay dropped, and a request that starts with thanks is a request.
  for (const other of ["Thanks for watching!", "Please subscribe.", "you", "[BLANK_AUDIO]", "Thank you for the fix, now run the tests.", "Thanks, can you check the build?"]) {
    assert.equal(isThanks(other), false, `not a goodbye: ${other}`);
    assert.notEqual(voiceCommand(other), "sleep", `not a goodbye: ${other}`);
  }
});
