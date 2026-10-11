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

/** Sessions that have settled and have no labels for their current transcript yet. */
export function pending(sessions: Session[], labels: Record<string, Labels>, now = Date.now()): Session[] {
  return sessions.filter((s) => now - s.modified > SETTLE_MS && labels[sessionKey(s)]?.modified !== s.modified);
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
