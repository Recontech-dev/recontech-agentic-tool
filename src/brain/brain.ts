// The brain: notes and past sessions together, searchable and drawn as a network.

import * as path from "node:path";

import { Session, Source, refresh, sameFolder } from "./sessions";
import { clusterCount, clusterLabels, pageRank, semanticMap, wordVectors } from "./graphmath";
import { cachedVectors, closeness } from "./meaning";
import * as reinforce from "./reinforce";
import { Labels, isUnfinished, loadLabels, sessionKey } from "./sorting";
import { Note, bm25, label, noteId, notes, score, tree, words } from "./store";

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
  /** For a session node standing in for several duplicate or near-identical ones: how many it merges. */
  count?: number;
  /** Every session folded into this node (including the one "resume" points at), so any of them can still be found. */
  merged?: { profile: string; id: string }[];
  /** A PageRank-style centrality score, 0 to 1, from the picture's own links plus how often this was recalled with others. */
  importance?: number;
  /** For notes and sessions: where it sits on the map by meaning (-1 to 1 on each axis), and its topic cluster (-1 for none). */
  semantic?: [number, number];
  cluster?: number;
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
  /** For notes: a research finding rather than a decision, and where it came from. */
  research?: boolean;
  url?: string;
}

/** A note as a recall match: research keeps its kind and source. */
function noteMatch(project: { name: string; folder: string }, note: Note): Match {
  const match: Match = { kind: "note", project: project.name, folder: project.folder, text: note.text, when: note.time };
  if (note.kind === "research") match.research = true;
  if (note.url) match.url = note.url;
  return match;
}

const SESSIONS_PER_PROJECT = 12;
const MAX_TOPICS = 30;
const ACTIVE_MS = 10 * 60 * 1000;
const MEANING_FLOOR = 0.46;
const MEANING_BAND = 0.08;
/** How much a BM25 keyword score (normalised 0 to 1) counts next to a meaning score (already 0 to 1). */
const KEYWORD_WEIGHT = 0.35;
/** How much a one-hop neighbour's score carries over to it, compared with a direct hit. */
const EXPAND_WEIGHT = 0.4;
/**
 * How much a research finding that matches the query is lifted, from whichever project: a lesson
 * learned in one project should come up first when the next one meets the same problem.
 */
const RESEARCH_BOOST = 0.2;
/** Only a recall's best few direct hits are used as seeds for one-hop expansion. */
const EXPAND_SEEDS = 5;

export class Brain {
  sessions: Session[] = [];
  labels: Record<string, Labels> = {};

