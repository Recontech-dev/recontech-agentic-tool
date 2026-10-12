// The brain: notes and past sessions together, searchable and drawn as a network.

import * as path from "node:path";

import { Session, Source, refresh, sameFolder } from "./sessions";
import { closeness } from "./meaning";
import { Labels, isUnfinished, loadLabels, sessionKey } from "./sorting";
import { Note, label, notes, score, tree, words } from "./store";

export interface Node {
  id: string;
  kind: "project" | "note" | "session" | "topic";
  label: string;
  text: string;
  detail: string;
  open: boolean;
  /** For sessions: the profile's colour, and what is needed to resume it. */
  color?: string;
  resume?: { profile: string; id: string; folder: string };
  /** From Smart sorting, when it is on: the kind of work, and whether it was left unfinished. */
  tag?: string;
  unfinished?: boolean;
  /** For notes: where the note lives, so it can be deleted from the picture. */
  note?: { folder: string; number: number };
}

export interface Link {
  source: string;
  target: string;
}

export interface Match {
  kind: "note" | "session";
  project: string;
  folder: string;
  text: string;
  when: string;
  /** For sessions: what is needed to resume it. */
  resume?: { profile: string; id: string; folder: string };
}

const SESSIONS_PER_PROJECT = 12;
const MAX_TOPICS = 30;
const ACTIVE_MS = 10 * 60 * 1000;
const MEANING_FLOOR = 0.46;
const MEANING_BAND = 0.08;

export class Brain {
  sessions: Session[] = [];
  labels: Record<string, Labels> = {};

  constructor(public sources: () => Source[]) {}

  /** Read new transcripts. Returns true when something changed. */
  update(): boolean {
    const result = refresh(this.sources());
    this.sessions = result.sessions;
    const labels = loadLabels();
    const labelsChanged = JSON.stringify(labels) !== JSON.stringify(this.labels);
    this.labels = labels;
    return result.changed || labelsChanged;
  }

  search(query: string, limit = 10): Match[] {
    const found: [number, Match][] = [];
    for (const project of tree()) {
      for (const note of project.notes) {
        const points = score(query, note.text);
        if (points) found.push([points, { kind: "note", project: project.name, folder: project.folder, text: note.text, when: note.time }]);
      }
    }
    for (const session of this.sessions) {
      const points = score(query, [session.title, ...session.prompts, ...session.keywords].join(" "));
      if (points) {
        found.push([points, {
          kind: "session", project: path.basename(session.folder), folder: session.folder,
          text: `${this.describeLabels(session)}${session.title}. You asked: ${session.prompts.slice(0, 3).join(" / ")}`,
          when: session.ended.slice(0, 16).replace("T", " "),
          resume: { profile: session.profile, id: session.id, folder: session.folder },
        }]);
      }
    }
    found.sort((a, b) => b[0] - a[0] || b[1].when.localeCompare(a[1].when));
    return found.slice(0, limit).map(([, match]) => match);
  }

  /**
   * Like search, but also by meaning when a local embedding model is available: a note about
   * "deploy" is found by "how do we ship it". Falls back to matching words.
   */
  async searchSmart(query: string, limit = 10): Promise<{ matches: Match[]; byMeaning: boolean }> {
    const candidates: Match[] = [];
    for (const project of tree()) {
      for (const note of project.notes) candidates.push({ kind: "note", project: project.name, folder: project.folder, text: note.text, when: note.time });
    }
    // What is compared by meaning: the subject only, without the sorting labels shown to the reader.
    const subjects: string[] = candidates.map((c) => c.text);
    for (const session of this.sessions) {
      const subject = `${session.title}. You asked: ${session.prompts.slice(0, 3).join(" / ")}`;
      candidates.push({
        kind: "session", project: path.basename(session.folder), folder: session.folder,
        text: this.describeLabels(session) + subject, when: session.ended.slice(0, 16).replace("T", " "),
        resume: { profile: session.profile, id: session.id, folder: session.folder },
      });
      subjects.push(subject);
    }
    const near = await closeness(query, subjects.map((s) => s.slice(0, 600)));
    if (!near) return { matches: this.search(query, limit), byMeaning: false };
    const best = Math.max(0, ...near);
    const ranked = candidates
      .map((match, i) => ({ match, total: near[i] + 0.08 * score(query, subjects[i]), near: near[i], words: score(query, subjects[i]) }))
      // Related by meaning (measured with the nomic-embed-text model: unrelated text scores up to about
      // 0.44, related text from about 0.48) and close to the best match, or sharing a real word.
      .filter((r) => (r.near >= MEANING_FLOOR && r.near >= best - MEANING_BAND) || r.words > 0)
      .sort((a, b) => b.total - a.total);
    return { matches: ranked.slice(0, limit).map((r) => r.match), byMeaning: true };
  }

