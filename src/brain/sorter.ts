// The Smart sorting worker. The app starts it as a separate process so the window never waits on the
// model. It downloads Laya once, then keeps labelling settled sessions, reporting progress as JSON lines.
// The model is kept in memory only while there are sessions to label.

import * as path from "node:path";

import { loadIndex } from "./sessions";
import { IdleModel, Labels, Model, bundleDir, bundleReady, classify, loadLabels, pending, saveLabels, sessionKey } from "./sorting";

const RECHECK_MS = 30_000;

const modelCache = () => process.env.LAYA_CACHE || path.join(process.env.ALT_HOME || ".", "models");

function report(message: object): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// Laya is published as an ES module; this keeps the import as a real import() after compiling to CommonJS.
const importModule = new Function("name", "return import(name)") as (name: string) => Promise<any>;

async function loadModel(): Promise<Model & { close(): Promise<void> }> {
  const { Laya } = await importModule("@receptron/laya");
  const cache = modelCache();
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
  const model = new IdleModel(loadModel);
  let started = false;
  /** Sessions the model could not sort, by when they last changed. */
  const failed = new Map<string, number>();
  // The first time, the model has to be downloaded, so it is loaded right away; after that only when
  // there is something to sort, and closed again once there has been nothing for a while.
  if (!bundleReady(modelCache())) {
    report({ status: "loading" });
    await model.get();
    started = true;
  }
  for (;;) {
    const labels: Record<string, Labels> = loadLabels();
    const sessions = Object.values(loadIndex()).filter((s): s is any => !("skipped" in s));
    const todo = pending(sessions, labels, Date.now(), failed);
    if (todo.length) {
      // The first load after the app starts says so; a later one shows as the start of sorting. Either
      // takes 2-3 seconds while the model's files are still in the system's disk cache, about a minute after.
      if (!started) report({ status: "loading" });
      else report({ status: "sorting", done: 0, total: todo.length });
      started = true;
      const loaded = await model.get();
      let done = 0;
      for (const session of todo) {
        report({ status: "sorting", done, total: todo.length });
        try {
          labels[sessionKey(session)] = await classify(loaded, session);
        } catch (error) {
          failed.set(sessionKey(session), session.modified);
          report({ status: "warning", message: `Could not sort "${session.title}": ${(error as Error).message}` });
        }
        done++;
        // Saved after every session, so nothing is lost if the app closes part-way.
        saveLabels(labels);
      }
    } else {
      await model.idleCheck();
    }
    report({ status: "ready", sorted: Object.keys(labels).length });
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
  }
}

main().catch((error) => {
  report({ status: "error", message: (error as Error).message });
  process.exit(1);
});
