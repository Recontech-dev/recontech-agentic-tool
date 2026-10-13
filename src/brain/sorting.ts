// Smart sorting: label each past session with what kind of work it was and whether it was finished,
// using Laya (a local classification model, https://github.com/receptron/laya). Laya never writes
// text; it only picks labels and gives probabilities, entirely on this computer.

import * as fs from "node:fs";
import * as path from "node:path";

import { home } from "./paths";
import { Session } from "./sessions";

export const TYPES: Record<string, string> = {
  "bug fix": "finding and fixing an error, crash or wrong behaviour",
  feature: "building something new: a page, endpoint, command or capability",
  refactor: "restructuring or cleaning up existing code without changing what it does",
  "setup and deploy": "installing, configuring, building, releasing or deploying",
  tests: "writing or fixing tests",
  docs: "writing documentation, a README or other text",
  question: "asking how something works, planning or comparing options, without changing code",
};

// Two separate looks at each session work better than one: what it was about is judged from how it
// started, and whether it was finished from how it ended. In tests on made-up sessions, asking about
// the whole session at once judged "finished" no better than chance; asking this way got it right.
const ABOUT = {
  type: { type: "choice", instructions: "What kind of software work is this Claude Code session about?", criteria: TYPES },
  decision: { type: "noul", instructions: "Does this session record a decision worth remembering for later work on the project?" },
} as const;
const ENDING = {
  finished: { type: "noul", instructions: "The work described here is complete and nothing is left to do." },
} as const;

/** Sessions that changed within this time may still be going on, so they are not labelled yet. */
export const SETTLE_MS = 10 * 60 * 1000;
/** Below this chance of being finished, a session counts as unfinished work. */
export const UNFINISHED_BELOW = 0.45;

export interface Labels {
  type: string;
  typeConfidence: number;
  /** Chance that the work was finished; null when the session has no ending to judge. */
  finished: number | null;
  decision: number;
  /** The transcript's modification time when it was labelled; a newer transcript is labelled again. */
  modified: number;
}

export interface Model {
  systemOne(state: unknown, questions: object): Promise<{ answers: Record<string, any> }>;
}

export const labelsFile = () => path.join(home(), "brain", "labels.json");

/** Where Laya puts its downloaded model inside a cache folder. */
export const bundleDir = (cache: string) => path.join(cache, "receptron--laya-onnx", "main");
export const bundleReady = (cache: string) =>
  ["laya.onnx", "laya.onnx.data", "laya_config.json", "tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json"]
    .every((file) => fs.existsSync(path.join(bundleDir(cache), file)));
export const sessionKey = (s: Pick<Session, "profile" | "id">) => `${s.profile}:${s.id}`;

export function loadLabels(): Record<string, Labels> {
  try {
    return JSON.parse(fs.readFileSync(labelsFile(), "utf8"));
  } catch {
    return {};
  }
}

export function saveLabels(labels: Record<string, Labels>): void {
  fs.mkdirSync(path.dirname(labelsFile()), { recursive: true });
  const temp = labelsFile() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(labels), "utf8");
  fs.renameSync(temp, labelsFile());
}

/** Moves a renamed profile's Smart sorting labels onto its new name, matching sessions.ts's migration. */
export function renameProfileLabels(oldName: string, newName: string): void {
  if (oldName === newName) return;
  const labels = loadLabels();
  const prefix = `${oldName}:`;
  let changed = false;
  for (const [key, label] of Object.entries(labels)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    // Names can contain ":", so "A:" also starts "A:b:<id>" (profile "A:b"); a session id never does.
    if (rest.includes(":")) continue;
    const newKey = `${newName}:${rest}`;
    delete labels[key];
    if (!labels[newKey]) labels[newKey] = label;
    changed = true;
  }
  if (changed) saveLabels(labels);
}

/** Sessions that have settled and have no labels for their current transcript yet. */
export function pending(sessions: Session[], labels: Record<string, Labels>, now = Date.now(), failed?: Map<string, number>): Session[] {
  // A session the model could not sort is not tried again until it changes: retrying it every recheck
  // would keep the model loaded for good.
  return sessions.filter((s) => now - s.modified > SETTLE_MS && labels[sessionKey(s)]?.modified !== s.modified && failed?.get(sessionKey(s)) !== s.modified);
}

/** What the model reads to judge what a session was about. It sees about 512 tokens, so the start matters most. */
export function describe(session: Session): string {
  return [
    `Title: ${session.title}`,
    `Main topics: ${session.keywords.join(", ")}`,
    "What the user asked, in order:",
    ...session.prompts.map((p) => `- ${p}`),
  ].join("\n");
}

/** What the model reads to judge whether the work was finished: only how the session ended. */
export function describeEnding(session: Session): string | null {
  if (!session.lastPrompt && !session.lastReply) return null;
  return [
    session.lastPrompt ? `The user's last message: ${session.lastPrompt}` : "",
    session.lastReply ? `The assistant's last reply: ${session.lastReply}` : "",
  ].filter(Boolean).join("\n");
}

export async function classify(model: Model, session: Session): Promise<Labels> {
  const about = (await model.systemOne(describe(session), ABOUT)).answers;
  const ending = describeEnding(session);
  const finished = ending === null ? null : (await model.systemOne(ending, ENDING)).answers.finished.noul;
  return {
    type: about.type.choice,
    typeConfidence: about.type.confidence,
    finished,
    decision: about.decision.noul,
    modified: session.modified,
  };
}

export const isUnfinished = (labels?: Labels) => !!labels && labels.finished !== null && labels.finished < UNFINISHED_BELOW;

/**
 * How many rechecks in a row may find nothing to sort before the model is closed. Loaded it holds
 * about 1.8 GB; closed, the worker holds under 100 MB. Loading it again takes 2-3 seconds while its files
 * are in the system's disk cache and about a minute when they have to be read from disk again.
 */
export const UNLOAD_AFTER_IDLE_CHECKS = 2;

/** The sorting model, loaded only while there is something to sort. */
export class IdleModel<M extends { close(): Promise<void> }> {
  private model: M | null = null;
  private loading: Promise<M> | null = null;
  private idle = 0;

  constructor(private load: () => Promise<M>, private idleChecks = UNLOAD_AFTER_IDLE_CHECKS) {}

  get loaded(): boolean {
    return this.model !== null;
  }

  /** The model for a recheck that found work, loaded first if it was closed. */
  async get(): Promise<M> {
    this.idle = 0;
    if (this.model) return this.model;
    this.loading ??= this.load().finally(() => (this.loading = null));
    return (this.model = await this.loading);
  }

  /** A recheck found nothing to sort: after enough of those in a row the model is closed. */
  async idleCheck(): Promise<void> {
    if (!this.model || ++this.idle < this.idleChecks) return;
    const model = this.model;
    this.model = null;
    this.idle = 0;
    await model.close();
  }
}
