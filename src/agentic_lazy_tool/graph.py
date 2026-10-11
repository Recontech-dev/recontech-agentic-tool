"""Draw the memory as a network: projects, their notes, and the topics that link notes together.

The result is one self-contained HTML file (no downloads, nothing sent anywhere)
that the user opens in a browser.
"""

import json
from pathlib import Path

from agentic_lazy_tool import memory


def build(projects: list[dict], current_folder: str, loaded: int) -> dict:
    """Nodes and links for the picture. `loaded` is how many of the current project's
    newest notes are being given to the model in this session."""
    nodes, links = [], []
    for p, project in enumerate(projects):
        is_current = project["folder"] == current_folder
        nodes.append({
            "id": f"p{p}", "kind": "project", "label": project["name"], "open": is_current,
            "text": project["folder"], "detail": f"{len(project['notes'])} notes",
        })
        first_loaded = len(project["notes"]) - loaded if is_current else len(project["notes"])
        for n, note in enumerate(project["notes"]):
            nodes.append({
                "id": f"p{p}n{n}", "kind": "note", "label": memory.keywords(note["text"]), "open": n >= first_loaded,
                "text": note["text"], "detail": f"{project['name']} · {note['time']} · {note['source']}",
            })
            links.append({"source": f"p{p}", "target": f"p{p}n{n}"})
    for word, references in memory.topics(projects):
        nodes.append({
            "id": f"t:{word}", "kind": "topic", "label": word, "open": False,
            "text": word, "detail": f"appears in {len(references)} notes",
        })
        links += [{"source": f"t:{word}", "target": f"p{p}n{n}"} for p, n in references]
    return {"nodes": nodes, "links": links}


def write_html(path: Path, data: dict) -> None:
    # "</" must not appear inside a <script> block, or a note containing "</script>" would end it.
    payload = json.dumps(data).replace("</", "<\\/")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(PAGE.replace("__DATA__", payload), encoding="utf-8")


PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory map</title>
<style>
  :root { --bg:#f6f7f9; --panel:#ffffff; --text:#1c2330; --dim:#6b7686; --line:#c9d0da;
          --project:#2f6fed; --note:#9aa6b6; --open:#16a36a; --topic:#d98a1f; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#12161c; --panel:#1b212a; --text:#e6eaf0; --dim:#8b96a6; --line:#39424f;
            --project:#6ea0ff; --note:#5d6878; --open:#3ad193; --topic:#f0b354; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif;
         display:flex; height:100vh; overflow:hidden; }
  canvas { flex:1; min-width:0; display:block; cursor:grab; }
  aside { width:320px; background:var(--panel); border-left:1px solid var(--line); padding:16px; overflow:auto; }
  h1 { font-size:16px; margin:0 0 4px; }
  .dim { color:var(--dim); }
  .legend { margin:12px 0 16px; padding:0; list-style:none; }
  .legend li { display:flex; align-items:center; gap:8px; margin:4px 0; }
  .dot { width:12px; height:12px; border-radius:50%; flex:none; }
  #detail { border-top:1px solid var(--line); padding-top:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
  #detail b { display:block; margin-bottom:4px; }
  @media (max-width: 700px) { body { flex-direction:column; } aside { width:auto; max-height:40vh;
         border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<canvas id="map"></canvas>
<aside>
  <h1>Memory map</h1>
  <div class="dim" id="summary"></div>
  <ul class="legend">
    <li><span class="dot" style="background:var(--project)"></span>Project</li>
    <li><span class="dot" style="background:var(--project);outline:3px solid var(--open)"></span>Project open now</li>
    <li><span class="dot" style="background:var(--open)"></span>Note given to the model this session</li>
    <li><span class="dot" style="background:var(--note)"></span>Note stored only</li>
    <li><span class="dot" style="background:var(--topic)"></span>Topic shared by several notes</li>
  </ul>
  <div id="detail" class="dim">Point at a circle to read it. Click to keep it selected. Drag to move it.</div>
</aside>
<script>
const data = __DATA__;
const canvas = document.getElementById("map"), ctx = canvas.getContext("2d");
const detail = document.getElementById("detail");
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const byId = new Map(data.nodes.map(node => [node.id, node]));
const links = data.links.map(link => ({ a: byId.get(link.source), b: byId.get(link.target) }));
const neighbours = new Map(data.nodes.map(node => [node, new Set()]));
links.forEach(({ a, b }) => { neighbours.get(a).add(b); neighbours.get(b).add(a); });
const radius = node => node.kind === "project" ? 16 : node.kind === "topic" ? 8 : 5;

const counts = kind => data.nodes.filter(node => node.kind === kind).length;
document.getElementById("summary").textContent =
  counts("project") + " projects, " + counts("note") + " notes, " + counts("topic") + " shared topics";

let width = 0, height = 0, heat = 1, hovered = null, selected = null, dragged = null;
function resize() {
  const scale = window.devicePixelRatio || 1;
  width = canvas.clientWidth; height = canvas.clientHeight;
  canvas.width = width * scale; canvas.height = height * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  heat = Math.max(heat, 0.3);
}
window.addEventListener("resize", resize);
resize();
data.nodes.forEach((node, index) => {
  const angle = index * 2.399963, distance = 20 + 14 * Math.sqrt(index);
  node.x = width / 2 + Math.cos(angle) * distance; node.y = height / 2 + Math.sin(angle) * distance;
  node.vx = 0; node.vy = 0;
});

function step() {
  const nodes = data.nodes;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      const strength = (a.kind === "project" && b.kind === "project") ? 30000 : 5000;
      const d2 = dx * dx + dy * dy + 0.01, force = Math.min(strength / d2, 8), d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx += dx * force; a.vy += dy * force; b.vx -= dx * force; b.vy -= dy * force;
    }
  }
  links.forEach(({ a, b }) => {
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const rest = a.kind === "project" || b.kind === "project" ? 100 : 160, pull = (d - rest) * 0.02;
    a.vx += dx / d * pull; a.vy += dy / d * pull; b.vx -= dx / d * pull; b.vy -= dy / d * pull;
  });
  nodes.forEach(node => {
    node.vx += (width / 2 - node.x) * 0.002; node.vy += (height / 2 - node.y) * 0.002;
    if (node !== dragged) { node.x += node.vx * heat; node.y += node.vy * heat; }
    node.vx *= 0.8; node.vy *= 0.8;
    node.x = Math.max(20, Math.min(width - 20, node.x)); node.y = Math.max(20, Math.min(height - 20, node.y));
  });
  heat = Math.max(heat * 0.995, 0.02);
}