  /** The last map by meaning and its clusters, and what it was worked out from. */
  private semanticMemo: { key: string; xy: [number, number][]; cluster: number[]; labels: string[] } | null = null;

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
        if (points) found.push([points * (note.kind === "research" ? 1 + RESEARCH_BOOST : 1), noteMatch(project, note)]);
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
   * Hybrid recall: a keyword (BM25) score and a meaning score (when a local embedding model is
   * available) are merged into one ranking, then one-hop graph expansion adds anything that was not
   * hit directly but shares a topic word, or was recalled together with a direct hit before, at a
   * lower score. Every id returned is strengthened for next time (see reinforce.ts).
   */
  async searchSmart(query: string, limit = 10, options: { reinforce?: boolean } = {}): Promise<{ matches: Match[]; byMeaning: boolean }> {
    const candidates: Match[] = [];
    const ids: string[] = [];
    for (const project of tree()) {
      for (const note of project.notes) {
        candidates.push(noteMatch(project, note));
        ids.push(noteId(project.folder, note.text));
      }
    }
    // What is compared by meaning and keywords: the subject only, without the sorting labels shown to the reader.
    const subjects: string[] = candidates.map((c) => c.text);
    for (const session of this.sessions) {
      const subject = `${session.title}. You asked: ${session.prompts.slice(0, 3).join(" / ")}`;
      candidates.push({
        kind: "session", project: path.basename(session.folder), folder: session.folder,
        text: this.describeLabels(session) + subject, when: session.ended.slice(0, 16).replace("T", " "),
        resume: { profile: session.profile, id: session.id, folder: session.folder },
      });
      subjects.push(subject);
      ids.push(`s:${session.profile}:${session.id}`);
    }

    const near = await closeness(query, subjects.map((s) => s.slice(0, 600)));
    const byMeaning = !!near;
    const best = near ? Math.max(0, ...near) : 0;
    const keyword = bm25(query, subjects);
    const maxKeyword = Math.max(0, ...keyword) || 1;
    const total = subjects.map((_, i) => (near ? near[i] : 0) + KEYWORD_WEIGHT * (keyword[i] / maxKeyword));
    // Only a direct hit is lifted (the filter below reads near and keyword, not total), so research never comes up off-topic.
    candidates.forEach((c, i) => { if (c.research) total[i] += RESEARCH_BOOST; });

    // Related by meaning (measured with the nomic-embed-text model: unrelated text scores up to about
    // 0.44, related text from about 0.48) and close to the best match, or sharing a real keyword.
    const direct = candidates
      .map((_, i) => i)
      .filter((i) => (near && near[i] >= MEANING_FLOOR && near[i] >= best - MEANING_BAND) || keyword[i] > 0)
      .sort((a, b) => total[b] - total[a]);

    // One-hop expansion: candidates not hit directly, but linked to a direct hit by a shared topic
    // word or by having been recalled together with it before (see reinforce.ts).
    const topicIndex = new Map<string, number[]>();
    subjects.forEach((s, i) => {
      for (const w of new Set(words(s).slice(0, 6))) topicIndex.set(w, [...(topicIndex.get(w) ?? []), i]);
    });
    const directSet = new Set(direct);
    const expanded = new Map<number, number>();
    for (const seed of direct.slice(0, EXPAND_SEEDS)) {
      const seedScore = total[seed] * EXPAND_WEIGHT;
      for (const w of new Set(words(subjects[seed]).slice(0, 6))) {
        for (const j of topicIndex.get(w) ?? []) {
          if (j === seed || directSet.has(j)) continue;
          expanded.set(j, Math.max(expanded.get(j) ?? 0, seedScore));
        }
      }
      for (const { id: otherId, weight } of reinforce.neighbours(ids[seed])) {
        const j = ids.indexOf(otherId);
        if (j < 0 || directSet.has(j)) continue;
        expanded.set(j, Math.max(expanded.get(j) ?? 0, seedScore * Math.min(1, weight / 3)));
      }
    }

    const ranked = [...direct.map((i) => ({ i, total: total[i] })), ...[...expanded.entries()].map(([i, score]) => ({ i, total: score }))]
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
    // Fired, not awaited: results never wait on another process's lock, and a failed reinforce is only a missed boost.
    // Off for a search still being typed, so half-typed queries do not count as uses.
    if (options.reinforce !== false) reinforce.touch(ranked.map((r) => ids[r.i])).catch(() => {});
    return { matches: ranked.map((r) => candidates[r.i]), byMeaning };
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
    // Numbered as stored, so forget's numbers hold; research is listed apart from decisions, with its source.
    const numbered = kept.map((note, i) => ({ note, n: i + 1 }));
    const decided = numbered.filter(({ note }) => note.kind !== "research");
    const learned = numbered.filter(({ note }) => note.kind === "research");
    if (!kept.length) lines.push("No notes saved yet.");
    if (decided.length) lines.push("Notes:");
    for (const { note, n } of decided) lines.push(`  ${n}. (${note.time.slice(0, 10)}) ${note.text}`);
    if (learned.length) lines.push("Research (what was learned, with its source):");
    for (const { note, n } of learned) lines.push(`  ${n}. (${note.time.slice(0, 10)}) ${note.text}${note.url ? ` Source: ${note.url}` : ""}`);
    if (past.length) {
      lines.push("Recent sessions:");
      for (const s of past) {
        lines.push(`  - ${s.ended.slice(0, 10)} ${this.describeLabels(s)}"${s.title}" (${s.profile}). Asked: ${s.prompts.slice(0, 3).join(" / ")}`);
      }
    }
    return lines.join("\n");
  }

