// The Electron main process: one window with a terminal per Claude Code profile and the brain beside them.

import { app, BrowserWindow, crashReporter, dialog, ipcMain, session, shell } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import { ChildProcess, spawn } from "node:child_process";
import { autoUpdater } from "electron-updater";

import { Brain } from "../brain/brain";
import * as files from "../brain/files";
import { KITS, allRoles, detectKit, isBuiltInRole, kitById, roleById, standingPrompt } from "../brain/kits";
import { claudeCommand, configDirOf, ollamaModels, online, profileEnv, signedInAs } from "../brain/launch";
import { exportProject, importProject, newSharedNotes, readShared } from "../brain/share";
import { afterWakeWord, cleanupTranscript, matchProject, openProjectRequest, speakable, voiceCommand } from "../brain/speech";
import { addNote, removeNote } from "../brain/store";
import { containerDir, earlierHomes, home } from "../brain/paths";
import { moveData } from "../brain/relocate";
import { removeSession, renameProfileSessions, sameFolder } from "../brain/sessions";
import { bundleReady, renameProfileLabels } from "../brain/sorting";
import { planLimits } from "../brain/limits";
import { tokenUsage } from "../brain/usage";
import * as ws from "../brain/workspace";
import { Control } from "./control";
import { Delivery } from "./delivery";
import { VOICE_REPLY_MS, VoiceReplies } from "./voice";
import { FreeModels } from "./free";
import { makePrivate } from "./privacy";
import { PRESETS } from "../proxy/server";

const BRAIN_REFRESH_MS = 10_000;
const NETWORK_CHECK_MS = 30_000;
/** The Smart sorting model is about 1.7 GB; this leaves room for the download and the rest of the disk. */
const MODEL_SPACE_BYTES = 2.5 * 1024 ** 3;

// The installed app refuses to start with a debugging port: anything on this computer could then
// drive the page, and through it type into every terminal. Development runs keep it for testing.
if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk", "remote-allow-origins"].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
  process.exit(1);
}

// Screenshots taken for automated checks miss GPU-drawn content, so those runs draw in software.
if (process.env.ALT_SCREENSHOT) app.disableHardwareAcceleration();

// The data lives on the drive the app runs from (see defaultHome). Data from an earlier version
// (the user's folder, or a folder named after the app's old name) is moved there first, before
// anything opens it; if that fails, the old folder stays in use for now.
let dataNotice = "";
const earlier = process.env.ALT_HOME ? undefined : [...earlierHomes()].reverse().find((dir) => fs.existsSync(dir));
if (earlier && path.resolve(home()).toLowerCase() !== path.resolve(earlier).toLowerCase()) {
  const result = moveData(earlier, home());
  if (result.moved) {
    dataNotice = `The app's data (workspace, memory, sign-ins of profiles made here) moved to ${home()}.` +
      (result.leftBehind ? ` The old copy at ${result.leftBehind} could not be removed (perhaps another copy of the app still has it open); you can delete it yourself.` : "");
  } else if (result.problem) {
    process.env.ALT_HOME = earlier;
    dataNotice = `The app's data could not be moved to ${path.dirname(home())} (${result.problem}), so it stays in ${earlier} for now. It is tried again at the next start.`;
  }
}

// Electron's single-instance lock is scoped to userData, which by default is NOT under home()/
// ALT_HOME. Moving it there means two real launches (same home) correctly fight over one lock,
// while test/screenshot runs that set ALT_HOME to their own temp folder get their own lock and
// never collide with the real app or with each other.
app.setPath("userData", path.join(home(), "electron-userdata"));
// A native crash in the app (main, page, GPU) is caught and written as a dump under
// electron-userdata\Crashpad, inside the private data folder, instead of ending in a bare Windows
// error box. Nothing is ever sent anywhere.
crashReporter.start({ uploadToServer: false, compress: true });

// A second launch would share this home's workspace.json and sign-ins, and both instances would
// write to it, so only one runs; the second hands off to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

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
    if (ws.isContained(workspace, profile)) env.ALT_CONTAINED = "1";
  }
  const config = { mcpServers: { brain: { command: process.execPath, args: [server], env } } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  return file;
}

