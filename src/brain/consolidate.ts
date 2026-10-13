// Consolidation: near-duplicate notes (the same fact said twice, in different words) are found and
// can be merged into one. Finding them never changes anything; merging only happens when asked for,
// one group at a time, so nothing is lost without a confirm.

import { cosine, embed } from "./meaning";
import { Note, notes, removeNote, words } from "./store";

export interface DuplicateGroup {
  keep: Note;
  drop: Note[];
  /** The lowest similarity in the group, 0 to 1: how sure this grouping is. */
  similarity: number;
}

/** How much two texts overlap by meaningful word, when there is no embedding model to compare by meaning. */
function wordOverlap(a: string, b: string): number {
  const wa = new Set(words(a)), wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/**
 * Groups of near-duplicate notes in a project, read-only: nothing is removed. Each group keeps its
 * oldest note and lists the rest to drop. Compared by meaning when a local embedding model answers,
 * otherwise by shared meaningful words; either way the bar is set high, so only real repeats group.
 */
export async function previewDuplicates(folder: string, threshold = 0.88): Promise<DuplicateGroup[]> {
  const all = notes(folder);
  if (all.length < 2) return [];
  const vectors = await embed(all.map((n) => n.text));
  const used = new Set<number>();
  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < all.length; i++) {
    if (used.has(i)) continue;
    const drop: Note[] = [];
    let worst = 1;
    for (let j = i + 1; j < all.length; j++) {
      if (used.has(j)) continue;
      const similarity = vectors ? cosine(vectors[i], vectors[j]) : wordOverlap(all[i].text, all[j].text);
      if (similarity >= threshold) {
        drop.push(all[j]);
        used.add(j);
        worst = Math.min(worst, similarity);
      }
    }
    if (drop.length) {
      used.add(i);
      groups.push({ keep: all[i], drop, similarity: worst });
    }
  }
  return groups;
}

/**
 * A caller's claimed group, cut down to only the notes a fresh preview still calls duplicates of the
 * same kept note: the caller's say-so is never enough on its own (anyone with the page could otherwise
 * name any note, in any project, as a "drop" and have it removed). A claim with no matching fresh
 * group, or a malformed one, drops nothing.
 */
export function safeDrop(fresh: DuplicateGroup[], claimed: { keep?: { text?: unknown; time?: unknown }; drop?: unknown }): Note[] {
  if (!claimed || !Array.isArray(claimed.drop)) return [];
  const matched = fresh.find((g) => g.keep.text === claimed.keep?.text && g.keep.time === claimed.keep?.time);
  if (!matched) return [];
  const allowed = new Set(matched.drop.map((n) => `${n.text}\u0000${n.time}`));
  return (claimed.drop as { text?: unknown; time?: unknown }[])
    .filter((n) => typeof n?.text === "string" && typeof n?.time === "string" && allowed.has(`${n.text}\u0000${n.time}`))
    .map((n) => ({ text: n.text as string, time: n.time as string, source: "" }));
}

/** Removes a group's "drop" notes, keeping "keep" untouched. Returns how many were actually removed. */
export function applyMerge(folder: string, group: Pick<DuplicateGroup, "drop">): number {
  let removed = 0;
  for (const note of group.drop) {
    const index = notes(folder).findIndex((n) => n.text === note.text && n.time === note.time);
    if (index >= 0 && removeNote(folder, index + 1)) removed++;
  }
  return removed;
}
