// The Electron main process: one window with a terminal per Claude Code profile and the brain beside them.

import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";

import { Brain } from "../brain/brain";
import { claudeCommand, ollamaModels, online, profileEnv } from "../brain/launch";
import { home } from "../brain/paths";
import { sameFolder } from "../brain/sessions";
import * as ws from "../brain/workspace";

const BRAIN_REFRESH_MS = 10_000;
const NETWORK_CHECK_MS = 30_000;

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

/** The MCP config every Claude Code session is started with, so all of them share the brain. */
function mcpConfigFile(): string {
  // Inside the installed app the scripts are unpacked next to the archive, where a plain Node process can run them.
  const server = path.join(__dirname, "..", "mcp", "server.js").replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const file = path.join(home(), "brain", "mcp.json");
  const config = {
    mcpServers: {
      brain: { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: "1", ALT_HOME: home() } },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

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
  const term = pty.spawn(shell.file, shell.args, { name: "xterm-256color", cols, rows, cwd: folder, env: profileEnv(profile, process.env) });
  terminals.set(id, term);
  term.onData((data) => send("term:data", id, data));
  term.onExit(() => {
    if (terminals.get(id) === term) terminals.delete(id);
    send("term:exit", id);
  });
  // ALT_NO_CLAUDE is for automated checks of the window: the shell opens but Claude Code is not started.
  if (!process.env.ALT_NO_CLAUDE) term.write(claudeCommand(profile, mcpConfigFile(), options.resume) + "\r");
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
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
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
ipcMain.handle("profile:options", async () => ({
  ollama: await ollamaModels(),
  folders: ws.existingClaudeFolders().filter((f) => !workspace.profiles.some((p) => p.configDir && sameFolder(p.configDir, f))),
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

app.whenReady().then(() => {
  createWindow();
  setInterval(pushGraph, BRAIN_REFRESH_MS);
  checkNetwork();
  setInterval(checkNetwork, NETWORK_CHECK_MS);
});

app.on("window-all-closed", () => {
  [...terminals.keys()].forEach(stopTerminal);
  app.quit();
});