/** The link that lets one terminal's Claude Code list, read and message the others. */
const control = new Control({
  terminals: () => workspace.profiles.map((p) => ({
    name: p.name, kind: p.kind ?? "claude", running: terminals.has(p.id), role: p.role ? roleById(p.role, workspace.roles).name : undefined,
  })),
  read: async (name, lines) => {
    const profile = workspace.profiles.find((p) => p.name === name);
    if (!profile || !win || win.isDestroyed()) return "";
    return win.webContents.executeJavaScript(`terminalText(${JSON.stringify(profile.id)}, ${Number(lines) || 60})`);
  },
  contained: (name) => ws.isContained(workspace, workspace.profiles.find((p) => p.name === name)),
  deliver: (name, text, from) => {
    const profile = workspace.profiles.find((p) => p.name === name);
    if (!profile || !terminals.has(profile.id)) return "sent";
    // In a voice conversation the Manager's messages are spoken (and shown, to insert if wanted)
    // instead of going straight into the terminal; messages from any other terminal are delivered as usual.
    const reply = voiceReplies.take(profile.id, from, text);
    if (reply !== null) {
      send("voice:reply", profile.id, reply, speakable(reply));
      return "sent";
    }
    return sendToProfile(profile, text);
  },
});

/**
 * Everything the app puts into a terminal: messages held while the user types there, and nothing at
 * all while Claude Code is not the program reading it.
 */
const delivery = new Delivery((id) => terminals.get(id), {
  message: (id) => send("term:message", id),
  waiting: (id, count) => send("term:waiting", id, count),
});
const inbox = delivery.inbox;
const INBOX_CHECK_MS = 500;
/** Terminals the user talks to the Manager through by voice; the Manager's messages to them are spoken, not typed in. */
const voiceReplies = new VoiceReplies();

/** Send a message to a profile's terminal, or hold it while its user is typing or Claude Code is not running there. */
function sendToProfile(profile: ws.Profile, text: string): "sent" | "queued" {
  return delivery.send(profile.id, text);
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
  delivery.unwatch(id);
}

function startTerminal(id: string, options: { folder?: string; resume?: string } = {}): void {
  stopTerminal(id);
  inbox.restarted(id);
  const profile = workspace.profiles.find((p) => p.id === id);
  if (!profile) return;
  const contained = ws.isContained(workspace, profile);
  if (contained) fs.mkdirSync(containerDir(), { recursive: true });
  // A contained terminal never starts in a project: it gets its own empty folder.
  const wanted = contained ? containerDir() : options.folder || workspace.folder;
  const folder = wanted && fs.existsSync(wanted) ? wanted : os.homedir();
  const { cols, rows } = sizes.get(id) ?? { cols: 80, rows: 24 };
  const shell = shellCommand();
  const env = profileEnv(profile, process.env, free.connection());
  const term = pty.spawn(shell.file, shell.args, { name: "xterm-256color", cols, rows, cwd: folder, env });
  terminals.set(id, term);
  const mode = delivery.watch(id);
  term.onData((data) => {
    mode.feed(data);
    send("term:data", id, data);
  });
  term.onExit(() => {
    // A shell replaced by a restart, or closed with its profile, exits later; that is not news for the window.
    if (terminals.get(id) !== term) return;
    terminals.delete(id);
    delivery.unwatch(id);
    send("term:exit", id);
  });
  // ALT_NO_CLAUDE is for automated checks of the window: the shell opens but Claude Code is not started.
  // A contained terminal has no project, so it gets no project kit; every other terminal gets the
  // kit of the folder it works in and the role the user gave it.
  const standing = contained ? "" : standingPrompt(currentKit(folder), profile.role, workspace.roles);
  if (!process.env.ALT_NO_CLAUDE) term.write(claudeCommand(profile, mcpConfigFile(profile), options.resume, contained, standing) + "\r");
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

let transcriber: ChildProcess | null = null;
let transcriberStatus: Record<string, unknown> = { status: "off" };
let transcriberReady: Promise<void> | null = null;
const transcribePending = new Map<string, (answer: { text?: string; error?: string }) => void>();
// After the worker fails, Hey Recon would respawn it on every utterance it hears; this holds off retries for a while.
const TRANSCRIBER_RETRY_MS = 15_000;
let transcriberFailure: { until: number; error: Error } | null = null;

function setTranscriberStatus(status: Record<string, unknown>): void {
  transcriberStatus = status;
  send("mic:status", status);
}

/** Starts the speech-to-text worker on first use and resolves once it has a model loaded and is ready for requests. */
function startTranscriber(): Promise<void> {
  if (transcriberReady) return transcriberReady;
  if (transcriberFailure && Date.now() < transcriberFailure.until) return Promise.reject(transcriberFailure.error);
  transcriberFailure = null;
  setTranscriberStatus({ status: "loading" });
  transcriberReady = new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1", ALT_HOME: home(), WHISPER_CACHE: path.join(home(), "models") };
    const child = spawn(process.execPath, [unpacked("brain", "transcriber.js")], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    transcriber = child;
    // Why the worker failed: the error it reported itself, or else what it printed on stderr before crashing.
    let reportedError = "";
    let stderr = "";
    let ready = false;
    let ended = false;
    child.stderr!.on("data", (chunk) => {
      console.error(`[transcriber] ${String(chunk).trimEnd()}`);
      stderr = (stderr + chunk).slice(-4000);
    });
    let buffer = "";
    child.stdout!.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id) {
          transcribePending.get(message.id)?.(message);
          transcribePending.delete(message.id);
          continue;
        }
        setTranscriberStatus(message);
        if (message.status === "ready") {
          ready = true;
          resolve();
        }
        if (message.status === "error") {
          reportedError = String(message.message ?? "");
          reject(new Error(message.message));
        }
      }
    });
    // Runs once, whether the worker exited or could not be started at all (then only "error" fires).
    const end = (code: number | null, startError?: string) => {
      if (ended) return;
      ended = true;
      if (transcriber === child) transcriber = null;
      transcriberReady = null;
      for (const resolvePending of transcribePending.values()) resolvePending({ error: "The speech model stopped." });
      transcribePending.clear();
      const reason = startError || reportedError || stderr.split("\n").map((line) => line.trim()).find(Boolean) || "";
      const error = new Error(`The speech model could not start${code ? ` (exit code ${code})` : ""}${reason ? `: ${reason}` : "."}`);
      // Quitting before it was ready is a failure even without an exit code; otherwise the status would
      // stay "loading" and the next utterance would start it again straight away.
      if (code || !ready) {
        transcriberFailure = { until: Date.now() + TRANSCRIBER_RETRY_MS, error };
        const stopped = code ? `stopped (exit code ${code})` : "stopped before it was ready";
        setTranscriberStatus({ status: "error", message: reason ? `${stopped}: ${reason}` : stopped });
      }
      // A worker that quits before it is ready would otherwise leave every recording waiting forever.
      reject(error);
    };
    child.on("exit", (code) => end(code));
    child.on("error", (error) => end(null, error.message));
  });
  transcriberReady.catch(() => {});
  return transcriberReady;
}

