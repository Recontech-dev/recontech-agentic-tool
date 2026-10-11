// The Electron main process: one window with a terminal per Claude Code profile and the brain beside them.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import { ChildProcess, spawn } from "node:child_process";

import { Brain } from "../brain/brain";
import { claudeCommand, ollamaModels, online, profileEnv, signedInAs } from "../brain/launch";
import { home } from "../brain/paths";
import { sameFolder } from "../brain/sessions";
import { bundleReady } from "../brain/sorting";
import * as ws from "../brain/workspace";
import { Control } from "./control";
import { FreeModels } from "./free";

const BRAIN_REFRESH_MS = 10_000;
const NETWORK_CHECK_MS = 30_000;
/** The Smart sorting model is about 1.7 GB; this leaves room for the download and the rest of the disk. */
const MODEL_SPACE_BYTES = 2.5 * 1024 ** 3;

// Screenshots taken for automated checks miss GPU-drawn content, so those runs draw in software.
if (process.env.ALT_SCREENSHOT) app.disableHardwareAcceleration();

const workspace = ws.load();
const brain = new Brain(() => ws.sources(workspace));
const terminals = new Map<string, pty.IPty>();
const sizes = new Map<string, { cols: number; rows: number }>();
let win: BrowserWindow | null = null;
let lastGraph = "";
let isOnline = true;
let failedChecks = 0;
let sorter: ChildProcess | null = null;
const free = new FreeModels(() => send("free:status", free.proxy.status()));
let sortingStatus: Record<string, unknown> = { status: "off" };

const controlFile = () => path.join(home(), "brain", "control.json");

/**
 * The MCP config a Claude Code session is started with, so every session shares the brain.
 * With a profile, the config also tells the brain which terminal it serves, so terminals can
 * message each other. Without one it writes the general file for sessions started by hand.
 */
function mcpConfigFile(profile?: ws.Profile): string {
  // Inside the installed app the scripts are unpacked next to the archive, where a plain Node process can run them.
  const server = path.join(__dirname, "..", "mcp", "server.js").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const file = path.join(home(), "brain", profile ? `mcp-${profile.id}.json` : "mcp.json");
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1", ALT_HOME: home() };
  if (profile) {
    env.ALT_PROFILE = profile.name;
    env.ALT_CONTROL = controlFile();
  }
  const config = { mcpServers: { brain: { command: process.execPath, args: [server], env } } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

/** The link that lets one terminal's Claude Code list, read and message the others. */
const control = new Control({
  terminals: () => workspace.profiles.map((p) => ({ name: p.name, kind: p.kind ?? "claude", running: terminals.has(p.id) })),
  read: async (name, lines) => {
    const profile = workspace.profiles.find((p) => p.name === name);
    if (!profile || !win || win.isDestroyed()) return "";
    return win.webContents.executeJavaScript(`terminalText(${JSON.stringify(profile.id)}, ${Number(lines) || 60})`);
  },
  deliver: (name, text) => {
    const profile = workspace.profiles.find((p) => p.name === name);
    const term = profile && terminals.get(profile.id);
    if (!term) return;
    // Sent as a paste so line breaks stay inside the message, then Enter to submit it.
    term.write(`\x1b[200~${text.replace(/\x1b/g, "")}\x1b[201~`);
    setTimeout(() => terminals.get(profile.id) === term && term.write("\r"), 400);
    send("term:message", profile.id);
  },
});

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
  return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function stopTerminal(id: string): void {
  terminals.get(id)?.kill();
  terminals.delete(id);
}

function startTerminal(id: string, options: { folder?: string; resume?: string } = {}): void {
  stopTerminal(id);
  const profile = workspace.profiles.find((p) => p.id === id);
  if (!profile) return;
  const wanted = options.folder || workspace.folder;
  const folder = wanted && fs.existsSync(wanted) ? wanted : os.homedir();
  const { cols, rows } = sizes.get(id) ?? { cols: 80, rows: 24 };
  const shell = shellCommand();
  const env = profileEnv(profile, process.env, free.connection());
  const term = pty.spawn(shell.file, shell.args, { name: "xterm-256color", cols, rows, cwd: folder, env });
  terminals.set(id, term);
  term.onData((data) => send("term:data", id, data));
  term.onExit(() => {
    if (terminals.get(id) === term) terminals.delete(id);
    send("term:exit", id);
  });
  // ALT_NO_CLAUDE is for automated checks of the window: the shell opens but Claude Code is not started.
  if (!process.env.ALT_NO_CLAUDE) term.write(claudeCommand(profile, mcpConfigFile(profile), options.resume) + "\r");
}

/** A script inside the installed app, at the path a plain Node process can run it from. */
function unpacked(...parts: string[]): string {
  return path.join(__dirname, "..", ...parts).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function setSortingStatus(status: Record<string, unknown>): void {
  sortingStatus = status;
  send("sorting:status", status);
}

function startSorter(): void {
  if (sorter || !workspace.sorting?.enabled) return;
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1", ALT_HOME: home(), LAYA_CACHE: workspace.sorting.modelDir };
  const child = spawn(process.execPath, [unpacked("brain", "sorter.js")], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  sorter = child;
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.status === "warning") continue;
        setSortingStatus(message);
        if (message.status === "ready") pushGraph();
      } catch {
        // not a progress line
      }
    }
  });
  child.on("exit", (code) => {
    if (sorter === child) sorter = null;
    if (workspace.sorting?.enabled && sortingStatus.status !== "error" && code) setSortingStatus({ status: "error", message: `stopped (exit code ${code})` });
  });
}

