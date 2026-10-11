"""The page shown by the window app: terminal on the left, memory graph on the right."""

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agentic Lazy Tool</title>
<style>
  :root { --bg:#12161c; --panel:#1a2029; --text:#dfe4ec; --dim:#8b96a6; --line:#2f3845; --accent:#6ea0ff;
          --project:#6ea0ff; --note:#5d6878; --open:#3ad193; --topic:#f0b354; }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 system-ui, sans-serif;
         display:flex; flex-direction:column; overflow:hidden; }
  header { display:flex; align-items:center; gap:12px; padding:8px 12px; background:var(--panel);
           border-bottom:1px solid var(--line); }
  header strong { white-space:nowrap; }
  #status { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
  button { background:transparent; color:var(--text); border:1px solid var(--line); border-radius:6px;
           padding:5px 10px; font:inherit; cursor:pointer; white-space:nowrap; }
  button:hover { border-color:var(--accent); }
  main { flex:1; display:flex; min-height:0; }
  #term { flex:3; min-width:0; display:flex; flex-direction:column; }
  #scroll { flex:1; overflow:auto; padding:12px; }
  #out, #preview, #input, #secret, #label { font:13px/1.2 Consolas, "Cascadia Mono", Menlo, monospace; }
  #out, #preview { white-space:pre; margin:0; }
  #preview { color:var(--dim); }
  form { display:flex; align-items:flex-start; gap:8px; padding:10px 12px; background:var(--panel);
         border-top:1px solid var(--line); }
  #label { color:var(--accent); padding-top:6px; white-space:pre; }
  #input, #secret { flex:1; min-width:0; background:var(--bg); color:var(--text); border:1px solid var(--line);
                    border-radius:6px; padding:6px 8px; resize:none; outline:none; }
  #input:focus, #secret:focus { border-color:var(--accent); }
  #side { flex:2; min-width:0; display:flex; flex-direction:column; border-left:1px solid var(--line); }
  #side[hidden] { display:none; }
  #map { flex:1; min-height:0; width:100%; display:block; cursor:grab; }
  #legend { display:flex; flex-wrap:wrap; gap:4px 14px; padding:8px 12px; font-size:12px; color:var(--dim);
            border-top:1px solid var(--line); }
  #legend span::before { content:""; display:inline-block; width:9px; height:9px; border-radius:50%;
                         margin-right:5px; background:var(--c); }
  #detail { height:120px; overflow:auto; padding:10px 12px; background:var(--panel);
            border-top:1px solid var(--line); white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; }
  .dim { color:var(--dim); }
  @media (max-width: 760px) { main { flex-direction:column; } #side { border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <strong>Agentic Lazy Tool</strong>
  <span id="status"></span>
  <button id="browse" type="button">Open folder</button>
  <button id="toggle" type="button">Hide memory</button>
</header>
<main>
  <section id="term">
    <div id="scroll"><div id="out"></div><div id="preview"></div></div>
    <form id="entry" autocomplete="off">
      <label id="label" for="input">you&gt;</label>
      <textarea id="input" rows="1" autofocus spellcheck="false"></textarea>
      <input id="secret" type="password" hidden>
    </form>
  </section>
  <section id="side">
    <canvas id="map"></canvas>
    <div id="legend">
      <span style="--c:var(--project)">project</span>
      <span style="--c:var(--open)">loaded for the model now</span>
      <span style="--c:var(--note)">stored note</span>
      <span style="--c:var(--topic)">shared topic</span>
    </div>
    <div id="detail" class="dim">Your memory appears here as you work. Point at a circle to read it.</div>
  </section>
</main>
<script>
const token = new URLSearchParams(location.search).get("t");
const $ = id => document.getElementById(id);
const out = $("out"), preview = $("preview"), scroll = $("scroll"), input = $("input"), secret = $("secret");
const label = $("label"), detail = $("detail"), side = $("side");

function post(route, body) {
  return fetch(route, { method: "POST", headers: { "X-Token": token, "Content-Type": "application/json" },
                        body: JSON.stringify(body || {}) });
}

/* ---- Terminal output: turn the colour codes the program prints into styled text ---- */
const PALETTE = ["#1e222a", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#c8ccd4",
                 "#6b7686", "#ff7b86", "#b5e890", "#ffd68a", "#7cc3ff", "#d99bf0", "#7fd6e0", "#ffffff"];
let style = {}, carry = "";

function colour256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  n -= 16;
  return "rgb(" + [Math.floor(n / 36), Math.floor(n / 6) % 6, n % 6].map(v => v ? 55 + v * 40 : 0).join(",") + ")";
}

