// The window: one terminal per profile, and the brain graph on the right.
// This file runs in the page, so it uses only browser APIs and window.api from the preload script.

interface Profile { id: string; name: string; color: string; configDir: string | null; kind?: "claude" | "ollama"; model?: string }
interface Workspace { folder: string; profiles: Profile[]; layout: "grid" | "tabs" }
interface GraphNode { id: string; kind: string; label: string; text: string; detail: string; open: boolean;
  color?: string; resume?: { profile: string; id: string; folder: string }; x: number; y: number; vx: number; vy: number }
interface Match { kind: string; project: string; folder: string; text: string; when: string }

declare const Terminal: any;
declare const FitAddon: any;
declare const api: {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (...args: any[]) => void): void;
};

const $ = (id: string) => document.getElementById(id)!;
let workspace: Workspace;
let active = "";
let isOnline = true;
const terms = new Map<string, { term: any; fit: any; panel: HTMLElement }>();

/* ---------- Terminals ---------- */

function makePanel(profile: Profile): void {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.id = profile.id;
  const bar = document.createElement("div");
  bar.className = "bar";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.style.background = profile.color;
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = profile.name;
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = profile.kind === "ollama" ? `offline · ${profile.model}` : profile.configDir ? "own sign-in" : "your normal Claude Code sign-in";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const restart = document.createElement("button");
  restart.className = "icon";
  restart.title = "Restart this terminal";
  restart.textContent = "↻";
  restart.onclick = () => start(profile.id);
  bar.append(dot, name, hint, spacer, restart);
  if (workspace.profiles.length > 1) {
    const remove = document.createElement("button");
    remove.className = "icon";
    remove.title = "Remove this profile from the workspace";
    remove.textContent = "✕";
    remove.onclick = async () => {
      if (!confirm(`Remove ${profile.name}? Its terminal closes. Its sign-in and past sessions stay on disk.`)) return;
      const answer = await api.invoke("profile:remove", profile.id);
      if (answer.error) return alert(answer.error);
      workspace = answer;
      render();
    };
    bar.append(remove);
  }
  const body = document.createElement("div");
  body.className = "term";
  panel.append(bar, body);
  $("panels").append(panel);

  const term = new Terminal({ cursorBlink: true, fontFamily: "Consolas, 'Cascadia Mono', Menlo, monospace", fontSize: 13,
    theme: { background: "#000000" }, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);
  term.onData((data: string) => api.send("term:input", profile.id, data));
  term.onResize(({ cols, rows }: { cols: number; rows: number }) => api.send("term:resize", profile.id, cols, rows));
  panel.addEventListener("mousedown", () => select(profile.id));
  terms.set(profile.id, { term, fit, panel });
}

function start(id: string): void {
  const entry = terms.get(id);
  if (!entry) return;
  entry.term.reset();
  fitAll();
  api.send("term:start", id, entry.term.cols, entry.term.rows);
}

function fitAll(): void {
  for (const { fit, panel } of terms.values()) if (panel.offsetParent) fit.fit();
}

function select(id: string): void {
  active = id;
  for (const [key, { panel }] of terms) panel.classList.toggle("active", key === id);
  for (const tab of $("tabs").children) (tab as HTMLElement).classList.toggle("active", (tab as HTMLElement).dataset.id === id);
  requestAnimationFrame(() => {
    fitAll();
    terms.get(id)?.term.focus();
  });
}

function render(): void {
  for (const { term } of terms.values()) term.dispose();
  terms.clear();
  $("panels").textContent = "";
  $("tabs").textContent = "";
  const count = workspace.profiles.length;
  $("panels").style.setProperty("--cols", String(count <= 3 ? count : Math.ceil(count / 2)));
  $("work").classList.toggle("tabs", workspace.layout === "tabs");
  $("layout").textContent = workspace.layout === "tabs" ? "Grid" : "Tabs";
  $("folder").textContent = workspace.folder || "Choose project folder";
  for (const profile of workspace.profiles) {
    makePanel(profile);
    const tab = document.createElement("button");
    tab.dataset.id = profile.id;
    tab.textContent = profile.name;
    tab.style.borderTop = `2px solid ${profile.color}`;
    tab.onclick = () => select(profile.id);
    $("tabs").append(tab);
  }
  select(workspace.profiles.some((p) => p.id === active) ? active : workspace.profiles[0].id);
  requestAnimationFrame(() => workspace.profiles.forEach((p) => start(p.id)));
}

api.on("term:data", (id: string, data: string) => terms.get(id)?.term.write(data));
function showNetwork(): void {
  $("net").hidden = isOnline;
  for (const profile of workspace?.profiles ?? []) {
    const hint = terms.get(profile.id)?.panel.querySelector(".hint");
    if (!hint || profile.kind === "ollama") continue;
    hint.classList.toggle("warn", !isOnline);
    hint.textContent = (profile.configDir ? "own sign-in" : "your normal Claude Code sign-in") + (isOnline ? "" : " · needs internet");
  }
}
api.on("net:status", (online: boolean) => {
  isOnline = online;
  showNetwork();
});

api.on("term:exit", (id: string) => terms.get(id)?.term.write("\r\n\x1b[90m[The terminal closed. Press ↻ to start it again.]\x1b[0m\r\n"));

$("folder").onclick = async () => {
  const before = workspace.folder;
  workspace = await api.invoke("workspace:choose-folder");
  if (workspace.folder !== before) render();
};
$("layout").onclick = async () => {
  workspace = await api.invoke("workspace:layout", workspace.layout === "tabs" ? "grid" : "tabs");
  $("work").classList.toggle("tabs", workspace.layout === "tabs");
  $("layout").textContent = workspace.layout === "tabs" ? "Grid" : "Tabs";
  select(active);
};
$("toggle").onclick = () => {
  const brain = $("brain");
  brain.hidden = !brain.hidden;
  $("toggle").textContent = brain.hidden ? "Show brain" : "Hide brain";
  requestAnimationFrame(() => { fitAll(); resizeMap(); });
};
const chosenKind = () => (document.querySelector('input[name="kind"]:checked') as HTMLInputElement).value;
function showKind(): void {
  $("claudeOptions").hidden = chosenKind() !== "claude";
  $("ollamaOptions").hidden = chosenKind() !== "ollama";
}
document.querySelectorAll('input[name="kind"]').forEach((radio) => radio.addEventListener("change", showKind));

$("add").onclick = async () => {
  ($("profileName") as HTMLInputElement).value = "";
  $("error").textContent = "";
  const options: { ollama: string[] | null; folders: string[] } = await api.invoke("profile:options");
  const existing = $("existing") as HTMLSelectElement;
  existing.length = 1;
  for (const folder of options.folders) existing.add(new Option(`Use the sign-in already in ${folder}`, folder));
  const model = $("model") as HTMLSelectElement;
  model.length = 0;
  for (const name of options.ollama ?? []) model.add(new Option(name, name));
  $("ollamaHint").textContent =
    options.ollama === null ? "Ollama is not running. Start the Ollama app, then open this again."
    : !options.ollama.length ? "No model downloaded yet. While online, run for example:  ollama pull qwen3:8b"
    : "Claude Code needs a model that can use tools, such as qwen3 or qwen3-coder.";
  (document.querySelector('input[name="kind"][value="claude"]') as HTMLInputElement).checked = true;
  showKind();
  $("dialog").hidden = false;
  $("profileName").focus();
};
$("cancel").onclick = () => ($("dialog").hidden = true);
$("profileForm").onsubmit = async (event) => {
  event.preventDefault();
  const kind = chosenKind();
  const answer = await api.invoke("profile:add", {
    name: ($("profileName") as HTMLInputElement).value,
    kind,
    model: kind === "ollama" ? ($("model") as HTMLSelectElement).value : undefined,
    configDir: kind === "claude" ? ($("existing") as HTMLSelectElement).value || undefined : undefined,
  });
  if (answer.error) {
    $("error").textContent = answer.error;
    return;
  }
  $("dialog").hidden = true;
  workspace = await api.invoke("workspace:get");
  active = answer.id;
  render();
};
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { fitAll(); resizeMap(); }, 120);
});

