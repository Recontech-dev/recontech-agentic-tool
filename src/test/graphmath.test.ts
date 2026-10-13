import assert from "node:assert/strict";
import { test } from "node:test";

import { GENERIC_WORDS, clusterCount, clusterLabels, kmeans, pageRank, pca2, semanticMap, splitLarge, wordVectors } from "../brain/graphmath";

test("a hub in a star graph is the most central node, and a bare id with no edges still gets a share", () => {
  const ids = ["hub", "a", "b", "c", "d"];
  const edges = ids.slice(1).map((leaf) => ({ a: "hub", b: leaf }));
  const rank = pageRank(ids, edges);
  assert.equal(rank.hub, 1, "the normalised top score is always 1");
  for (const leaf of ["a", "b", "c", "d"]) assert.ok(rank[leaf] < rank.hub);
  assert.ok(new Set(["a", "b", "c", "d"].map((id) => Math.round(rank[id] * 1e6))).size === 1, "equal leaves rank equally");

  const lone = pageRank(["lone", ...ids], [...edges]);
  assert.ok(lone.lone > 0 && lone.lone < lone.hub, "a node nobody links to still gets a positive, low score");
});

test("pageRank is deterministic and a heavier edge pulls rank across it", () => {
  const ids = ["x", "y", "z"];
  const once = pageRank(ids, [{ a: "x", b: "y" }, { a: "y", b: "z" }]);
  const twice = pageRank(ids, [{ a: "x", b: "y" }, { a: "y", b: "z" }]);
  assert.deepEqual(once, twice);

  const weighted = pageRank(ids, [{ a: "x", b: "y", weight: 1 }, { a: "y", b: "z", weight: 10 }]);
  assert.ok(weighted.z > weighted.x, "z, joined by the heavier edge, outranks x");
});

test("k-means groups points by distance and is deterministic across runs", () => {
  const points = [[0, 0], [0.1, -0.1], [10, 10], [10.2, 9.8], [20, 0], [20.1, 0.2]];
  const first = kmeans(points, 3);
  assert.equal(new Set(first).size, 3, "three well-separated clusters are found");
  assert.equal(first[0], first[1], "the two near-origin points share a cluster");
  assert.equal(first[2], first[3]);
  assert.equal(first[4], first[5]);
  assert.notEqual(first[0], first[2]);
  assert.deepEqual(kmeans(points, 3), first, "same input, same clustering, every time");
  assert.equal(kmeans(points, 1).every((c) => c === 0), true, "k larger than needed still returns one id per point");
  assert.deepEqual(kmeans([], 3), []);
});

test("PCA projects variance onto the first axis, fixes its sign, and never reshuffles on repeat", () => {
  // Points spread far along x, a little along y: the first axis should carry almost all of it.
  const points = [[-10, 1], [-5, -1], [0, 0], [5, 1], [10, -1]];
  const projected = pca2(points);
  assert.equal(projected.length, points.length);
  const xs = projected.map(([x]) => x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 15, "the first axis captures the wide spread");
  const ys = projected.map(([, y]) => y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < Math.max(...xs) - Math.min(...xs), "the second axis carries much less");
  // The point with the largest x in the original data keeps the largest first coordinate (sign fixed outward).
  assert.ok(xs[4] > xs[0]);
  assert.deepEqual(pca2(points), projected, "deterministic: no run reshuffles the picture");
  assert.deepEqual(pca2([]), []);
});

test("word vectors use only shared terms, are unit length, and are the same every time", () => {
  const docs = [["docker", "deploy", "image"], ["docker", "image", "registry"], ["stripe", "payment"], ["stripe", "webhook", "payment"], ["lonely"]];
  const vectors = wordVectors(docs);
  assert.equal(vectors[0].length, 4, "docker, image, payment, stripe: shared by two documents each");
  for (const v of vectors.slice(0, 4)) assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  assert.ok(vectors[4].every((x) => x === 0), "a document sharing no term gets no direction");
  assert.deepEqual(wordVectors(docs), vectors);
});