/** Transcribes 16kHz mono PCM audio with the local Whisper model, downloading it on first use. */
async function transcribe(pcm: number[]): Promise<{ text?: string; error?: string }> {
  try {
    await startTranscriber();
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (!transcriber) return { error: "The speech model is not available." };
  const id = Math.random().toString(36).slice(2);
  const answer = await new Promise<{ text?: string; error?: string }>((resolve) => {
    transcribePending.set(id, resolve);
    transcriber!.stdin!.write(JSON.stringify({ id, pcm }) + "\n");
  });
  if (answer.text) answer.text = cleanupTranscript(answer.text);
  return answer;
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
    modelDir = path.join(choice.filePaths[0], "recontech-agentic-tool-model");
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

/** The project kit for a folder: the user's choice if they made one, otherwise what the files suggest. */
function currentKit(folder: string): string {
  return workspace.kits?.[folder.toLowerCase()] ?? detectKit(folder);
}

/*
 * Updates: on start the app asks GitHub Releases for a newer version (latest.yml, published with each
 * release) and downloads it in the background. It is only installed when the user clicks to restart,
 * or when they quit the app. Nothing about the user is sent.
 */
type UpdateStatus = { status: "checking" | "none" | "available" | "downloading" | "ready" | "error"; version?: string; percent?: number; message?: string };
let updateStatus: UpdateStatus = { status: "none" };

function setUpdateStatus(status: UpdateStatus): void {
  updateStatus = status;
  send("update:status", status);
}

function startUpdates(): void {
  // A development build has no release to update from (and no app-update.yml to say where it is).
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("checking-for-update", () => setUpdateStatus({ status: "checking" }));
  autoUpdater.on("update-not-available", () => setUpdateStatus({ status: "none" }));
  autoUpdater.on("update-available", (info) => setUpdateStatus({ status: "available", version: info.version }));
  autoUpdater.on("download-progress", (progress) =>
    setUpdateStatus({ status: "downloading", version: updateStatus.version, percent: Math.round(progress.percent) }));
  autoUpdater.on("update-downloaded", (info) => setUpdateStatus({ status: "ready", version: info.version }));
  autoUpdater.on("error", (error) => setUpdateStatus({ status: "error", version: updateStatus.version, message: error?.message ?? String(error) }));
  // Offline or GitHub unreachable: the "error" event has already said so.
  autoUpdater.checkForUpdates().catch(() => {});
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
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#12161c",
    title: "Recontech Agentic Tool",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true,
      // A hidden window normally stops drawing; automated screenshots need it to keep going.
      backgroundThrottling: !process.env.ALT_SCREENSHOT,
      // The installed app has no developer tools: they would show the page's state and let anyone run code in it.
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // The page holds back closing while the editor has unsaved edits; ask whether to close anyway.
  win.webContents.on("will-prevent-unload", (event) => {
    const answer = dialog.showMessageBoxSync(win!, {
      type: "warning", buttons: ["Close without saving", "Keep editing"], defaultId: 1, cancelId: 1,
      message: "Some open files have unsaved changes.", detail: "Closing now loses them.",
    });
    if (answer === 0) event.preventDefault();
  });
  // A crashed page would leave a blank window: it is loaded again, unless it keeps crashing.
  const crashes: number[] = [];
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || !win || win.isDestroyed()) return;
    console.error(`[window] the page stopped (${details.reason}, exit code ${details.exitCode})`);
    crashes.push(Date.now());
    while (crashes.length && Date.now() - crashes[0] > 60_000) crashes.shift();
    if (crashes.length < 3) return void win.webContents.reload();
    dialog.showMessageBox(win, {
      type: "error", title: "The window keeps stopping",
      message: "The app's window stopped working three times in a minute, so it was not loaded again.",
      detail: `Close the app and start it again. A crash report was saved in ${path.join(app.getPath("userData"), "Crashpad")}; nothing was sent anywhere.`,
    });
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-redirect", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  // A reload asks for every terminal again, so the old shells go first.
  win.webContents.on("did-start-loading", () => [...terminals.keys()].forEach(stopTerminal));
  win.webContents.on("did-finish-load", () => {
    pushGraph(true);
    send("net:status", isOnline);
    // The update check can finish before the page is listening; it gets the latest status again here.
    send("update:status", updateStatus);
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

/** If the workspace file was unreadable and reset at startup, tell the user where the old one went. */
function showRecoveryNotice(): void {
  const notice = ws.takeRecoveryNotice();
  if (notice) dialog.showMessageBox(win!, { type: "warning", title: "Workspace reset", message: notice });
  if (dataNotice) dialog.showMessageBox(win!, { type: "info", title: "Data folder", message: dataNotice });
}

function result<T>(work: () => T): T | { error: string } {
  try {
    return work();
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * True when an IPC message comes from the app's own page in the main window. The page cannot
 * navigate or open windows, so nothing else should ever send one; this is the last line if it did.
 */
function fromPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return !!win && !win.isDestroyed() && event.sender === win.webContents && !!frame &&
    frame.processId === win.webContents.mainFrame.processId && frame.routingId === win.webContents.mainFrame.routingId &&
    frame.url.startsWith("file:");
}

// Every channel below goes through these, so a message from anywhere but the app's page is refused.
{
  const handle = ipcMain.handle.bind(ipcMain);
  const on = ipcMain.on.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, (event, ...args) => {
      if (!fromPage(event)) throw new Error(`blocked: ${channel}`);
      return listener(event, ...args);
    });
  ipcMain.on = (channel, listener) =>
    on(channel, (event, ...args) => {
      if (fromPage(event)) listener(event, ...args);
    });
}

ipcMain.handle("workspace:get", () => workspace);
// Split in two so the restart-every-terminal confirm (asked by the renderer in between) only
// has to happen once a folder was actually chosen, not before the picker even opens.
ipcMain.handle("workspace:pick-folder", async () => {
  const choice = await dialog.showOpenDialog(win!, { title: "Choose the project folder", properties: ["openDirectory"], defaultPath: workspace.folder || os.homedir() });
  return choice.canceled ? null : choice.filePaths[0] || null;
});
ipcMain.handle("workspace:set-folder", (_event, folder: string) => {
  // Every terminal starts there and the Files panel may read and write inside it, so it must be a real folder.
  // A network path (\\server\share) is refused: only looking at one makes Windows sign in to that computer.
  const wanted = String(folder ?? "");
  const isFolder = () => {
    try {
      return !!fs.statSync(wanted, { throwIfNoEntry: false })?.isDirectory();
    } catch {
      return false;
    }
  };
  if (!path.isAbsolute(wanted) || /^[\\/]{2}/.test(wanted) || !isFolder()) return workspace;
  workspace.folder = path.resolve(wanted);
  ws.save(workspace);
  pushGraph(true);
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
    inbox.forget(String(id));
    return workspace;
  }),
);
ipcMain.handle("brain:search", (_event, query: string) => brain.searchSmart(String(query), 20));
ipcMain.handle("brain:unfinished", () => brain.unfinished(workspace.folder));
// Claude tokens only: Ollama and Free models terminals also write usage, but those are not Claude's.
// The renderer also gets each Claude profile's own week and session window, by profile id, for the bar under its terminal.
// Each Claude account (a Claude Code folder, which several terminals can share) also gets its own
// periods and its plan limits from Anthropic: the percentages the Claude app shows.
ipcMain.handle("usage:get", async () => {
  const claude = workspace.profiles.filter((p) => (p.kind ?? "claude") === "claude");
  try {
    const dirs = [...new Set(claude.map((p) => path.resolve(configDirOf(p))))];
    const [{ folders, ...usage }, limits] = await Promise.all([tokenUsage(dirs), Promise.all(dirs.map((dir) => planLimits(dir)))]);
    const accounts = dirs.map((dir, i) => {
      const owners = claude.filter((p) => path.resolve(configDirOf(p)) === dir);
      return { dir, names: owners.map((p) => p.name), email: signedInAs(owners[0]), usage: folders[dir] ?? null, limits: limits[i] };
    });
    return {
      ...usage,
      accounts,
      profiles: Object.fromEntries(claude.map((p) => {
        const dir = path.resolve(configDirOf(p));
        return [p.id, folders[dir] ? { ...folders[dir], limits: limits[dirs.indexOf(dir)] } : null];
      }).filter(([, u]) => u)),
    };
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) };
  }
});
ipcMain.handle("note:add", (_event, text: string) =>
  result(() => {
    if (!workspace.folder) throw new Error("Choose a project folder first.");
    if (!String(text ?? "").trim()) throw new Error("Type the note first.");
    const saved = addNote(workspace.folder, String(text), "manual");
    pushGraph(true);
    return { saved };
  }),
);
ipcMain.handle("note:remove", (_event, ref: { folder: string; number: number }) =>
  result(() => {
    const removed = removeNote(String(ref?.folder), Number(ref?.number));
    pushGraph(true);
    return { removed: !!removed };
  }),
);
ipcMain.handle("session:remove", (_event, ref: { profile: string; id: string }) =>
  result(() => {
    const removed = removeSession(String(ref?.profile), String(ref?.id));
    pushGraph(true);
    return { removed };
  }),
);
ipcMain.handle("share:info", () => {
  if (!workspace.folder) return { folder: "" };
  const shared = readShared(workspace.folder);
  return { folder: workspace.folder, exists: !!shared, exported: shared?.exported ?? "", sharedNotes: shared?.notes.length ?? 0, newNotes: newSharedNotes(workspace.folder).length };
});
ipcMain.handle("share:export", () =>
  result(() => {
    if (!workspace.folder) throw new Error("Choose a project folder first.");
    const open = brain.unfinished(workspace.folder).filter((u) => u.here).map((u) => ({ title: u.title, ended: u.ended }));
    return { notes: exportProject(workspace.folder, open) };
  }),
);
ipcMain.handle("share:import", () =>
  result(() => {
    const added = importProject(workspace.folder);
    pushGraph(true);
    return { added };
  }),
);
ipcMain.handle("kit:get", () => {
  const detected = workspace.folder ? detectKit(workspace.folder) : "none";
  const chosen = workspace.folder ? currentKit(workspace.folder) : "none";
  return { kits: KITS.map((k) => ({ id: k.id, name: k.name })), roles: allRoles(workspace.roles).map((r) => ({ id: r.id, name: r.name })), kit: chosen, detected: kitById(detected).name };
});
ipcMain.handle("kit:set", (_event, id: string) => {
  if (!workspace.folder) return workspace;
  workspace.kits = { ...(workspace.kits ?? {}), [workspace.folder.toLowerCase()]: kitById(String(id)).id };
  ws.save(workspace);
  return workspace;
});
ipcMain.handle("profile:role", (_event, id: string, role: string) => {
  const profile = workspace.profiles.find((p) => p.id === id);
  if (profile) {
    profile.role = roleById(String(role), workspace.roles).id || undefined;
    ws.save(workspace);
  }
  return workspace;
});
// The browser switch in a terminal's title bar. The page restarts the terminal itself, after asking.
ipcMain.handle("profile:browser", (_event, id: string, on: boolean) =>
  result(() => {
    if (typeof on !== "boolean") throw new Error("Say on or off.");
    ws.setBrowser(workspace, String(id), on);
    ws.save(workspace);
    return workspace;
  }),
);
/** The role manager: every role with its instructions, whether it is built in, and the terminals that have it. */
ipcMain.handle("role:list", () =>
  allRoles(workspace.roles).filter((r) => r.id).map((r) => ({
    ...r, builtIn: isBuiltInRole(r.id), usedBy: workspace.profiles.filter((p) => p.role === r.id).map((p) => p.name),
  })),
);
ipcMain.handle("role:save", (_event, request: { id?: string; name: string; prompt: string }) =>
  result(() => ({ role: ws.saveRole(workspace, request ?? { name: "", prompt: "" }), workspace })),
);
ipcMain.handle("role:remove", (_event, id: string) =>
  result(() => {
    ws.removeRole(workspace, String(id));
    return workspace;
  }),
);
ipcMain.handle("profile:rename", (_event, id: string, name: string) =>
  result(() => {
    const before = workspace.profiles.find((p) => p.id === String(id))?.name;
    ws.renameProfile(workspace, String(id), String(name));
    // Sessions and Smart sorting labels are filed under the old name; move them so Resume still finds them.
    if (before) {
      renameProfileSessions(before, workspace.profiles.find((p) => p.id === String(id))!.name);
      renameProfileLabels(before, workspace.profiles.find((p) => p.id === String(id))!.name);
    }
    pushGraph(true);
    return workspace;
  }),
);
ipcMain.handle("ui:save", (_event, ui: { fontSize?: number; brainWidth?: number; editorShare?: number; filesOpen?: boolean; voiceOn?: boolean; split?: unknown; usageBudget?: { session?: number; week?: number } }) => {
  if (ui?.usageBudget && typeof ui.usageBudget === "object") {
    // 0 (or anything that is not a sensible count) clears that budget.
    const budget = (n: unknown) => (Number(n) > 0 && Number(n) <= 1e13 ? Math.round(Number(n)) : undefined);
    workspace.usageBudget = { session: budget(ui.usageBudget.session), week: budget(ui.usageBudget.week) };
  }
  if (Number(ui?.fontSize) >= 9 && Number(ui?.fontSize) <= 24) workspace.fontSize = Number(ui.fontSize);
  if (Number(ui?.brainWidth) >= 240 && Number(ui?.brainWidth) <= 1200) workspace.brainWidth = Math.round(Number(ui.brainWidth));
  if (Number(ui?.editorShare) >= 0.2 && Number(ui?.editorShare) <= 0.85) workspace.editorShare = Number(ui.editorShare);
  if (ui && "split" in ui) workspace.split = ws.cleanSplit(ui.split, workspace.profiles.map((p) => p.id));
  if (typeof ui?.filesOpen === "boolean") workspace.filesOpen = ui.filesOpen;
  if (typeof ui?.voiceOn === "boolean") workspace.voiceOn = ui.voiceOn;
  ws.save(workspace);
});
// The Files panel. Paths come from the page relative to the project folder, and files.inside()
// refuses any that would lead out of it.
ipcMain.handle("files:list", (_event, relative: string) => result(() => files.list(workspace.folder, String(relative ?? ""))));
ipcMain.handle("files:open", async (_event, relative: string) => {
  try {
    const full = files.inside(workspace.folder, String(relative ?? ""));
    // Programs and scripts would run if opened, so they are only shown in Explorer.
    if (files.runnable(full)) {
      shell.showItemInFolder(full);
      return { revealed: true };
    }
    const problem = await shell.openPath(full);
    return problem ? { error: problem } : { opened: true };
  } catch (error) {
    return { error: (error as Error).message };
  }
});
ipcMain.handle("files:reveal", (_event, relative: string) =>
  result(() => {
    const full = files.inside(workspace.folder, String(relative ?? ""));
    // The project folder itself opens; anything in it is shown selected in its folder.
    if (!String(relative ?? "")) shell.openPath(full);
    else shell.showItemInFolder(full);
    return { revealed: true };
  }),
);
// The editor. Every path goes through the same project-folder check as the Files panel.
ipcMain.handle("files:read", (_event, relative: string) => {
  try {
    return files.readText(workspace.folder, String(relative ?? ""));
  } catch (error) {
    // "binary" or "large" tells the window to open the file with its own app instead.
    return { error: (error as Error).message, code: (error as { code?: string }).code };
  }
});
ipcMain.handle("files:changed-at", (_event, relative: string) => files.changedAt(workspace.folder, String(relative ?? "")));
ipcMain.handle("files:write", (_event, file: { path: string; text: string; mtime: number; bom: boolean; force?: boolean }) =>
  result(() => files.writeText(workspace.folder, String(file?.path ?? ""), String(file?.text ?? ""), Number(file?.mtime), !!file?.bom, !!file?.force)),
);
ipcMain.handle("files:committed", (_event, relative: string) => result(() => ({ text: files.committed(workspace.folder, String(relative ?? "")) })));
// Hands the file to an installed VS Code through its vscode:// link, so no shell or command line is involved.
ipcMain.handle("files:vscode", (_event, relative: string) =>
  result(() => {
    const full = files.inside(workspace.folder, String(relative ?? ""));
    shell.openExternal(`vscode://file/${encodeURI(full.replace(/\\/g, "/")).replace(/[#?]/g, encodeURIComponent)}`);
    return { opened: true };
  }),
);
// Restarts into the downloaded version, only when the user asks. Silent: the installer was already run once.
ipcMain.handle("update:install", () => {
  if (updateStatus.status === "ready") autoUpdater.quitAndInstall(true, true);
});
ipcMain.handle("free:get", () => ({
  ...free.describe(), enabled: workspace.profiles.some((p) => p.kind === "free"), contained: workspace.freeContained !== false,
}));
ipcMain.handle("free:save", (_event, entries: { id: string; key?: string; model?: string }[], contained?: boolean) =>
  result(() => {
    if (typeof contained === "boolean") {
      workspace.freeContained = contained;
      ws.save(workspace);
    }
    free.save(Array.isArray(entries) ? entries : []);
    if (!free.hasAnyKey()) throw new Error("Enter at least one API key.");
    ws.enableFreeProfile(workspace);
    return workspace;
  }),
);
// With entries from the dialog, tests exactly what is on screen without saving it (no side effect);
// with none, tests the already-saved keys instead.
ipcMain.handle("free:test", (_event, entries?: { id: string; key?: string; model?: string; baseUrl?: string }[]) =>
  Array.isArray(entries) ? free.testEntries(entries) : free.test(),
);
// "Get a key" in the Free models dialog opens that provider's own key page in the browser; only those known pages.
ipcMain.handle("free:key-page", (_event, id: string) => {
  const url = Object.hasOwn(PRESETS, String(id)) ? PRESETS[String(id)].keyUrl : "";
  if (url) void shell.openExternal(url);
});
ipcMain.handle("sorting:get", () => sortingStatus);
ipcMain.handle("sorting:toggle", () => toggleSorting());
/** The longest recording that is transcribed: two minutes at 16 kHz. Anything longer is cut, so the page cannot tie the worker up. */
const MAX_SAMPLES = 16_000 * 120;
ipcMain.handle("mic:transcribe", (_event, pcm: number[]) =>
  transcribe(Array.isArray(pcm) ? pcm.slice(0, MAX_SAMPLES).map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0)) : []));

