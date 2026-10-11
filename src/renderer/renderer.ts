// The window: one terminal per profile, and the brain graph on the right.
// This file runs in the page, so it uses only browser APIs and window.api from the preload script.

interface Profile { id: string; name: string; color: string; configDir: string | null; kind?: "claude" | "ollama" | "free"; model?: string }
interface Workspace { folder: string; profiles: Profile[]; layout: "grid" | "tabs" }
interface GraphNode { id: string; kind: string; label: string; text: string; detail: string; open: boolean;
  color?: string; resume?: { profile: string; id: string; folder: string }; tag?: string; unfinished?: boolean;
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
let isOnline = true;
let accounts: Record<string, string> = {};
let freeContained = true;
const terms = new Map<string, { term: any; fit: any; panel: HTMLElement }>();
/** Profiles whose terminal has been started. A running terminal is never restarted unless the user asks. */
const started = new Set<string>();

/* ---------- Terminals ---------- */

// Layout work is done shortly after a change, with a timer. Screen frames are not used for this,
// because they stop while the window is hidden or covered and a terminal would then never start.
const soon = (work: () => void) => setTimeout(work, 30);

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
  hint.textContent = profile.kind === "ollama" ? `offline · ${profile.model}` : profile.kind === "free" ? "free AI providers" : profile.configDir ? "own sign-in" : "your normal Claude Code sign-in";
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const restart = document.createElement("button");
  restart.className = "icon";
  restart.title = "Restart this terminal";
  restart.textContent = "↻";
  restart.onclick = () => start(profile.id);
  const remove = document.createElement("button");
  remove.className = "icon remove";
  remove.title = "Remove this profile from the workspace";
  remove.textContent = "✕";
  remove.onclick = async () => {
    if (!confirm(`Remove ${profile.name}? Its terminal closes. Its sign-in and past sessions stay on disk.`)) return;
    const answer = await api.invoke("profile:remove", profile.id);
    if (answer.error) return alert(answer.error);
    workspace = answer;
    render();
  };
  bar.append(dot, name, hint, spacer, restart, remove);
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
  if (profile.kind === "free") {
    // The free terminal waits until the user asks for it, typically after a Claude limit is hit.
    const cover = document.createElement("div");
    cover.className = "cover";
    const title = document.createElement("b");
    title.textContent = "Free models terminal";
    const text = document.createElement("div");
    text.textContent = "Claude Code on your free AI providers. Start it when a Claude profile reaches its limit, then give it what to work on.";
    const go = document.createElement("button");
    go.textContent = "Start the free terminal";
    go.onclick = () => startFree();
    cover.append(title, text, go);
    body.append(cover);
  }
}

/**
 * The text on a terminal's screen, last `lines` lines. The app calls this when another terminal's
 * Claude Code asks to read this one.
 */
function terminalText(id: string, lines: number): string {
  const entry = terms.get(id);
  if (!entry) return "";
  const buffer = entry.term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < buffer.length; i++) rows.push(buffer.getLine(i)?.translateToString(true) ?? "");
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  return rows.slice(-lines).join("\n");
}
(window as any).terminalText = terminalText;

/** Start the free terminal (once) and bring it to the front. */
function startFree(): void {
  const profile = workspace.profiles.find((p) => p.kind === "free");
  if (!profile) return void openFreeDialog();
  const warning = freeContained
    ? "Start the free terminal?\n\nIt runs in a container: its own empty folder, with no access to your project files, memory or other terminals. Only what you type or paste into it, and messages other terminals send it, go to the free provider that answers."
    : "Start the free terminal WITHOUT the container?\n\nEverything it works on is sent to the free provider that answers: your prompts, the files Claude Code reads in this project, the project's memory notes, and anything it reads from other terminals. Providers may keep or use that under their own terms.\n\nFor work that must stay private, turn the container on in Free models, or use an Ollama profile.";
  if (!started.has(profile.id) && !confirm(warning)) return;
  terms.get(profile.id)?.panel.querySelector(".cover")?.remove();
  select(profile.id);
  if (!started.has(profile.id)) setTimeout(() => start(profile.id), 30);
}

function start(id: string): void {
  const entry = terms.get(id);
  if (!entry) return;
  entry.panel.querySelector(".cover")?.remove();
  started.add(id);
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
  soon(() => {
    fitAll();
    terms.get(id)?.term.focus();
  });
}