function draw() {
  const focus = selected || hovered, near = focus ? neighbours.get(focus) : null;
  const lit = node => !focus || node === focus || near.has(node);
  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  links.forEach(({ a, b }) => {
    ctx.globalAlpha = !focus ? 0.5 : (a === focus || b === focus) ? 0.9 : 0.08;
    ctx.strokeStyle = css("--line");
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  });
  data.nodes.forEach(node => {
    ctx.globalAlpha = lit(node) ? 1 : 0.15;
    ctx.fillStyle = node.kind === "project" ? css("--project") : node.kind === "topic" ? css("--topic")
                  : node.open ? css("--open") : css("--note");
    ctx.beginPath(); ctx.arc(node.x, node.y, radius(node), 0, Math.PI * 2); ctx.fill();
    if (node.kind === "project" && node.open) {
      ctx.strokeStyle = css("--open"); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius(node) + 4, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
    if (node.kind !== "note" || node === focus) {
      ctx.fillStyle = css("--text");
      ctx.font = (node.kind === "project" ? "600 13px" : "12px") + " system-ui, sans-serif";
      ctx.fillText(node.label, node.x + radius(node) + 5, node.y + 4);
    }
  });
  ctx.globalAlpha = 1;
}

function show(node) {
  detail.textContent = "";
  if (!node) { detail.className = "dim"; detail.textContent = "Point at a circle to read it."; return; }
  detail.className = "";
  const title = document.createElement("b"), meta = document.createElement("div");
  title.textContent = node.kind === "note" ? "Note" : node.kind === "topic" ? "Topic: " + node.label : node.label;
  meta.className = "dim"; meta.textContent = node.detail + (node.open ? " · open now" : "");
  detail.append(title, document.createTextNode(node.text + "\n"), meta);
}

function nodeAt(event) {
  const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
  let best = null, bestDistance = Infinity;
  data.nodes.forEach(node => {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance < radius(node) + 6 && distance < bestDistance) { best = node; bestDistance = distance; }
  });
  return { node: best, x, y };
}
canvas.addEventListener("pointermove", event => {
  const { node, x, y } = nodeAt(event);
  if (dragged) { dragged.x = x; dragged.y = y; heat = Math.max(heat, 0.3); return; }
  hovered = node;
  show(selected || hovered);
});
canvas.addEventListener("pointerdown", event => {
  dragged = nodeAt(event).node;
  if (dragged) canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointerup", event => {
  const { node } = nodeAt(event);
  selected = node && node === selected ? null : node;
  dragged = null;
  show(selected || hovered);
});

(function frame() { step(); draw(); requestAnimationFrame(frame); })();
</script>
</body>
</html>
"""