/**
 * Reads one thing the user said: whether it starts with the wake word "Recon" (and what followed it),
 * and whether it is a command to the voice assistant itself ("turn off the mic", "that's all").
 */
ipcMain.handle("voice:wake", (_event, text: string) => {
  const heard = String(text ?? "");
  const after = afterWakeWord(heard);
  return { matched: after !== null, after: after ?? "", command: voiceCommand(after ?? heard), open: openProjectRequest(after ?? heard) };
});

/**
 * The folder of a project the user named by voice, from the projects the brain already knows (past
 * sessions and the current folder), so a misheard name can only ever open one of the user's own projects.
 */
ipcMain.handle("voice:find-project", (_event, name: string) => {
  const known = [workspace.folder, ...brain.sessions.map((s) => s.folder)].filter(Boolean);
  const unique = known.filter((folder, i) => known.findIndex((other) => sameFolder(other, folder)) === i && fs.existsSync(folder));
  return { folder: matchProject(String(name ?? ""), unique) };
});

/**
 * Hands what the user said to whichever terminal has the Manager role, as part of a live conversation:
 * its answers come back to another running terminal (the anchor) and are spoken there, not typed in.
 */
ipcMain.handle("voice:ask", (_event, anchorId: string, command: string) => {
  const manager = workspace.profiles.find((p) => p.role === "manager");
  if (!manager) return { error: "No terminal has the Manager role yet. Open Roles and give one terminal the Manager role." };
  if (!terminals.has(manager.id)) return { error: `${manager.name}'s terminal has not been started.` };
  // The Manager answers with message_terminal, which needs another terminal to send to. The active one
  // is used, or any other running one when the Manager itself is active.
  const others = workspace.profiles.filter((p) => p.id !== manager.id && terminals.has(p.id));
  const anchor = others.find((p) => p.id === String(anchorId)) ?? others[0];
  if (!anchor) return { error: `Start one more terminal besides ${manager.name}; the Manager answers by voice through it.` };
  const text = cleanupTranscript(String(command ?? ""));
  if (!text) return { error: "Didn't catch that." };
  voiceReplies.expect(anchor.id, manager.name);
  const how = sendToProfile(manager,
    `[Message from the "${anchor.name}" terminal, spoken by the user in a live voice conversation] ${text} ` +
    `Answer with message_terminal to "${anchor.name}"; your answer is read aloud, so write it as speech: one to three short sentences, no Markdown, lists or code. ` +
    "If the work takes a while, say so first, then send another short message when it is done.");
  return { manager: manager.name, anchor: anchor.id, queued: how === "queued", waitMs: VOICE_REPLY_MS };
});
ipcMain.handle("session:resume", (_event, ref: { profile: string; id: string; folder: string }) => {
  const profile = workspace.profiles.find((p) => p.name === ref?.profile);
  if (!profile) return { error: `The profile ${ref?.profile} is not in this workspace any more.` };
  if (!fs.existsSync(ref.folder)) return { error: `The session's folder no longer exists: ${ref.folder}` };
  startTerminal(profile.id, { folder: ref.folder, resume: String(ref.id) });
  return { id: profile.id };
});
ipcMain.on("term:start", (_event, id: string, cols: number, rows: number) => {
  if (cols > 0 && rows > 0 && cols <= 2000 && rows <= 1000) sizes.set(String(id), { cols: Math.floor(cols), rows: Math.floor(rows) });
  startTerminal(String(id));
});
ipcMain.on("term:input", (_event, id: string, data: string) => {
  inbox.typed(String(id), String(data));
  terminals.get(String(id))?.write(String(data));
});
// Text the app pastes for the user to check and send (a voice transcript, a Manager's answer): cleaned
// of anything that could end the paste early, and on one line when asked, so nothing runs by itself.
ipcMain.handle("term:paste", (_event, id: string, text: string, oneLine: boolean) => {
  const target = String(id);
  if (!terminals.has(target)) return { error: "That terminal is not running." };
  if (!delivery.paste(target, String(text ?? ""), oneLine === true)) return { error: "Claude Code is not running in that terminal, so nothing was put in: the shell would run it. Start Claude Code there (↻) and try again." };
  return { ok: true };
});
// While Hey Recon listens, the window keeps full speed when minimized or covered; otherwise it would stop hearing.
ipcMain.on("voice:listening", (_event, on: boolean) => {
  if (on !== true) voiceReplies.clear();
  if (win && !win.isDestroyed()) win.webContents.setBackgroundThrottling(on !== true && !process.env.ALT_SCREENSHOT);
});
// The "message waiting" button in a terminal's title bar: the user wants it now, typing or not.
ipcMain.handle("term:deliver-now", (_event, id: string) => delivery.flush(String(id), true));
ipcMain.on("term:resize", (_event, id: string, cols: number, rows: number) => {
  if (!(cols > 0 && rows > 0 && cols <= 2000 && rows <= 1000)) return;
  sizes.set(String(id), { cols: Math.floor(cols), rows: Math.floor(rows) });
  terminals.get(String(id))?.resize(Math.floor(cols), Math.floor(rows));
});