function applyCodes(text) {
  const codes = text === "" ? [0] : text.split(";").map(Number);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) style = {};
    else if (c === 1) style.bold = true;
    else if (c === 2) style.dim = true;
    else if (c === 3) style.italic = true;
    else if (c === 4) style.underline = true;
    else if (c === 7) style.reverse = true;
    else if (c === 9) style.strike = true;
    else if (c === 22) { style.bold = false; style.dim = false; }
    else if (c === 23) style.italic = false;
    else if (c === 24) style.underline = false;
    else if (c === 27) style.reverse = false;
    else if (c === 29) style.strike = false;
    else if (c >= 30 && c <= 37) style.fg = PALETTE[c - 30];
    else if (c >= 90 && c <= 97) style.fg = PALETTE[c - 82];
    else if (c === 39) delete style.fg;
    else if (c >= 40 && c <= 47) style.bg = PALETTE[c - 40];
    else if (c >= 100 && c <= 107) style.bg = PALETTE[c - 92];
    else if (c === 49) delete style.bg;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? "fg" : "bg";
      if (codes[i + 1] === 2) { style[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      else if (codes[i + 1] === 5) { style[key] = colour256(codes[i + 2]); i += 2; }
    }
  }
}

function put(text) {
  text = text.replace(/\r/g, "");
  if (!text) return;
  const span = document.createElement("span");
  span.textContent = text;
  let fg = style.fg, bg = style.bg;
  if (style.reverse) { [fg, bg] = [bg || "#12161c", fg || "#dfe4ec"]; }
  if (fg) span.style.color = fg;
  if (bg) span.style.background = bg;
  if (style.bold) span.style.fontWeight = "600";
  if (style.dim) span.style.opacity = "0.6";
  if (style.italic) span.style.fontStyle = "italic";
  if (style.underline || style.strike)
    span.style.textDecoration = [style.underline && "underline", style.strike && "line-through"].filter(Boolean).join(" ");
  out.append(span);
  while (out.childNodes.length > 20000) out.firstChild.remove();
}

function write(text) {
  const pinned = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
  text = carry + text; carry = "";
  // A code can be split between two messages; keep an unfinished one for the next call.
  const cut = text.lastIndexOf("\x1b");
  if (cut !== -1 && !/^\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(\x07|\x1b\\))/.test(text.slice(cut))) {
    carry = text.slice(cut); text = text.slice(0, cut);
  }
  const code = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  let last = 0, match;
  while ((match = code.exec(text))) {
    put(text.slice(last, match.index));
    if (match[2] === "m") applyCodes(match[1]);
    last = code.lastIndex;
  }
  put(text.slice(last));
  if (pinned) scroll.scrollTop = scroll.scrollHeight;
}

function echo(text, colour) {
  const saved = style; style = { fg: colour }; put(text); style = saved;
  scroll.scrollTop = scroll.scrollHeight;
}

/* ---- Input ---- */
let commands = [], asking = null, history = [], historyAt = 0;

function setAsking(request) {
  asking = request;
  label.textContent = request ? request.label : "you>";
  const hide = !!(request && request.secret);
  input.hidden = hide; secret.hidden = !hide;
  input.value = request && !request.secret ? request.default : "";
  secret.value = "";
  (hide ? secret : input).focus();
}

function submit() {
  const field = asking && asking.secret ? secret : input;
  const text = field.value;
  field.value = ""; input.style.height = "";
  if (asking) {
    echo(asking.label + (asking.secret ? "*".repeat(Math.min(text.length, 12)) : text) + "\n", "#8b96a6");
    post("/answer", { text });
    setAsking(null);
    return;
  }
  if (!text.trim()) return;
  history.push(text); historyAt = history.length;
  echo("you> " + text + "\n", "#6ea0ff");
  post("/input", { text });
}

function complete() {
  const typed = input.value;
  if (!typed.startsWith("/") || typed.includes(" ")) return;
  const matches = commands.filter(command => command.startsWith(typed));
  if (matches.length === 1) input.value = matches[0] + " ";
  else if (matches.length > 1) echo(matches.join("  ") + "\n", "#8b96a6");
}

input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); }
  else if (event.key === "Tab") { event.preventDefault(); complete(); }
  else if (event.key === "Escape") post("/cancel");
  else if (event.key === "ArrowUp" && !input.value.includes("\n") && historyAt > 0) {
    event.preventDefault(); input.value = history[--historyAt];
  } else if (event.key === "ArrowDown" && !input.value.includes("\n") && historyAt < history.length) {
    event.preventDefault(); input.value = history[++historyAt] || "";
  }
});
input.addEventListener("input", () => { input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
secret.addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); submit(); }
  else if (event.key === "Escape") { post("/cancel"); setAsking(null); }
});
$("entry").addEventListener("submit", event => event.preventDefault());
$("browse").addEventListener("click", () => { echo("you> /browse\n", "#6ea0ff"); post("/input", { text: "/browse" }); });
$("toggle").addEventListener("click", () => {
  side.hidden = !side.hidden;
  $("toggle").textContent = side.hidden ? "Show memory" : "Hide memory";
  reportSize(); resizeMap();
});

function reportSize() {
  const probe = document.createElement("span");
  probe.style.cssText = "font:13px/1.2 Consolas, 'Cascadia Mono', Menlo, monospace; visibility:hidden; position:absolute;";
  probe.textContent = "M".repeat(50);
  document.body.append(probe);
  const columns = Math.floor((scroll.clientWidth - 24) / (probe.getBoundingClientRect().width / 50)) - 2;
  probe.remove();
  post("/size", { columns });
}
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(reportSize, 200); resizeMap(); });