test("the map by meaning puts related items together, splits topics into clusters, and stays put between runs", () => {
  const docs = [
    ["docker", "deploy", "image"], ["docker", "image", "registry"], ["docker", "deploy", "registry"],
    ["stripe", "payment", "refund"], ["stripe", "payment", "webhook"], ["stripe", "refund", "webhook"],
    [],
  ];
  const { xy, cluster } = semanticMap(wordVectors(docs), 2);
  assert.equal(new Set(cluster.slice(0, 3)).size, 1, "the docker items share a cluster");
  assert.equal(new Set(cluster.slice(3, 6)).size, 1, "the stripe items share a cluster");
  assert.notEqual(cluster[0], cluster[3], "and the two topics are apart");
  assert.equal(cluster[6], -1, "an item with nothing to place sits in no cluster");
  assert.deepEqual(xy[6], [0, 0]);
  for (const [x, y] of xy) assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, "scaled into -1..1");
  const gap = (i: number, j: number) => Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]);
  assert.ok(gap(0, 1) < gap(0, 3) && gap(3, 4) < gap(1, 4), "near its own topic, far from the other");
  assert.deepEqual(semanticMap(wordVectors(docs), 2), { xy, cluster }, "deterministic");
  assert.deepEqual(clusterLabels(cluster, docs).sort(), ["docker", "stripe"], "each cluster is named by the word its members share most");
  assert.deepEqual(semanticMap([]), { xy: [], cluster: [] });
});

test("the number of clusters grows slowly with the picture", () => {
  assert.equal(clusterCount(3), 1);
  assert.equal(clusterCount(8), 2);
  assert.equal(clusterCount(50), 5);
  assert.equal(clusterCount(1000), 8);
});

test("a cluster holding more than 40% of the items is split again, the same way every time", () => {
  // Three tight groups far apart, but k = 2 lumps two of them together: 8 of 12 items in one cluster.
  const points = [
    ...Array.from({ length: 4 }, (_, i) => [0 + i * 0.01, 0]),
    ...Array.from({ length: 4 }, (_, i) => [10 + i * 0.01, 0]),
    ...Array.from({ length: 4 }, (_, i) => [100 + i * 0.01, 0]),
  ];
  const lumped = kmeans(points, 2);
  assert.equal(Math.max(...[0, 1].map((c) => lumped.filter((g) => g === c).length)), 8, "plain k-means leaves one cluster too big");
  const split = splitLarge(points, lumped);
  const sizes = [...new Set(split)].map((c) => split.filter((g) => g === c).length);
  assert.ok(sizes.every((size) => size <= 12 * 0.4), `no cluster over 40%: ${sizes}`);
  assert.equal(new Set(split.slice(0, 4)).size, 1);
  assert.equal(new Set(split.slice(4, 8)).size, 1);
  assert.notEqual(split[0], split[4], "the lumped groups come apart where they really differ");
  assert.deepEqual(splitLarge(points, lumped), split, "deterministic");
  assert.deepEqual(splitLarge([[0], [0], [0]], [0, 0, 0]), [0, 0, 0], "identical points cannot be split and are left alone");
  const { cluster } = semanticMap(points, 2);
  assert.ok([...new Set(cluster)].every((c) => cluster.filter((g) => g === c).length <= 4.8), "the map splits too");
});

test("a cluster is named by its most distinctive word, never a filler or the app's own vocabulary, and names do not repeat", () => {
  const docs = [
    ["terminal", "after", "docker", "deploy"], ["terminal", "after", "docker", "image"], ["terminal", "after", "docker", "registry"],
    ["terminal", "after", "stripe", "payment"], ["terminal", "after", "stripe", "refund"], ["terminal", "after", "payment", "stripe"],
    ["terminal", "session", "claude"], ["terminal", "session", "claude"],
  ];
  const labels = clusterLabels([0, 0, 0, 1, 1, 1, 2, 2], docs);
  assert.deepEqual(labels.slice(0, 2), ["docker", "stripe"], "shared everywhere (terminal, after) loses to what sets a cluster apart");
  assert.equal(labels[2], "topic 3", "only generic words: a plain name");
  for (const word of ["after", "terminal", "claude", "session", "need", "make"]) assert.ok(GENERIC_WORDS.has(word));
  assert.deepEqual(clusterLabels([0, 0, 1, 1], [["docker", "build"], ["docker", "build"], ["docker", "image"], ["docker", "image"]]), ["build", "image"], "a word another cluster also has ranks lower");
});
