// The window: one terminal per profile, and the brain graph on the right.
// This file runs in the page, so it uses only browser APIs and window.api from the preload script.

interface Profile { id: string; name: string; color: string; configDir: string | null }
interface Workspace { folder: string; profiles: Profile[]; layout: "grid" | "tabs" }
interface GraphNode { id: string; kind: string; label: string; text: string; detail: string; open: boolean;
  x: number; y: number; vx: number; vy: number }
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
  hint.textContent = profile.configDir ? "own sign-in" : "your normal Claude Code sign-in";
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
$("add").onclick = () => {
  ($("profileName") as HTMLInputElement).value = "";
  $("error").textContent = "";
  $("dialog").hidden = false;
  $("profileName").focus();
};
$("cancel").onclick = () => ($("dialog").hidden = true);
$("profileForm").onsubmit = async (event) => {
  event.preventDefault();
  const answer = await api.invoke("profile:add", ($("profileName") as HTMLInputElement).value);
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

const canvas = $("map") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let nodes: GraphNode[] = [];
let links: { a: GraphNode; b: GraphNode }[] = [];
let neighbours = new Map<GraphNode, Set<GraphNode>>();
let width = 0, height = 0, heat = 1;
let hovered: GraphNode | null = null, selected: GraphNode | null = null, dragged: GraphNode | null = null;
const radius = (n: GraphNode) => (n.kind === "project" ? 14 : n.kind === "topic" ? 7 : n.kind === "session" ? 6 : 5);
const colour = (n: GraphNode) =>
  n.kind === "project" ? css("--project") : n.kind === "topic" ? css("--topic") : n.open ? css("--open") : n.kind === "session" ? css("--session") : css("--note");

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
    const angle = i * 2.399963, distance = 20 + 12 * Math.sqrt(i);
    return { ...node, x: width / 2 + Math.cos(angle) * distance, y: height / 2 + Math.sin(angle) * distance, vx: 0, vy: 0 };
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
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      const strength = a.kind === "project" && b.kind === "project" ? 30000 : 4000;
      const d2 = dx * dx + dy * dy + 0.01, force = Math.min(strength / d2, 8), d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
    }
  }
  for (const { a, b } of links) {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const rest = a.kind === "project" || b.kind === "project" ? 80 : 130, pull = (d - rest) * 0.02;
    a.vx += (dx / d) * pull; a.vy += (dy / d) * pull; b.vx -= (dx / d) * pull; b.vy -= (dy / d) * pull;
  }
  for (const n of nodes) {
    n.vx += (width / 2 - n.x) * 0.002;
    n.vy += (height / 2 - n.y) * 0.002;
    if (n !== dragged) { n.x += n.vx * heat; n.y += n.vy * heat; }
    n.vx *= 0.8; n.vy *= 0.8;
    n.x = Math.max(16, Math.min(width - 16, n.x));
    n.y = Math.max(16, Math.min(height - 16, n.y));
  }
  heat = Math.max(heat * 0.995, 0.02);
}

function draw(): void {
  const focus = selected || hovered, near = focus ? neighbours.get(focus)! : null;
  const lit = (n: GraphNode) => !focus || n === focus || near!.has(n);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = css("--line");
  for (const { a, b } of links) {
    ctx.globalAlpha = !focus ? 0.7 : a === focus || b === focus ? 1 : 0.1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const crowded = nodes.length > 90;
  for (const n of nodes) {
    ctx.globalAlpha = lit(n) ? 1 : 0.15;
    ctx.fillStyle = colour(n);
    ctx.beginPath(); ctx.arc(n.x, n.y, radius(n), 0, Math.PI * 2); ctx.fill();
    if (n.kind === "project" && n.open) {
      ctx.strokeStyle = css("--open"); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(n.x, n.y, radius(n) + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1; ctx.strokeStyle = css("--line");
    }
    if (!crowded || n.kind === "project" || n.kind === "topic" || n.open || (focus && lit(n))) {
      ctx.fillStyle = n.kind === "project" || n.kind === "topic" || n.open ? css("--text") : css("--dim");
      ctx.font = (n.kind === "project" ? "600 12px" : "11px") + " system-ui, sans-serif";
      ctx.fillText(n.label, n.x + radius(n) + 4, n.y + 4);
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
      ? "Point at a circle to read it. Click to keep it selected. Drag to move it."
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
}

function nodeAt(event: PointerEvent) {
  const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
  let best: GraphNode | null = null, bestDistance = Infinity;
  for (const n of nodes) {
    const distance = Math.hypot(n.x - x, n.y - y);
    if (distance < radius(n) + 6 && distance < bestDistance) { best = n; bestDistance = distance; }
  }
  return { node: best, x, y };
}
canvas.addEventListener("pointermove", (event) => {
  const { node, x, y } = nodeAt(event);
  if (dragged) { dragged.x = x; dragged.y = y; heat = Math.max(heat, 0.3); return; }
  hovered = node;
  show(selected || hovered);
});
canvas.addEventListener("pointerdown", (event) => {
  dragged = nodeAt(event).node;
  if (dragged) canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointerup", (event) => {
  const { node } = nodeAt(event);
  selected = node && node === selected ? null : node;
  dragged = null;
  show(selected || hovered);
});
api.on("brain:graph", (data) => { updateGraph(data); show(selected || hovered); });

/* ---------- Start ---------- */

(async () => {
  workspace = await api.invoke("workspace:get");
  resizeMap();
  render();
  const frame = () => { step(); draw(); requestAnimationFrame(frame); };
  frame();
})();