  graph(currentFolder: string, colors: Record<string, string> = {}): { nodes: Node[]; links: Link[]; clusters: string[] } {
    const nodes: Node[] = [];
    // What each note and session is about, worded as recall embeds it, so the vectors it cached fit.
    const subjects = new Map<string, string>();
    // And its words, for word vectors and cluster names: without the "You asked" every session subject shares.
    const topics = new Map<string, string>();
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
    // How a reinforcement id (reinforce.ts's own note/session ids) maps onto a node actually drawn,
    // so a co-recall edge can be folded into this picture's own centrality score.
    const reinforceToNode = new Map<string, string>();

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
        reinforceToNode.set(noteId(project.folder, note.text), id);
        subjects.set(id, note.text);
        topics.set(id, note.text);
      });
    }

    // Sessions whose project and short label are the same look like the one circle repeated: grouped
    // here into a single node with a count, newest first, so the picture shows one hub, not a clump.
    const sessionGroups = new Map<string, Session[]>();
    for (const session of this.sessions) {
      const key = `${session.folder.replace(/[\\/]+$/, "").toLowerCase()}\u0000${label(session.title)}`;
      sessionGroups.set(key, [...(sessionGroups.get(key) ?? []), session]);
    }
    const perProject = new Map<string, number>();
    const now = Date.now();
    for (const sessions of sessionGroups.values()) {
      const newest = sessions[0];
      const parent = projectNode(newest.folder);
      const count = perProject.get(parent) ?? 0;
      if (count >= SESSIONS_PER_PROJECT) continue;
      perProject.set(parent, count + 1);
      const id = sessions.length > 1 ? `g:${parent}:${label(newest.title)}` : `s:${newest.profile}:${newest.id}`;
      const labels = this.labels[sessionKey(newest)];
      const sorted = labels && labels.modified === newest.modified ? labels : undefined;
      nodes.push({
        id, kind: "session", label: label(newest.title), text: newest.title,
        detail: [
          sessions.length > 1 ? `session ×${sessions.length}` : "session", sorted?.type,
          isUnfinished(sorted) ? "unfinished" : undefined, newest.profile,
          newest.ended.slice(0, 16).replace("T", " "), `${newest.prompts.length} prompts`,
        ].filter(Boolean).join(" · "),
        open: now - newest.modified < ACTIVE_MS,
        color: colors[newest.profile],
        resume: { profile: newest.profile, id: newest.id, folder: newest.folder },
        tag: sorted?.type,
        unfinished: isUnfinished(sorted),
        count: sessions.length > 1 ? sessions.length : undefined,
        merged: sessions.length > 1 ? sessions.map((s) => ({ profile: s.profile, id: s.id })) : undefined,
      });
      links.push({ source: parent, target: id });
      addWords(id, newest.keywords.slice(0, 5));
      subjects.set(id, `${newest.title}. You asked: ${newest.prompts.slice(0, 3).join(" / ")}`);
      topics.set(id, `${newest.title}. ${newest.prompts.slice(0, 3).join(" / ")}`);
      for (const session of sessions) reinforceToNode.set(`s:${session.profile}:${session.id}`, id);
    }

    const shared = [...topicWords.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOPICS);
    for (const [word, ids] of shared) {
      nodes.push({ id: `t:${word}`, kind: "topic", label: word, text: word, detail: `shared by ${ids.length} notes and sessions`, open: false });
      for (const id of ids) links.push({ source: `t:${word}`, target: id });
    }

    const reinforced = reinforce.allEdges().flatMap(({ a, b, weight }) => {
      const na = reinforceToNode.get(a), nb = reinforceToNode.get(b);
      return na && nb && na !== nb ? [{ a: na, b: nb, weight }] : [];
    });
    const importance = pageRank(
      nodes.map((n) => n.id),
      [...links.map((l) => ({ a: l.source, b: l.target })), ...reinforced],
    );
    for (const node of nodes) node.importance = importance[node.id];

    // The map by meaning and the topic clusters, worked out here once like importance: from the
    // embeddings recall already cached when every item has one, otherwise from shared words.
    // The picture is rebuilt on a timer, so the map is kept and only worked out again when what is on it changes.
    const placed = nodes.filter((n) => subjects.has(n.id));
    const texts = placed.map((n) => subjects.get(n.id)!.slice(0, 600));
    const cached = cachedVectors(texts);
    const byMeaning = cached.length > 0 && cached.every((v) => v);
    const key = `${byMeaning ? "e" : "w"}${texts.join("")}`;
    if (this.semanticMemo?.key !== key) {
      const docs = placed.map((n) => words(topics.get(n.id)!.slice(0, 600)));
      const vectors = byMeaning ? (cached as number[][]) : wordVectors(docs);
      const { xy, cluster } = semanticMap(vectors, clusterCount(placed.length));
      this.semanticMemo = { key, xy, cluster, labels: clusterLabels(cluster, docs) };
    }
    const { xy, cluster, labels } = this.semanticMemo;
    placed.forEach((n, i) => {
      n.semantic = [Math.round(xy[i][0] * 1e4) / 1e4, Math.round(xy[i][1] * 1e4) / 1e4];
      n.cluster = cluster[i];
    });

    return { nodes, links, clusters: labels };
  }
}