app.whenReady().then(async () => {
  // Off the user's folder (the app installed on D:, say) the data folder would be open to every user.
  void makePrivate(home());
  void pruneCrashReports();
  // Electron denies permission requests (microphone included) unless something explicitly answers them.
  // Only the app's own page gets anything, and that is the microphone (for Recon and push-to-talk): no camera, no screen.
  const ownPage = (contents: Electron.WebContents | null) => !!contents && !!win && !win.isDestroyed() && contents === win.webContents;
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(permission === "media" && ownPage(contents) && types.every((type) => type === "audio"));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === "media" && ownPage(contents));
  await free.start();
  await control.listen();
  control.writeAddress(controlFile());
  mcpConfigFile();
  createWindow();
  showRecoveryNotice();
  setInterval(pushGraph, BRAIN_REFRESH_MS);
  setInterval(() => inbox.pending().forEach((id) => delivery.flush(id)), INBOX_CHECK_MS);
  checkNetwork();
  setInterval(checkNetwork, NETWORK_CHECK_MS);
  startUpdates();
  if (workspace.sorting?.enabled) {
    setSortingStatus({ status: "starting" });
    startSorter();
  }
});

/** Only the newest few crash reports are kept; they are for looking into a recent crash, not a history. */
async function pruneCrashReports(keep = 5): Promise<void> {
  const dir = path.join(app.getPath("crashDumps"), "reports");
  try {
    const dumps = await Promise.all((await fs.promises.readdir(dir)).filter((name) => name.endsWith(".dmp"))
      .map(async (name) => ({ file: path.join(dir, name), at: (await fs.promises.stat(path.join(dir, name))).mtimeMs })));
    dumps.sort((a, b) => b.at - a.at);
    await Promise.all(dumps.slice(keep).map(({ file }) => fs.promises.rm(file, { force: true })));
  } catch {
    // No reports folder yet: nothing has crashed.
  }
}

/** Stops every terminal and worker. Their consoles would otherwise keep the app from exiting. */
function shutDown(): void {
  stopSorter();
  transcriber?.kill();
  [...terminals.keys()].forEach(stopTerminal);
}

app.on("window-all-closed", () => {
  shutDown();
  app.quit();
});
// Quitting by app.quit() (installing an update, the screenshot run) closes the window without a
// window-all-closed event, so the same clean-up runs here too.
app.on("will-quit", shutDown);