/**
 * Bring the window in line with the workspace. Only what changed is touched: a new profile gets a
 * panel and its terminal is started, a removed profile's panel goes, and every other terminal keeps
 * running exactly as it was.
 */
function render(): void {
  const wanted = new Set(workspace.profiles.map((p) => p.id));
  for (const [id, { term, panel }] of terms) {
    if (wanted.has(id)) continue;
    term.dispose();
    panel.remove();
    terms.delete(id);
    started.delete(id);
  }
  const count = workspace.profiles.length;
  $("panels").style.setProperty("--cols", String(count <= 3 ? count : Math.ceil(count / 2)));
  $("work").classList.toggle("tabs", workspace.layout === "tabs");
  $("layout").textContent = workspace.layout === "tabs" ? "Grid" : "Tabs";
  $("folder").textContent = workspace.folder || "Choose project folder";
  $("tabs").textContent = "";
  for (const profile of workspace.profiles) {
    if (!terms.has(profile.id)) makePanel(profile);
    const tab = document.createElement("button");
    tab.dataset.id = profile.id;
    tab.textContent = profile.name;
    tab.style.borderTop = `2px solid ${profile.color}`;
    tab.onclick = () => select(profile.id);
    $("tabs").append(tab);
  }
  for (const { panel } of terms.values()) {
    panel.hidden = !workspace.folder;
    (panel.querySelector(".remove") as HTMLElement).hidden = count <= 1;
  }
  $("needFolder")?.remove();
  if (!workspace.folder) {
    // Claude Code works on a folder. Without one it would start in the home folder and ask whether
    // to trust it, so the terminals wait until a project folder is chosen.
    const ask = document.createElement("div");
    ask.id = "needFolder";
    const title = document.createElement("b");
    title.textContent = "Choose the project folder to work in";
    const text = document.createElement("div");
    text.textContent = `Claude Code will start there in ${count === 1 ? "the terminal" : `all ${count} terminals`}. You can change it any time with the button at the top left.`;
    const button = document.createElement("button");
    button.textContent = "Choose project folder";
    button.onclick = () => $("folder").click();
    ask.append(title, text, button);
    $("panels").append(ask);
    return;
  }
  select(workspace.profiles.some((p) => p.id === active) ? active : workspace.profiles[0].id);
  soon(() => {
    for (const profile of workspace.profiles) if (!started.has(profile.id) && profile.kind !== "free") start(profile.id);
    fitAll();
  });
  showNetwork();
  refreshAccounts();
}

/** Offer signed-in Claude Code folders that are on this computer but not in the workspace yet. */
async function offerFoundFolders(): Promise<void> {
  const folders: string[] = await api.invoke("folders:unused");
  const room = 6 - workspace.profiles.length;
  $("found").hidden = !folders.length || room <= 0;
  if ($("found").hidden) return;
  const names = folders.map((f) => f.split(/[\\/]/).pop()).join(", ");
  $("foundText").textContent =
    `Found ${folders.length} Claude Code sign-in folder${folders.length === 1 ? "" : "s"} already on this computer (${names}). Add ${folders.length === 1 ? "it" : "them"} as profiles? They keep their existing sign-ins.`;
}
$("foundAdd").onclick = async () => {
  workspace = await api.invoke("folders:adopt");
  render();
  refreshAccounts();
  offerFoundFolders();
};
$("foundDismiss").onclick = async () => {
  workspace = await api.invoke("folders:dismiss");
  offerFoundFolders();
};

api.on("term:data", (id: string, data: string) => {
  terms.get(id)?.term.write(data);
  watchForLimit(id, data);
});

// A message from another terminal just arrived here: light the panel's border up for a moment.
api.on("term:message", (id: string) => {
  const panel = terms.get(id)?.panel;
  if (!panel) return;
  panel.classList.add("messaged");
  setTimeout(() => panel.classList.remove("messaged"), 2500);
});

/* ---------- Limit reached: offer the free terminal ---------- */