  /** Sessions that Smart sorting judged unfinished, the given project's first, newest first. */
  unfinished(folder = ""): { title: string; project: string; folder: string; profile: string; id: string; ended: string; type: string; here: boolean }[] {
    return this.sessions
      .filter((s) => {
        const labels = this.labels[sessionKey(s)];
        return labels && labels.modified === s.modified && isUnfinished(labels);
      })
      .map((s) => ({
        title: s.title, project: path.basename(s.folder), folder: s.folder, profile: s.profile, id: s.id,
        ended: s.ended, type: this.labels[sessionKey(s)].type, here: !!folder && sameFolder(s.folder, folder),
      }))
      .sort((a, b) => Number(b.here) - Number(a.here) || b.ended.localeCompare(a.ended));
  }

  /** "[bug fix, unfinished] " when Smart sorting has labelled the session, otherwise nothing. */
  describeLabels(session: Session): string {
    const labels = this.labels[sessionKey(session)];
    if (!labels || labels.modified !== session.modified) return "";
    return `[${labels.type}${isUnfinished(labels) ? ", unfinished" : ""}] `;
  }

  /** Everything the brain holds about one project, as text for a model to read. */
  projectSummary(folder: string): string {
    const kept: Note[] = notes(folder);
    const all = this.sessions.filter((s) => sameFolder(s.folder, folder));
    const past = all.slice(0, 8);
    const open = all.filter((s) => isUnfinished(this.labels[sessionKey(s)])).slice(0, 8);
    const lines = [`Project: ${folder}`];
    if (open.length) {
      lines.push("Unfinished work (sessions that looked unfinished when they ended):");
      for (const s of open) lines.push(`  - ${s.ended.slice(0, 10)} "${s.title}". Asked: ${s.prompts.slice(0, 2).join(" / ")}`);
    }
    lines.push(kept.length ? "Notes:" : "No notes saved yet.");
    kept.forEach((note, i) => lines.push(`  ${i + 1}. (${note.time.slice(0, 10)}) ${note.text}`));
    if (past.length) {
      lines.push("Recent sessions:");
      for (const s of past) {
        lines.push(`  - ${s.ended.slice(0, 10)} ${this.describeLabels(s)}"${s.title}" (${s.profile}). Asked: ${s.prompts.slice(0, 3).join(" / ")}`);
      }
    }
    return lines.join("\n");
  }

  graph(currentFolder: string, colors: Record<string, string> = {}): { nodes: Node[]; links: Link[] } {
    const nodes: Node[] = [];
    const links: Link[] = [];
    const projects = new Map<string, string>();
    const projectNode = (folder: string): string => {
      const key = folder.replace(/[\\/]+$/, "").toLowerCase();
      if (!projects.has(key)) {
        const id = `p${projects.size}`;
        projects.set(key, id);
        nodes.push({
          id, kind: "project", label: path.basename(folder) || folder, text: folder, detail: "project",
          open: !!currentFolder && sameFolder(folder, currentFolder),
        });
      }
      return projects.get(key)!;
    };
    const topicWords = new Map<string, string[]>();
    const addWords = (id: string, list: string[]) => {
      for (const word of new Set(list)) topicWords.set(word, [...(topicWords.get(word) ?? []), id]);
    };

    for (const project of tree()) {
      const parent = projectNode(project.folder);
      project.notes.forEach((note, n) => {
        const id = `${parent}n${n}`;
        nodes.push({
          id, kind: "note", label: label(note.text), text: note.text, detail: `note · ${project.name} · ${note.time}`,
          open: nodes.find((x) => x.id === parent)!.open,
          note: { folder: project.folder, number: n + 1 },
        });
        links.push({ source: parent, target: id });
        addWords(id, words(note.text).slice(0, 6));
      });
    }

    const perProject = new Map<string, number>();
    const now = Date.now();
    for (const session of this.sessions) {
      const parent = projectNode(session.folder);
      const count = perProject.get(parent) ?? 0;
      if (count >= SESSIONS_PER_PROJECT) continue;
      perProject.set(parent, count + 1);
      const id = `s:${session.profile}:${session.id}`;
      const labels = this.labels[sessionKey(session)];
      const sorted = labels && labels.modified === session.modified ? labels : undefined;
      nodes.push({
        id, kind: "session", label: label(session.title), text: session.title,
        detail: [
          "session", sorted?.type, isUnfinished(sorted) ? "unfinished" : undefined, session.profile,
          session.ended.slice(0, 16).replace("T", " "), `${session.prompts.length} prompts`,
        ].filter(Boolean).join(" · "),
        open: now - session.modified < ACTIVE_MS,
        color: colors[session.profile],
        resume: { profile: session.profile, id: session.id, folder: session.folder },
        tag: sorted?.type,
        unfinished: isUnfinished(sorted),
      });
      links.push({ source: parent, target: id });
      addWords(id, session.keywords.slice(0, 5));
    }

    const shared = [...topicWords.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOPICS);
    for (const [word, ids] of shared) {
      nodes.push({ id: `t:${word}`, kind: "topic", label: word, text: word, detail: `shared by ${ids.length} notes and sessions`, open: false });
      for (const id of ids) links.push({ source: `t:${word}`, target: id });
    }
    return { nodes, links };
  }
}