/* ---------- Brain search ---------- */

let searchTimer = 0;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const query = ($("search") as HTMLInputElement).value.trim();
    const results = $("results");
    results.textContent = "";
    if (!query) return;
    const matches: Match[] = await api.invoke("brain:search", query);
    if (!matches.length) {
      results.innerHTML = '<div class="result dim">Nothing matches.</div>';
      return;
    }
    for (const match of matches) {
      const item = document.createElement("div");
      item.className = "result";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${match.kind} · ${match.project} · ${match.when}`;
      const text = document.createElement("div");
      text.textContent = match.text;
      item.append(meta, text);
      results.append(item);
    }
  }, 200);
});

/* ---------- Brain graph ---------- */
// Nodes live in "world" coordinates around (0, 0). A camera maps the world onto the canvas and,
// unless the user has zoomed or panned, keeps adjusting itself so the whole network fits.

const canvas = $("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let nodes: GraphNode[] = [];
let links: { a: GraphNode; b: GraphNode }[] = [];
let neighbours = new Map<GraphNode, Set<GraphNode>>();
let width = 0, height = 0, heat = 1;
let hovered: GraphNode | null = null, selected: GraphNode | null = null, dragged: GraphNode | null = null;
const camera = { x: 0, y: 0, scale: 1, manual: false };
let panning: { x: number; y: number } | null = null;
let moved = false;
const labelWidths = new Map<string, number>();
const MARGIN = 36;
const MAX_SCALE = 1.4;
const MIN_SCALE = 0.15;

const radius = (n: GraphNode) => (n.kind === "project" ? 14 : n.kind === "topic" ? 7 : n.kind === "session" ? 6 : 5);
const colour = (n: GraphNode) =>
  n.kind === "project" ? css("--project") : n.kind === "topic" ? css("--topic") : n.open ? css("--open")
  : n.kind === "session" ? n.color || css("--session") : css("--note");
const fontSize = (n: GraphNode) => (n.kind === "project" ? 12 : 11);
const font = (n: GraphNode, size = fontSize(n)) => `${n.kind === "project" ? "600 " : ""}${size}px system-ui, sans-serif`;

function labelWidth(n: GraphNode): number {
  const key = n.kind + "\u0000" + n.label;
  if (!labelWidths.has(key)) {
    ctx.font = font(n);
    labelWidths.set(key, ctx.measureText(n.label).width);
  }
  return labelWidths.get(key)!;
}

/** The space a node and its label take up, in world units: [left, top, right, bottom]. */
function box(n: GraphNode): [number, number, number, number] {
  const r = radius(n), half = Math.max(r, 8);
  return [n.x - r - 3, n.y - half - 3, n.x + r + 6 + labelWidth(n) + 3, n.y + half + 3];
}

const toScreen = (x: number, y: number) => [(x - camera.x) * camera.scale + width / 2, (y - camera.y) * camera.scale + height / 2];
const toWorld = (sx: number, sy: number) => [(sx - width / 2) / camera.scale + camera.x, (sy - height / 2) / camera.scale + camera.y];

function resizeMap(): void {
  const scale = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = width * scale;
  canvas.height = height * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  heat = Math.max(heat, 0.3);
}

function updateGraph(data: { nodes: GraphNode[]; links: { source: string; target: string }[] }): void {
  const old = new Map(nodes.map((n) => [n.id, n]));
  nodes = data.nodes.map((node, i) => {
    const before = old.get(node.id);
    if (before) return Object.assign(before, node, { x: before.x, y: before.y, vx: before.vx, vy: before.vy });
    // New nodes start next to something they are linked to, so the picture does not jump.
    const link = data.links.find((l) => l.target === node.id && old.has(l.source)) ?? data.links.find((l) => l.source === node.id && old.has(l.target));
    const anchor = link ? old.get(link.source === node.id ? link.target : link.source)! : null;
    const angle = i * 2.399963, distance = anchor ? 40 : 20 + 14 * Math.sqrt(i);
    return { ...node, x: (anchor?.x ?? 0) + Math.cos(angle) * distance, y: (anchor?.y ?? 0) + Math.sin(angle) * distance, vx: 0, vy: 0 };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  links = data.links.flatMap((l) => (byId.has(l.source) && byId.has(l.target) ? [{ a: byId.get(l.source)!, b: byId.get(l.target)! }] : []));
  neighbours = new Map(nodes.map((n) => [n, new Set<GraphNode>()]));
  for (const { a, b } of links) {
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }
  if (selected && !byId.has(selected.id)) selected = null;
  if (hovered && !byId.has(hovered.id)) hovered = null;
  if (nodes.length !== old.size) heat = 1;
}

function step(): void {
  const count = nodes.length;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      const strength = a.kind === "project" && b.kind === "project" ? 30000 : 5000;
      const d2 = dx * dx + dy * dy + 0.01, force = Math.min(strength / d2, 8), d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;

    }
  }
  for (const { a, b } of links) {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const rest = a.kind === "project" || b.kind === "project" ? 90 : 140, pull = (d - rest) * 0.02;
    a.vx += (dx / d) * pull; a.vy += (dy / d) * pull; b.vx -= (dx / d) * pull; b.vy -= (dy / d) * pull;
  }
  for (const n of nodes) {
    n.vx -= n.x * 0.002;
    n.vy -= n.y * 0.002;
    if (n !== dragged) { n.x += n.vx * heat; n.y += n.vy * heat; }
    n.vx *= 0.8; n.vy *= 0.8;
  }
  for (let pass = 0; pass < 4; pass++) separate();
  heat = Math.max(heat * 0.995, 0.02);
  fitCamera();
}

/** No overlaps: where two nodes' boxes (circle plus label) touch, move them apart along the shorter way out. */
function separate(): void {
  const boxes = nodes.map(box);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlapX = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const overlapY = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const first = nodes[i], second = nodes[j];
      // A node being dragged stays under the mouse; the other one moves the whole way.
      const shareFirst = first === dragged ? 0 : second === dragged ? 1 : 0.5;
      let dx = 0, dy = 0;
      if (overlapY < overlapX) dy = (overlapY + 1) * (a[1] + a[3] < b[1] + b[3] ? -1 : 1);
      else dx = (overlapX + 1) * (a[0] + a[2] < b[0] + b[2] ? -1 : 1);
      first.x += dx * shareFirst; first.y += dy * shareFirst;
      second.x -= dx * (1 - shareFirst); second.y -= dy * (1 - shareFirst);
      boxes[i] = box(first);
      boxes[j] = box(second);
    }
  }
}

/** Move the camera a little towards the view that shows every node and label. */
function fitCamera(): void {
  if (camera.manual || !nodes.length || !width || !height) return;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const n of nodes) {
    const [l, t, r, b] = box(n);
    left = Math.min(left, l); top = Math.min(top, t); right = Math.max(right, r); bottom = Math.max(bottom, b);
  }
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (width - 2 * MARGIN) / (right - left), (height - 2 * MARGIN) / (bottom - top)));
  camera.x += ((left + right) / 2 - camera.x) * 0.2;
  camera.y += ((top + bottom) / 2 - camera.y) * 0.2;
  camera.scale += (scale - camera.scale) * 0.2;
}

function draw(): void {
  const focus = selected || hovered, near = focus ? neighbours.get(focus)! : null;
  const lit = (n: GraphNode) => !focus || n === focus || near!.has(n);
  // Circles and text grow and shrink with the camera, so the gaps kept between them stay visible on screen.
  const k = Math.min(camera.scale, 1.2);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = css("--line");
  for (const { a, b } of links) {
    const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
    ctx.globalAlpha = !focus ? 0.7 : a === focus || b === focus ? 1 : 0.1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  for (const n of nodes) {
    const [x, y] = toScreen(n.x, n.y), r = Math.max(radius(n) * k, 2);
    ctx.globalAlpha = lit(n) ? 1 : 0.15;
    ctx.fillStyle = colour(n);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    if (n.kind === "project" && n.open) {
      ctx.strokeStyle = css("--open"); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = css("--line");
    }
    // Text too small to read is left out, except for projects and whatever is in focus.
    const textSize = fontSize(n) * k;
    const important = n.kind === "project" || n === focus || (focus && lit(n));
    if (textSize >= 7 || important) {
      ctx.fillStyle = n.kind === "project" || n.kind === "topic" || n.open ? css("--text") : css("--dim");
      ctx.font = font(n, Math.max(textSize, important ? 10 : 0));
      ctx.fillText(n.label, x + r + 4 * k, y + textSize / 3);
    }
  }
  ctx.globalAlpha = 1;
}

function show(n: GraphNode | null): void {
  const detail = $("detail");
  detail.textContent = "";
  if (!n) {
    detail.className = "dim";
    detail.textContent = nodes.length
      ? "Point at a circle to read it, click to keep it selected, drag to move it. Scroll to zoom, drag the background to pan, double-click to fit everything again."
      : "Nothing yet. Past Claude Code sessions appear here once they are found, and notes when Claude saves them.";
    return;
  }
  detail.className = "";
  const title = document.createElement("b");
  title.textContent = n.kind === "topic" ? `Topic: ${n.label}\n` : n.kind === "project" ? `${n.label}\n` : "";
  const meta = document.createElement("div");
  meta.className = "dim";
  meta.textContent = n.detail + (n.open ? " · open now" : "");
  detail.append(title, document.createTextNode(n.text + "\n"), meta);
  if (n.resume) {
    const ref = n.resume;
    const button = document.createElement("button");
    button.id = "resume";
    button.textContent = `Resume in ${ref.profile}`;
    button.onclick = async () => {
      const answer = await api.invoke("session:resume", ref);
      if (answer.error) return alert(answer.error);
      select(answer.id);
    };
    detail.append(button);
  }
}

function pointer(event: PointerEvent | WheelEvent | MouseEvent) {
  const rect = canvas.getBoundingClientRect(), sx = event.clientX - rect.left, sy = event.clientY - rect.top;
  const k = Math.min(camera.scale, 1.2);
  let best: GraphNode | null = null, bestDistance = Infinity;
  for (const n of nodes) {
    const [x, y] = toScreen(n.x, n.y);
    const distance = Math.hypot(x - sx, y - sy);
    if (distance < Math.max(radius(n) * k, 2) + 6 && distance < bestDistance) { best = n; bestDistance = distance; }
  }
  return { node: best, sx, sy };
}
canvas.addEventListener("pointermove", (event) => {
  const { node, sx, sy } = pointer(event);
  if (dragged) {
    [dragged.x, dragged.y] = toWorld(sx, sy);
    moved = true;
    heat = Math.max(heat, 0.3);
    return;
  }
  if (panning) {
    camera.x -= (sx - panning.x) / camera.scale;
    camera.y -= (sy - panning.y) / camera.scale;
    panning = { x: sx, y: sy };
    camera.manual = moved = true;
    return;
  }
  hovered = node;
  show(selected || hovered);
});
canvas.addEventListener("pointerdown", (event) => {
  const { node, sx, sy } = pointer(event);
  moved = false;
  canvas.setPointerCapture(event.pointerId);
  if (node) dragged = node;
  else panning = { x: sx, y: sy };
});
canvas.addEventListener("pointerup", (event) => {
  const { node } = pointer(event);
  if (!moved) selected = node && node === selected ? null : node;
  dragged = null;
  panning = null;
  show(selected || hovered);
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const { sx, sy } = pointer(event);
  const [wx, wy] = toWorld(sx, sy);
  camera.scale = Math.max(MIN_SCALE, Math.min(4, camera.scale * Math.exp(-event.deltaY * 0.0015)));
  // Zoom around the mouse: the point under it stays under it.
  camera.x = wx - (sx - width / 2) / camera.scale;
  camera.y = wy - (sy - height / 2) / camera.scale;
  camera.manual = true;
}, { passive: false });
canvas.addEventListener("dblclick", () => {
  camera.manual = false;
  heat = Math.max(heat, 0.3);
});
api.on("brain:graph", (data) => { updateGraph(data); show(selected || hovered); });


/* ---------- Start ---------- */

(async () => {
  workspace = await api.invoke("workspace:get");
  resizeMap();
  render();
  showNetwork();
  const frame = () => { step(); draw(); requestAnimationFrame(frame); };
  frame();
})();
