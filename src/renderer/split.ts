// The terminal layout in grid mode: a tree of side-by-side ("row") and stacked ("col") splits whose
// leaves are terminals. Dragging a terminal onto another one changes the tree, the way Chrome's split
// view or Windows snap does. Plain script with no imports or exports: the page loads it before
// renderer.js, and the tests load it into a sandbox. Every function returns a new tree.

interface SplitLeaf { id: string }
interface SplitBranch { dir: "row" | "col"; sizes: number[]; children: SplitNode[] }
type SplitNode = SplitLeaf | SplitBranch;
/** Where a dragged terminal lands on another: beside it on one side, or in its place (a swap). */
type DropZone = "left" | "right" | "top" | "bottom" | "center";

const isSplitLeaf = (node: SplitNode): node is SplitLeaf => "id" in node;

function splitLeaves(node: SplitNode | null): string[] {
  if (!node) return [];
  return isSplitLeaf(node) ? [node.id] : node.children.flatMap(splitLeaves);
}

/** The layout before the user drags anything: the same as the old grid, up to 3 in a row, else two rows. */
function splitDefault(ids: string[]): SplitNode | null {
  if (!ids.length) return null;
  if (ids.length === 1) return { id: ids[0] };
  const row = (part: string[]): SplitNode => (part.length === 1 ? { id: part[0] } : { dir: "row", sizes: part.map(() => 1 / part.length), children: part.map((id) => ({ id })) });
  if (ids.length <= 3) return row(ids);
  const cols = Math.ceil(ids.length / 2);
  return { dir: "col", sizes: [0.5, 0.5], children: [row(ids.slice(0, cols)), row(ids.slice(cols))] };
}

/**
 * Tidies a tree: empty branches go, a branch with one child becomes that child, a branch inside one
 * of the same direction is merged into it, and the sizes in every branch add up to 1.
 */
function splitNormalize(node: SplitNode | null): SplitNode | null {
  if (!node || isSplitLeaf(node)) return node;
  const children: SplitNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const size = Number(node.sizes[i]) > 0 && Number.isFinite(Number(node.sizes[i])) ? Number(node.sizes[i]) : 1 / node.children.length;
    const tidy = splitNormalize(child);
    if (!tidy) return;
    if (!isSplitLeaf(tidy) && tidy.dir === node.dir) {
      tidy.children.forEach((grandchild, j) => {
        children.push(grandchild);
        sizes.push(size * tidy.sizes[j]);
      });
    } else {
      children.push(tidy);
      sizes.push(size);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { dir: node.dir, sizes: sizes.map((s) => s / total), children };
}

function splitRemove(node: SplitNode | null, id: string): SplitNode | null {
  const without = (n: SplitNode): SplitNode | null => {
    if (isSplitLeaf(n)) return n.id === id ? null : { id: n.id };
    const kept = n.children.map((child, i) => ({ child: without(child), size: n.sizes[i] })).filter((k) => k.child);
    return { dir: n.dir, sizes: kept.map((k) => k.size), children: kept.map((k) => k.child!) };
  };
  return splitNormalize(node && without(node));
}

/**
 * Makes a saved tree match the terminals there are now: removed ones leave, one listed twice keeps
 * its first place, and new ones join on the right (or below, when the whole layout is a row already).
 */
function splitReconcile(node: SplitNode | null | undefined, ids: string[]): SplitNode | null {
  if (!node) return splitDefault(ids);
  const wanted = new Set(ids);
  const seen = new Set<string>();
  const keep = (n: SplitNode): SplitNode | null => {
    if (isSplitLeaf(n)) {
      if (!wanted.has(n.id) || seen.has(n.id)) return null;
      seen.add(n.id);
      return { id: n.id };
    }
    const kept = n.children.map((child, i) => ({ child: keep(child), size: n.sizes[i] })).filter((k) => k.child);
    return { dir: n.dir, sizes: kept.map((k) => k.size), children: kept.map((k) => k.child!) };
  };
  let tree = splitNormalize(keep(node));
  for (const id of ids) {
    if (seen.has(id)) continue;
    if (!tree) tree = { id };
    else {
      const dir = !isSplitLeaf(tree) && tree.dir === "row" && tree.children.length >= 3 ? "col" : "row";
      const share = isSplitLeaf(tree) || tree.dir !== dir ? 0.5 : 1 / (tree.children.length + 1);
      tree = splitNormalize({ dir, sizes: [1 - share, share], children: [tree, { id }] });
    }
    seen.add(id);
  }
  return tree;
}

/** Drops terminal `dragId` onto terminal `targetId`: beside it on `zone`'s side, or swapped with it. */
function splitDrop(node: SplitNode | null, dragId: string, targetId: string, zone: DropZone): SplitNode | null {
  const leaves = splitLeaves(node);
  if (dragId === targetId || !leaves.includes(dragId) || !leaves.includes(targetId)) return node;
  if (zone === "center") {
    const swap = (n: SplitNode): SplitNode =>
      isSplitLeaf(n) ? { id: n.id === dragId ? targetId : n.id === targetId ? dragId : n.id } : { dir: n.dir, sizes: [...n.sizes], children: n.children.map(swap) };
    return swap(node!);
  }
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  const place = (n: SplitNode): SplitNode => {
    if (isSplitLeaf(n)) {
      if (n.id !== targetId) return { id: n.id };
      return { dir, sizes: [0.5, 0.5], children: before ? [{ id: dragId }, { id: targetId }] : [{ id: targetId }, { id: dragId }] };
    }
    const children: SplitNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((child, i) => {
      // Beside the target in a split of the same direction: it takes half of the target's room there.
      if (n.dir === dir && isSplitLeaf(child) && child.id === targetId) {
        const pair = before ? [dragId, targetId] : [targetId, dragId];
        for (const id of pair) {
          children.push({ id });
          sizes.push(n.sizes[i] / 2);
        }
      } else {
        children.push(place(child));
        sizes.push(n.sizes[i]);
      }
    });
    return { dir: n.dir, sizes, children };
  };
  return splitNormalize(place(splitRemove(node, dragId)!));
}

/** Which drop zone a point is in, from its place inside the target (0..width, 0..height). */
function splitZone(x: number, y: number, width: number, height: number): DropZone {
  const rx = x / width;
  const ry = y / height;
  if (rx > 0.3 && rx < 0.7 && ry > 0.3 && ry < 0.7) return "center";
  const edges: [DropZone, number][] = [["left", rx], ["right", 1 - rx], ["top", ry], ["bottom", 1 - ry]];
  return edges.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}