const LIMIT_TEXT = /(usage limit reached|limit reached\s*[∙·|-]\s*resets|you'?ve (hit|reached) your (usage )?limit|out of extra usage)/i;
const recentText = new Map<string, string>();
const limitShownAt = new Map<string, number>();

function watchForLimit(id: string, data: string): void {
  const profile = workspace?.profiles.find((p) => p.id === id);
  if (!profile || (profile.kind ?? "claude") !== "claude") return;
  // Keep a short tail of plain text per terminal, so a message split across chunks is still seen.
  const plain = data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
  const tail = ((recentText.get(id) ?? "") + plain).slice(-400);
  recentText.set(id, tail);
  if (!LIMIT_TEXT.test(tail)) return;
  recentText.set(id, "");
  if (Date.now() - (limitShownAt.get(id) ?? 0) < 10 * 60 * 1000) return;
  limitShownAt.set(id, Date.now());
  const hasFree = workspace.profiles.some((p) => p.kind === "free");
  $("limitText").textContent = `${profile.name} has reached its Claude usage limit. ${hasFree ? "You can keep working in the Free models terminal." : "You can keep working on free AI providers: set up the Free models terminal."}`;
  $("limitGo").textContent = hasFree ? "Open the Free terminal" : "Set up free models";
  $("limit").hidden = false;
}
$("limitGo").onclick = () => {
  $("limit").hidden = true;
  startFree();
};
$("limitClose").onclick = () => ($("limit").hidden = true);

/* ---------- Free models settings ---------- */

/** The free terminal's title bar says whether it is contained. */
function showFreeHint(): void {
  const profile = workspace?.profiles.find((p) => p.kind === "free");
  const hint = profile && (terms.get(profile.id)?.panel.querySelector(".hint") as HTMLElement | null);
  if (!hint) return;
  hint.textContent = freeContained ? "free AI providers · in a container" : "free AI providers · NOT contained: works in your project";
  hint.classList.toggle("warn", !freeContained);
}

interface FreeInfo {
  enabled: boolean; canEncrypt: boolean; contained: boolean;
  providers: { id: string; name: string; model: string; hasKey: boolean; keyUrl: string; note: string; privacy: string }[];
  status: { providers: { id: string; name: string; state: string; served: number; lastProblem: string }[] };
}

async function openFreeDialog(): Promise<void> {
  const info: FreeInfo = await api.invoke("free:get");
  freeContained = info.contained;
  ($("contained") as HTMLInputElement).checked = info.contained;
  const list = $("providers");
  list.textContent = "";
  $("freeError").textContent = info.canEncrypt ? "" : "This computer cannot encrypt saved keys, so keys cannot be stored.";
  for (const provider of info.providers) {
    const box = document.createElement("div");
    box.className = "provider";
    box.dataset.id = provider.id;
    const head = document.createElement("div");
    head.className = "head";
    const name = document.createElement("b");
    name.textContent = provider.name;
    const note = document.createElement("span");
    note.className = "dim";
    note.textContent = `${provider.note} Get a key: ${provider.keyUrl}`;
    head.append(name, note);
    const key = document.createElement("input");
    key.type = "password";
    key.className = "key";
    key.placeholder = provider.hasKey ? "Key saved. Type a new one to replace it." : "Paste the API key";
    const model = document.createElement("input");
    model.className = "model";
    model.value = provider.model;
    model.title = "Model name at this provider";
    const result = document.createElement("div");
    result.className = "outcome dim";
    const state = info.status.providers.find((p) => p.id === provider.id);
    result.textContent = provider.hasKey && state ? `${state.state}${state.served ? `, ${state.served} requests served` : ""}${state.lastProblem ? `. Last problem: ${state.lastProblem}` : ""}` : "";
    const policy = document.createElement("div");
    policy.className = "policy";
    policy.textContent = provider.privacy;
    box.append(head, policy, key, model, result);
    list.append(box);
  }
  $("freeDialog").hidden = false;
}

function freeEntries(): { id: string; key?: string; model: string }[] {
  return [...document.querySelectorAll<HTMLElement>("#providers .provider")].map((box) => {
    const key = (box.querySelector(".key") as HTMLInputElement).value;
    return { id: box.dataset.id!, model: (box.querySelector(".model") as HTMLInputElement).value, ...(key ? { key } : {}) };
  });
}

$("free").onclick = () => openFreeDialog();
$("freeCancel").onclick = () => ($("freeDialog").hidden = true);
$("freeTest").onclick = async () => {
  $("freeError").textContent = "";
  const saved = await api.invoke("free:save", freeEntries(), ($("contained") as HTMLInputElement).checked);
  if (saved.error && !/at least one/.test(saved.error)) return void ($("freeError").textContent = saved.error);
  for (const box of document.querySelectorAll<HTMLElement>("#providers .outcome")) box.textContent = "Testing...";
  const results: Record<string, string> = await api.invoke("free:test");
  for (const box of document.querySelectorAll<HTMLElement>("#providers .provider")) {
    const line = box.querySelector(".outcome") as HTMLElement;
    const outcome = results[box.dataset.id!];
    line.textContent = outcome ?? "No key entered.";
    line.className = "outcome " + (outcome === "working" ? "good" : outcome ? "bad" : "dim");
  }
  if (!saved.error) {
    workspace = saved;
    render();
  }
};
$("freeForm").onsubmit = async (event) => {
  event.preventDefault();
  const before = freeContained;
  const saved = await api.invoke("free:save", freeEntries(), ($("contained") as HTMLInputElement).checked);
  if (saved.error) return void ($("freeError").textContent = saved.error);
  workspace = saved;
  freeContained = ($("contained") as HTMLInputElement).checked;
  $("freeDialog").hidden = true;
  render();
  showFreeHint();
  const free = workspace.profiles.find((p) => p.kind === "free");
  if (free && before !== freeContained && started.has(free.id)) {
    alert("The container setting changed. Restart the free terminal (↻) for it to take effect.");
  }
};
/** Each Claude profile's title bar says which account it is signed in with, and warns about duplicates. */
function showNetwork(): void {
  $("net").hidden = isOnline;
  for (const profile of workspace?.profiles ?? []) {
    const hint = terms.get(profile.id)?.panel.querySelector(".hint") as HTMLElement | null;
    if (!hint || profile.kind === "ollama" || profile.kind === "free") continue;
    const email = accounts[profile.id];
    const twin = email ? workspace.profiles.find((p) => p.id !== profile.id && accounts[p.id] === email) : undefined;
    hint.classList.toggle("warn", !isOnline || !!twin);
    hint.textContent =
      (email ? email : "not signed in yet") + (twin ? ` · same account as ${twin.name}` : "") + (isOnline ? "" : " · needs internet");
    hint.title = twin
      ? "Both profiles use the same Claude account. To change this one: type /logout, then /login, and approve in a private browser window signed in to the other account."
      : "";
  }
}
async function refreshAccounts(): Promise<void> {
  accounts = await api.invoke("profile:accounts");
  showNetwork();
}
// A sign-in or sign-out happens inside the terminal, so the title bars are refreshed regularly.
setInterval(refreshAccounts, 10_000);
api.on("net:status", (online: boolean) => {
  isOnline = online;
  showNetwork();
});

api.on("term:exit", (id: string) => terms.get(id)?.term.write("\r\n\x1b[90m[The terminal closed. Press ↻ to start it again.]\x1b[0m\r\n"));

$("folder").onclick = async () => {
  const before = workspace.folder;
  if (started.size && !confirm("Changing the project folder restarts every terminal in the new folder. Running Claude Code sessions are closed; you can resume them later from the brain. Continue?")) return;
  workspace = await api.invoke("workspace:choose-folder");
  if (workspace.folder === before) return;
  // The one case where every terminal restarts, because each must move to the new folder.
  started.clear();
  render();
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
  soon(() => { fitAll(); resizeMap(); });
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

/* ---------- Smart sorting ---------- */

const TYPES = ["bug fix", "feature", "refactor", "setup and deploy", "tests", "docs", "question"];
for (const type of TYPES) ($("filter") as HTMLSelectElement).add(new Option(type[0].toUpperCase() + type.slice(1), type));
let filter = "";
$("filter").addEventListener("change", () => {
  filter = ($("filter") as HTMLSelectElement).value;
  wake();
});

function showSorting(state: { status: string; [key: string]: any }): void {
  const on = state.status !== "off";
  $("sorting").textContent = `Smart sorting: ${on ? "on" : "off"}`;
  const mb = (bytes: number) => Math.round(bytes / 1024 ** 2).toLocaleString();
  $("sortingState").textContent =
    state.status === "starting" || state.status === "loading" ? "Loading the sorting model. This can take a minute or two after the app starts..."
    : state.status === "downloading" ? `Downloading the sorting model (once): ${mb(state.received)} of ${mb(state.total)} MB`
    : state.status === "sorting" ? `Sorting past sessions: ${state.done} of ${state.total}`
    : state.status === "ready" ? `${state.sorted} sessions sorted. New sessions are sorted once they have been quiet for 10 minutes.`
    : state.status === "error" ? `Smart sorting stopped: ${state.message}`
    : "";
}
api.on("sorting:status", showSorting);
$("sorting").onclick = async () => {
  const on = $("sorting").textContent!.endsWith("on");
  if (!on && !confirm("Smart sorting downloads a 1.7 GB model once and then labels your sessions on this computer (nothing is sent anywhere). It uses about 2 GB of memory while running. Turn it on?")) return;
  showSorting(await api.invoke("sorting:toggle"));
};

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
// Once the picture has settled it stops being recalculated and redrawn, so an idle window uses no CPU.
// Anything that changes it calls wake().
let quietFrames = 0;
const QUIET_AFTER = 90;
function wake(): void {
  quietFrames = 0;
}
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
  wake();
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
  wake();
}

function step(): void {
  const before = nodes.map((n) => [n.x, n.y]);
  const cameraBefore = [camera.x, camera.y, camera.scale];
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
  // Cool down slowly, then stop completely, so the picture comes to rest instead of trembling forever.
  heat = heat > 0.02 ? heat * 0.995 : heat * 0.9;
  fitCamera();
  // Settled means nothing moved more than a tenth of a pixel on screen.
  const moved = nodes.some((n, i) => Math.abs(n.x - before[i][0]) + Math.abs(n.y - before[i][1]) > 0.1 / camera.scale)
    || Math.abs(camera.x - cameraBefore[0]) + Math.abs(camera.y - cameraBefore[1]) > 0.1 / camera.scale
    || Math.abs(camera.scale - cameraBefore[2]) > 0.0005;
  quietFrames = moved ? 0 : quietFrames + 1;
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
  // The filter dims every session that does not match; projects, notes and topics stay as they are.
  const matches = (n: GraphNode) => !filter || n.kind !== "session" || (filter === "unfinished" ? !!n.unfinished : n.tag === filter);
  const lit = (n: GraphNode) => matches(n) && (!focus || n === focus || near!.has(n));
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
    if (n.unfinished) {
      ctx.strokeStyle = css("--topic"); ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.lineWidth = 1; ctx.strokeStyle = css("--line");
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
      const target = workspace.profiles.find((p) => p.name === ref.profile);
      if (target && started.has(target.id) && !confirm(`Resuming restarts ${ref.profile}'s terminal. What is running there now is closed. Continue?`)) return;
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
  wake();
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
  wake();
  const { node, sx, sy } = pointer(event);
  moved = false;
  canvas.setPointerCapture(event.pointerId);
  if (node) dragged = node;
  else panning = { x: sx, y: sy };
});
canvas.addEventListener("pointerup", (event) => {
  wake();
  const { node } = pointer(event);
  if (!moved) selected = node && node === selected ? null : node;
  dragged = null;
  panning = null;
  show(selected || hovered);
});
canvas.addEventListener("wheel", (event) => {
  wake();
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
  wake();
  camera.manual = false;
  heat = Math.max(heat, 0.3);
});
api.on("brain:graph", (data) => { updateGraph(data); show(selected || hovered); });


// The canvas changes size with the window, the panels and the status line above it; keep the drawing in step.
new ResizeObserver(() => resizeMap()).observe(canvas);

/* ---------- Start ---------- */

(async () => {
  workspace = await api.invoke("workspace:get");
  resizeMap();
  freeContained = (await api.invoke("free:get")).contained;
  render();
  showFreeHint();
  await refreshAccounts();
  offerFoundFolders();
  showSorting(await api.invoke("sorting:get"));
  const frame = () => {
    if (quietFrames < QUIET_AFTER || dragged || panning) {
      step();
      draw();
    }
    requestAnimationFrame(frame);
  };
  frame();
})();
