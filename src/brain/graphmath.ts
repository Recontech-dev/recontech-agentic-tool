// Pure graph and vector math for the brain picture: no file I/O, no randomness, so the same input
// always gives the same output (the picture must not reshuffle itself between runs).

export interface Edge {
  a: string;
  b: string;
  weight?: number;
}

/**
 * A PageRank-style centrality score per id, 0 to 1 (the most central node scores 1). Treats every
 * edge as undirected: rank flows both ways, split by each node's total edge weight. Deterministic:
 * no random restart, a fixed iteration count, ids with no edges keep an even, low share.
 */
export function pageRank(ids: string[], edges: Edge[], damping = 0.85, iterations = 40): Record<string, number> {
  const n = ids.length;
  if (!n) return {};
  const index = new Map(ids.map((id, i) => [id, i]));
  const neighbours: [number, number][][] = ids.map(() => []);
  for (const { a, b, weight = 1 } of edges) {
    const ia = index.get(a), ib = index.get(b);
    if (ia === undefined || ib === undefined || ia === ib || weight <= 0) continue;
    neighbours[ia].push([ib, weight]);
    neighbours[ib].push([ia, weight]);
  }
  const outWeight = neighbours.map((list) => list.reduce((sum, [, w]) => sum + w, 0));
  let rank = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    let danglingSum = 0;
    for (let i = 0; i < n; i++) if (!outWeight[i]) danglingSum += rank[i];
    const base = (1 - damping) / n + (damping * danglingSum) / n;
    const next = new Array(n).fill(base);
    for (let i = 0; i < n; i++) {
      if (!outWeight[i]) continue;
      const share = (damping * rank[i]) / outWeight[i];
      for (const [j, w] of neighbours[i]) next[j] += share * w;
    }
    rank = next;
  }
  const max = Math.max(...rank, 1e-9);
  const result: Record<string, number> = {};
  ids.forEach((id, i) => (result[id] = rank[i] / max));
  return result;
}

const dist2 = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0);

/**
 * One cluster number (0 to k - 1) per point, by k-means. Deterministic: the first centre is the point
 * closest to the overall mean, later centres are always the point farthest from the centres so far
 * (ties broken by the earlier index), so the same points always cluster the same way.
 */
export function kmeans(points: number[][], k: number, iterations = 25): number[] {
  const n = points.length;
  if (!n) return [];
  const groups = Math.max(1, Math.min(k, n));
  const dim = points[0].length;
  const mean = new Array(dim).fill(0);
  for (const p of points) for (let d = 0; d < dim; d++) mean[d] += p[d] / n;

  let firstIndex = 0, firstDist = Infinity;
  points.forEach((p, i) => {
    const d = dist2(p, mean);
    if (d < firstDist) { firstDist = d; firstIndex = i; }
  });
  const centres: number[][] = [points[firstIndex].slice()];
  const chosen = new Set([firstIndex]);
  while (centres.length < groups) {
    let farIndex = -1, farDist = -1;
    points.forEach((p, i) => {
      if (chosen.has(i)) return;
      const d = Math.min(...centres.map((c) => dist2(p, c)));
      if (d > farDist) { farDist = d; farIndex = i; }
    });
    if (farIndex === -1) break;
    centres.push(points[farIndex].slice());
    chosen.add(farIndex);
  }

  let assignment = new Array(n).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    const next = points.map((p) => {
      let best = 0, bestDist = Infinity;
      centres.forEach((c, ci) => {
        const d = dist2(p, c);
        if (d < bestDist) { bestDist = d; best = ci; }
      });
      return best;
    });
    const changed = next.some((v, i) => v !== assignment[i]);
    assignment = next;
    if (!changed && iter > 0) break;
    const sums = centres.map(() => new Array(dim).fill(0));
    const counts = new Array(centres.length).fill(0);
    points.forEach((p, i) => {
      counts[assignment[i]]++;
      for (let d = 0; d < dim; d++) sums[assignment[i]][d] += p[d];
    });
    centres.forEach((c, ci) => {
      if (!counts[ci]) return;
      for (let d = 0; d < dim; d++) c[d] = sums[ci][d] / counts[ci];
    });
  }
  return assignment;
}

function normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/** The sign a principal axis settles on by chance; fixed so the same data always draws the same way. */
function fixSign(v: number[]): number[] {
  let maxIndex = 0, maxAbs = -1;
  v.forEach((x, i) => {
    if (Math.abs(x) > maxAbs) { maxAbs = Math.abs(x); maxIndex = i; }
  });
  return v[maxIndex] < 0 ? v.map((x) => -x) : v;
}

/**
 * Each point's [x, y] on the top two principal axes of the (mean-centred) input, by power iteration.
 * Deterministic: iteration always starts from the axis of greatest raw variance and runs a fixed
 * number of steps, and each axis's sign is fixed by its largest component, so the same embeddings
 * always project to the same picture (no randomness, unlike a force layout).
 */
export function pca2(points: number[][]): [number, number][] {
  const n = points.length;
  if (!n) return [];
  const dim = points[0].length;
  const mean = new Array(dim).fill(0);
  for (const p of points) for (let d = 0; d < dim; d++) mean[d] += p[d] / n;
  const centred = points.map((p) => p.map((v, d) => v - mean[d]));

  const matVec = (v: number[]): number[] => {
    const xv = centred.map((row) => row.reduce((sum, x, d) => sum + x * v[d], 0));
    const result = new Array(dim).fill(0);
    centred.forEach((row, i) => {
      for (let d = 0; d < dim; d++) result[d] += row[d] * xv[i];
    });
    return result;
  };

  const axis = (deflate: number[][]): number[] => {
    const variance = new Array(dim).fill(0);
    for (const row of centred) for (let d = 0; d < dim; d++) variance[d] += row[d] * row[d];
    let start = 0, bestVar = -1;
    variance.forEach((v, d) => {
      if (v > bestVar) { bestVar = v; start = d; }
    });
    let v = new Array(dim).fill(0);
    v[start] = 1;
    for (let iter = 0; iter < 60; iter++) {
      let mv = matVec(v);
      for (const d of deflate) {
        const proj = mv.reduce((sum, x, i) => sum + x * d[i], 0);
        mv = mv.map((x, i) => x - proj * d[i]);
      }
      v = normalise(mv);
    }
    return fixSign(v);
  };

  const pc1 = axis([]);
  const pc2 = dim > 1 ? axis([pc1]) : new Array(dim).fill(0);
  return centred.map((row) => [
    row.reduce((sum, x, d) => sum + x * pc1[d], 0),
    row.reduce((sum, x, d) => sum + x * pc2[d], 0),
  ]);
}

/**
 * A TF-IDF vector per document, from its words (already split, stopwords removed), over the terms that
 * at least two documents share, the most widely shared first (at most `maxTerms`); each vector has
 * unit length, or is all zeros when the document shares no term. The fallback for a meaning map when
 * no embedding model is available: deterministic, and topics still pull together by shared words.
 */
export function wordVectors(docs: string[][], maxTerms = 128): number[][] {
  const df = new Map<string, number>();
  for (const doc of docs) for (const word of new Set(doc)) df.set(word, (df.get(word) ?? 0) + 1);
  const terms = [...df.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTerms)
    .map(([word]) => word);
  const index = new Map(terms.map((t, i) => [t, i]));
  const n = docs.length;
  return docs.map((doc) => {
    const v = new Array(terms.length).fill(0);
    for (const word of doc) {
      const i = index.get(word);
      if (i !== undefined) v[i] += Math.log(1 + n / df.get(word)!);
    }
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    return norm ? v.map((x) => x / norm) : v;
  });
}

/** How many topic clusters a picture of `n` notes and sessions gets: about √(n/2), from 2 to 8; one for a handful. */
export const clusterCount = (n: number): number => (n < 4 ? 1 : Math.max(2, Math.min(8, Math.round(Math.sqrt(n / 2)))));

/**
 * Where each item sits on a map by meaning, and which topic cluster it belongs to: positions are the
 * top two principal axes scaled into -1..1, clusters come from k-means on the same vectors. An item
 * with no vector at all (all zeros) sits in the middle with cluster -1. Deterministic throughout.
 */