/* ---- Memory graph ---- */
const canvas = $("map"), ctx = canvas.getContext("2d");
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let nodes = [], links = [], neighbours = new Map();
let width = 0, height = 0, heat = 1, hovered = null, selected = null, dragged = null;
const radius = node => node.kind === "project" ? 15 : node.kind === "topic" ? 8 : 5;

function resizeMap() {
  const scale = window.devicePixelRatio || 1;
  width = canvas.clientWidth; height = canvas.clientHeight;
  canvas.width = width * scale; canvas.height = height * scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  heat = Math.max(heat, 0.3);
}

function updateGraph(data) {
  const old = new Map(nodes.map(node => [node.id, node]));
  nodes = data.nodes.map((node, index) => {
    const before = old.get(node.id);
    if (before) return Object.assign(before, node);
    const angle = index * 2.399963, distance = 20 + 14 * Math.sqrt(index);
    return Object.assign(node, { x: width / 2 + Math.cos(angle) * distance, y: height / 2 + Math.sin(angle) * distance, vx: 0, vy: 0 });
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  links = data.links.map(link => ({ a: byId.get(link.source), b: byId.get(link.target) })).filter(link => link.a && link.b);
  neighbours = new Map(nodes.map(node => [node, new Set()]));
  links.forEach(({ a, b }) => { neighbours.get(a).add(b); neighbours.get(b).add(a); });
  if (selected && !byId.has(selected.id)) selected = null;
  if (hovered && !byId.has(hovered.id)) hovered = null;
  if (nodes.length !== old.size) heat = 1;
  if (!nodes.length) { detail.className = "dim"; detail.textContent = "Nothing remembered yet. Notes are saved when a conversation ends, or with /remember."; }
}

function step() {
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
    const rest = a.kind === "project" || b.kind === "project" ? 90 : 140, pull = (d - rest) * 0.02;
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
    ctx.globalAlpha = !focus ? 0.7 : (a === focus || b === focus) ? 1 : 0.1;
    ctx.strokeStyle = css("--line");
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  });
  const crowded = nodes.length > 80;
  nodes.forEach(node => {
    ctx.globalAlpha = lit(node) ? 1 : 0.15;
    ctx.fillStyle = node.kind === "project" ? css("--project") : node.kind === "topic" ? css("--topic")
                  : node.open ? css("--open") : css("--note");
    ctx.beginPath(); ctx.arc(node.x, node.y, radius(node), 0, Math.PI * 2); ctx.fill();
    if (node.kind === "project" && node.open) {
      ctx.strokeStyle = css("--open"); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius(node) + 4, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 1;
    }
    // Every circle carries a word or two; in a crowded picture stored notes only show theirs when in focus.
    if (!crowded || node.kind !== "note" || node.open || (focus && lit(node))) {
      ctx.fillStyle = node.kind === "note" && !node.open ? css("--dim") : css("--text");
      ctx.font = (node.kind === "project" ? "600 13px" : "12px") + " system-ui, sans-serif";
      ctx.fillText(node.label, node.x + radius(node) + 5, node.y + 4);
    }
  });
  ctx.globalAlpha = 1;
}

function show(node) {
  detail.textContent = "";
  if (!node) { detail.className = "dim"; detail.textContent = "Point at a circle to read it. Click to keep it selected. Drag to move it."; return; }
  detail.className = "";
  const title = document.createElement("b"), meta = document.createElement("div");
  title.textContent = (node.kind === "note" ? "Note" : node.kind === "topic" ? "Topic: " + node.label : node.label) + "\n";
  meta.className = "dim"; meta.textContent = node.detail + (node.open ? " · loaded now" : "");
  detail.append(title, document.createTextNode(node.text + "\n"), meta);
}

function nodeAt(event) {
  const box = canvas.getBoundingClientRect(), x = event.clientX - box.left, y = event.clientY - box.top;
  let best = null, bestDistance = Infinity;
  nodes.forEach(node => {
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

/* ---- Messages from the program ---- */
function receive(event) {
  if (event.type === "out") { preview.textContent = ""; write(event.text); }
  else if (event.type === "preview") {
    preview.textContent = event.text.split("\n").slice(-30).join("\n");
    scroll.scrollTop = scroll.scrollHeight;
  }
  else if (event.type === "reset") { out.textContent = ""; style = {}; carry = ""; setAsking(null); write(event.text); }
  else if (event.type === "ask") setAsking(event);
  else if (event.type === "state") { $("status").textContent = event.status; commands = event.commands; updateGraph(event.graph); }
  else if (event.type === "bye") { echo("\nClosed. You can close this window.\n", "#8b96a6"); source.close(); window.close(); }
}

resizeMap();
reportSize();
const source = new EventSource("/events?t=" + encodeURIComponent(token));
source.onmessage = message => receive(JSON.parse(message.data));
(function frame() { step(); draw(); requestAnimationFrame(frame); })();
</script>
</body>
</html>
"""
