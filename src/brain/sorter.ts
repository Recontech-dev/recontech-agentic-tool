// The Smart sorting worker. The app starts it as a separate process so the window never waits on the
// model. It downloads Laya once, then keeps labelling settled sessions, reporting progress as JSON lines.

import * as path from "node:path";

import { loadIndex } from "./sessions";
import { Labels, Model, bundleDir, bundleReady, classify, loadLabels, pending, saveLabels, sessionKey } from "./sorting";

const RECHECK_MS = 30_000;

function report(message: object): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// Laya is published as an ES module; this keeps the import as a real import() after compiling to CommonJS.
const importModule = new Function("name", "return import(name)") as (name: string) => Promise<any>;

async function loadModel(): Promise<Model & { close(): Promise<void> }> {
  const { Laya } = await importModule("@receptron/laya");
  const cache = process.env.LAYA_CACHE || path.join(process.env.ALT_HOME || ".", "models");
  // Once downloaded, the model is loaded straight from disk: no network check, so it starts offline
  // and never downloads again.
  // Full graph optimisation made loading take 40-100 seconds; "basic" loads in about 2 with the same answers.
  const sessionOptions = { graphOptimizationLevel: "basic" };
  if (bundleReady(cache)) return Laya.load({ modelDir: bundleDir(cache), sessionOptions });
  const totals = new Map<string, { received: number; total: number }>();
  let lastReport = 0;
  return Laya.load({
    cacheDir: cache,
    sessionOptions,
    onProgress: ({ file, received, total }: { file: string; received: number; total: number | null }) => {
      totals.set(file, { received, total: total ?? received });
      if (Date.now() - lastReport < 500) return;
      lastReport = Date.now();
      const sum = [...totals.values()].reduce((a, t) => ({ received: a.received + t.received, total: a.total + t.total }), { received: 0, total: 0 });
      report({ status: "downloading", received: sum.received, total: sum.total });
    },
  });
}

async function main(): Promise<void> {
  report({ status: "loading" });
  const model = await loadModel();
  for (;;) {
    const labels: Record<string, Labels> = loadLabels();
    const sessions = Object.values(loadIndex()).filter((s): s is any => !("skipped" in s));
    const todo = pending(sessions, labels);
    let done = 0;
    for (const session of todo) {
      report({ status: "sorting", done, total: todo.length });
      try {
        labels[sessionKey(session)] = await classify(model, session);
      } catch (error) {
        report({ status: "warning", message: `Could not sort "${session.title}": ${(error as Error).message}` });
      }
      done++;
      // Saved after every session, so nothing is lost if the app closes part-way.
      saveLabels(labels);
    }
    report({ status: "ready", sorted: Object.keys(labels).length });
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
  }
}

main().catch((error) => {
  report({ status: "error", message: (error as Error).message });
  process.exit(1);
});
