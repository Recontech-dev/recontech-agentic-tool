// The speech-to-text worker. Started on demand (not kept running like the sorter), it loads a
// local Whisper model once and then answers transcription requests sent on stdin, one JSON line
// each, with the result on stdout. Downloading and inference both stay on this computer.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const MODEL_ID = process.env.WHISPER_MODEL || "onnx-community/whisper-tiny.en";

function report(message: object): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// Transformers.js is published as an ES module; this keeps the import as a real import() after compiling to CommonJS.
const importModule = new Function("name", "return import(name)") as (name: string) => Promise<any>;

async function loadAsr(): Promise<(audio: Float32Array, options?: object) => Promise<{ text: string }>> {
  const { pipeline, env } = await importModule("@huggingface/transformers");
  env.cacheDir = process.env.WHISPER_CACHE || ".";
  env.allowLocalModels = false;
  const totals = new Map<string, number>();
  // The model is downloaded once into the cache folder and read from there afterwards. The library
  // reports "download" and progress for cached files too, so only files that were not in the cache
  // when loading began count; otherwise every start would say it is downloading again.
  const fetching = new Set<string>();
  let lastReport = 0;
  const asr = await pipeline("automatic-speech-recognition", MODEL_ID, {
    dtype: "q8",
    progress_callback: (p: { status: string; file?: string; progress?: number }) => {
      if (p.status === "initiate" && p.file && !fs.existsSync(path.join(env.cacheDir, MODEL_ID, p.file))) fetching.add(p.file);
      if (p.status !== "progress" || !p.file || !fetching.has(p.file) || typeof p.progress !== "number") return;
      totals.set(p.file, p.progress);
      if (Date.now() - lastReport < 500) return;
      lastReport = Date.now();
      const values = [...totals.values()];
      const percent = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
      report({ status: "downloading", percent });
    },
  });
  return asr;
}

async function main(): Promise<void> {
  report({ status: "loading" });
  const asr = await loadAsr();
  report({ status: "ready" });
  // Requests are answered one at a time; a user only ever has one recording in flight anyway.
  let queue = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    queue = queue.then(() => handle(line));
  });
  async function handle(line: string): Promise<void> {
    let request: { id: string; pcm: number[] };
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    try {
      const audio = Float32Array.from(request.pcm);
      // Whisper hears 30 seconds at a time; without chunking, everything after the first 30 seconds is lost.
      const output = (await asr(audio, { chunk_length_s: 30, stride_length_s: 5 })) as { text?: string } | { text?: string }[];
      const text = Array.isArray(output) ? output[0]?.text ?? "" : output.text ?? "";
      report({ id: request.id, text: String(text).trim() });
    } catch (error) {
      report({ id: request.id, error: (error as Error).message });
    }
  }
}

main().catch((error) => {
  report({ status: "error", message: (error as Error).message });
  process.exit(1);
});