function stopSorter(): void {
  sorter?.kill();
  sorter = null;
}

/** Free bytes on the drive that holds `folder` (or its nearest existing parent). */
function freeSpace(folder: string): number {
  let dir = folder;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return Infinity;
  }
}

async function toggleSorting(): Promise<Record<string, unknown>> {
  if (workspace.sorting?.enabled) {
    workspace.sorting.enabled = false;
    ws.save(workspace);
    stopSorter();
    setSortingStatus({ status: "off" });
    return sortingStatus;
  }
  let modelDir = workspace.sorting?.modelDir || path.join(home(), "models");
  if (!bundleReady(modelDir) && freeSpace(modelDir) < MODEL_SPACE_BYTES) {
    const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
    const answer = await dialog.showMessageBox(win!, {
      type: "question",
      buttons: ["Choose a folder", "Cancel"],
      message: "Smart sorting needs to download a 1.7 GB model",
      detail: `The drive of ${modelDir} has only ${gb(freeSpace(modelDir))} GB free. Choose a folder on a drive with at least 2.5 GB free.`,
    });
    if (answer.response !== 0) return sortingStatus;
    const choice = await dialog.showOpenDialog(win!, { title: "Folder for the Smart sorting model", properties: ["openDirectory", "createDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return sortingStatus;
    modelDir = path.join(choice.filePaths[0], "agentic-lazy-tool-model");
    if (freeSpace(modelDir) < MODEL_SPACE_BYTES) {
      setSortingStatus({ status: "error", message: "That drive does not have 2.5 GB free either." });
      return sortingStatus;
    }
  }
  workspace.sorting = { enabled: true, modelDir };
  ws.save(workspace);
  setSortingStatus({ status: "starting" });
  startSorter();
  return sortingStatus;
}

function pushGraph(force = false): void {
  try {
    brain.update();
    const colors = Object.fromEntries(workspace.profiles.map((p) => [p.name, p.color]));
    const graph = JSON.stringify(brain.graph(workspace.folder, colors));
    if (force || graph !== lastGraph) {
      lastGraph = graph;
      send("brain:graph", JSON.parse(graph));
    }
  } catch (error) {
    console.error("brain refresh failed", error);
  }
}

async function checkNetwork(): Promise<void> {
  // One failed check can be a hiccup (for example while the app is starting), so it takes two in a row.
  failedChecks = (await online()) ? 0 : failedChecks + 1;
  const now = failedChecks < 2;
  if (failedChecks === 1) setTimeout(checkNetwork, 5000);
  if (now !== isOnline) {
    isOnline = now;
    send("net:status", isOnline);
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    backgroundColor: "#12161c",
    title: "Agentic Lazy Tool",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      // A hidden window normally stops drawing; automated screenshots need it to keep going.
      backgroundThrottling: !process.env.ALT_SCREENSHOT,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // A reload asks for every terminal again, so the old shells go first.
  win.webContents.on("did-start-loading", () => [...terminals.keys()].forEach(stopTerminal));
  win.webContents.on("did-finish-load", () => {
    pushGraph(true);
    send("net:status", isOnline);
    // ALT_SCREENSHOT=<file.png> saves a picture of the window after a few seconds and quits (for automated checks).
    const shot = process.env.ALT_SCREENSHOT;
    if (shot) {
      setTimeout(async () => {
        fs.writeFileSync(shot, (await win!.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.ALT_SCREENSHOT_DELAY || 7000));
    }
  });
  win.loadFile(path.join(__dirname, "..", "..", "static", "index.html"));
  win.on("closed", () => (win = null));
}

function result<T>(work: () => T): T | { error: string } {
  try {
    return work();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

ipcMain.handle("workspace:get", () => workspace);
ipcMain.handle("workspace:choose-folder", async () => {
  const choice = await dialog.showOpenDialog(win!, { title: "Choose the project folder", properties: ["openDirectory"], defaultPath: workspace.folder || os.homedir() });
  if (!choice.canceled && choice.filePaths[0]) {
    workspace.folder = choice.filePaths[0];
    ws.save(workspace);
    pushGraph(true);
  }
  return workspace;
});
ipcMain.handle("workspace:layout", (_event, layout: "grid" | "tabs") => {
  workspace.layout = layout === "tabs" ? "tabs" : "grid";
  ws.save(workspace);
  return workspace;
});
ipcMain.handle("profile:accounts", () => Object.fromEntries(workspace.profiles.map((p) => [p.id, signedInAs(p)])));
ipcMain.handle("folders:unused", () => ws.unusedClaudeFolders(workspace));
ipcMain.handle("folders:adopt", () => {
  ws.adoptFolders(workspace);
  pushGraph(true);
  return workspace;
});
ipcMain.handle("folders:dismiss", () => {
  ws.dismissFolders(workspace);
  return workspace;
});
ipcMain.handle("profile:options", async () => ({
  ollama: await ollamaModels(),
  folders: ws.existingClaudeFolders().filter((f) => !workspace.profiles.some((p) => p.configDir && sameFolder(p.configDir, f))),
  full: workspace.profiles.length >= ws.MAX_PROFILES,
}));
ipcMain.handle("profile:add", (_event, request: ws.NewProfile) =>
  result(() => {
    const profile = ws.addProfile(workspace, request);
    pushGraph(true);
    return profile;
  }),
);
ipcMain.handle("profile:remove", (_event, id: string) =>
  result(() => {
    stopTerminal(id);
    ws.removeProfile(workspace, String(id));
    return workspace;
  }),
);
ipcMain.handle("brain:search", (_event, query: string) => brain.search(String(query), 20));
ipcMain.handle("free:get", () => ({ ...free.describe(), enabled: workspace.profiles.some((p) => p.kind === "free") }));
ipcMain.handle("free:save", (_event, entries: { id: string; key?: string; model?: string }[]) =>
  result(() => {
    free.save(Array.isArray(entries) ? entries : []);
    if (!free.hasAnyKey()) throw new Error("Enter at least one API key.");
    ws.enableFreeProfile(workspace);
    return workspace;
  }),
);
ipcMain.handle("free:test", () => free.test());
ipcMain.handle("sorting:get", () => sortingStatus);
ipcMain.handle("sorting:toggle", () => toggleSorting());
ipcMain.handle("session:resume", (_event, ref: { profile: string; id: string; folder: string }) => {
  const profile = workspace.profiles.find((p) => p.name === ref?.profile);
  if (!profile) return { error: `The profile ${ref?.profile} is not in this workspace any more.` };
  if (!fs.existsSync(ref.folder)) return { error: `The session's folder no longer exists: ${ref.folder}` };
  startTerminal(profile.id, { folder: ref.folder, resume: String(ref.id) });
  return { id: profile.id };
});
ipcMain.on("term:start", (_event, id: string, cols: number, rows: number) => {
  if (cols > 0 && rows > 0) sizes.set(String(id), { cols: Math.floor(cols), rows: Math.floor(rows) });
  startTerminal(String(id));
});
ipcMain.on("term:input", (_event, id: string, data: string) => terminals.get(String(id))?.write(String(data)));
ipcMain.on("term:resize", (_event, id: string, cols: number, rows: number) => {
  if (!(cols > 0 && rows > 0)) return;
  sizes.set(String(id), { cols: Math.floor(cols), rows: Math.floor(rows) });
  terminals.get(String(id))?.resize(Math.floor(cols), Math.floor(rows));
});

app.whenReady().then(async () => {
  await free.start();
  await control.listen();
  control.writeAddress(controlFile());
  mcpConfigFile();
  createWindow();
  setInterval(pushGraph, BRAIN_REFRESH_MS);
  checkNetwork();
  setInterval(checkNetwork, NETWORK_CHECK_MS);
  if (workspace.sorting?.enabled) {
    setSortingStatus({ status: "starting" });
    startSorter();
  }
});

app.on("window-all-closed", () => {
  stopSorter();
  [...terminals.keys()].forEach(stopTerminal);
  app.quit();
});