export function semanticMap(vectors: number[][], k = clusterCount(vectors.length), maxShare = 0.4): { xy: [number, number][]; cluster: number[] } {
  const known = vectors.map((v, i) => ({ v, i })).filter(({ v }) => v.length && v.some((x) => x !== 0));
  const xy: [number, number][] = vectors.map(() => [0, 0]);
  const cluster = vectors.map(() => -1);
  if (!known.length) return { xy, cluster };
  const projected = pca2(known.map(({ v }) => v));
  const scale = [0, 1].map((axis) => Math.max(1e-9, ...projected.map((p) => Math.abs(p[axis]))));
  const groups = splitLarge(known.map(({ v }) => v), kmeans(known.map(({ v }) => v), Math.min(k, known.length)), maxShare);
  known.forEach(({ i }, j) => {
    xy[i] = [projected[j][0] / scale[0], projected[j][1] / scale[1]];
    cluster[i] = groups[j];
  });
  return { xy, cluster };
}

/**
 * Splits any cluster holding more than `maxShare` of the points in two (k-means inside it), until none
 * does or a cluster cannot be split further; the new cluster takes the next free number. One huge
 * cluster says little, and a picture zoomed out to it says less. Deterministic, like kmeans.
 */
export function splitLarge(points: number[][], assignment: number[], maxShare = 0.4, maxClusters = 12): number[] {
  const result = assignment.slice();
  const limit = Math.max(3, Math.floor(points.length * maxShare));
  for (let round = 0; round < maxClusters; round++) {
    const count = Math.max(-1, ...result) + 1;
    if (count >= maxClusters) break;
    const sizes = Array.from({ length: count }, (_, c) => result.filter((g) => g === c).length);
    const big = sizes.findIndex((size) => size > limit);
    if (big < 0) break;
    const members = result.map((g, i) => (g === big ? i : -1)).filter((i) => i >= 0);
    const halves = kmeans(members.map((i) => points[i]), 2);
    if (new Set(halves).size < 2) break;
    members.forEach((i, j) => {
      if (halves[j] === 1) result[i] = count;
    });
  }
  return result;
}

/** Words too general to name a topic: fillers, and the app's own vocabulary, which every session shares. */
export const GENERIC_WORDS = new Set(
  ("after before then also just need needs make made making want wants would could should still again maybe really thing things " +
    "something stuff work working works worked does doing done next first last other others every some much many more most " +
    "terminal terminals claude session sessions asked message messages tell told says said please okay fine good better best " +
    "check checked look looks looked going gone keep kept give gave take took find found help using used uses time today now").split(" "),
);

/**
 * A short, distinctive name for each cluster: the word that is frequent among its members but rare in
 * the other clusters (TF-IDF across clusters), never a generic word, and not one an earlier cluster
 * already took; "topic N" when nothing fits. Ties go alphabetically, so names are stable.
 */
export function clusterLabels(cluster: number[], docs: string[][]): string[] {
  const count = Math.max(-1, ...cluster) + 1;
  const inCluster = Array.from({ length: count }, () => new Map<string, number>());
  const sizes = new Array(count).fill(0);
  cluster.forEach((g, i) => {
    if (g < 0) return;
    sizes[g]++;
    for (const word of new Set(docs[i])) {
      if (GENERIC_WORDS.has(word) || /\d/.test(word)) continue;
      inCluster[g].set(word, (inCluster[g].get(word) ?? 0) + 1);
    }
  });
  const clustersWith = new Map<string, number>();
  for (const tally of inCluster) for (const word of tally.keys()) clustersWith.set(word, (clustersWith.get(word) ?? 0) + 1);
  const taken = new Set<string>();
  return inCluster.map((tally, c) => {
    const ranked = [...tally.entries()]
      .filter(([, n]) => n >= Math.min(2, sizes[c]))
      .map(([word, n]) => ({ word, score: (n / sizes[c]) * Math.log(1 + count / clustersWith.get(word)!) }))
      .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word));
    const best = ranked.find((r) => !taken.has(r.word));
    if (!best) return `topic ${c + 1}`;
    taken.add(best.word);
    return best.word;
  });
}
