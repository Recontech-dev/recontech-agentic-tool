// The window: one terminal per profile, and the brain graph on the right.
// This file runs in the page, so it uses only browser APIs and window.api from the preload script.

interface Profile { id: string; name: string; color: string; configDir: string | null; kind?: "claude" | "ollama" | "free"; model?: string; role?: string }
interface Workspace { folder: string; profiles: Profile[]; layout: "grid" | "tabs"; fontSize?: number; brainWidth?: number; editorShare?: number; filesOpen?: boolean; voiceOn?: boolean; split?: SplitNode | null; usageBudget?: { session?: number; week?: number } }
interface GraphNode { id: string; kind: string; label: string; text: string; detail: string; open: boolean;
  color?: string; resume?: { profile: string; id: string; folder: string }; tag?: string; unfinished?: boolean;
  note?: { folder: string; number: number };
  x: number; y: number; vx: number; vy: number }
interface Match { kind: string; project: string; folder: string; text: string; when: string; resume?: { profile: string; id: string; folder: string } }

declare const Terminal: any;
declare const FitAddon: any;
declare const api: {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (...args: any[]) => void): void;
};

const $ = (id: string) => document.getElementById(id)!;

/** A short message at the bottom of the window that goes away by itself, instead of a dialog to click away. */
let toastTimer = 0;
function toast(text: string, bad = false): void {
  const box = $("toast");
  box.textContent = text;
  box.className = bad ? "bad" : "";
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (box.hidden = true), bad ? 6000 : 3000);
}
let workspace: Workspace;
let active = "";
let isOnline = true;
let accounts: Record<string, string> = {};
let freeContained = true;
/** Profiles whose signed-in email is currently shown in full, instead of masked for privacy. */
const revealedEmails = new Set<string>();
let roles: { id: string; name: string }[] = [{ id: "", name: "No role" }];
const terms = new Map<string, { term: any; fit: any; panel: HTMLElement }>();
/** Profiles whose terminal has been started. A running terminal is never restarted unless the user asks. */
const started = new Set<string>();
/** Started terminals whose shell has since closed, so restarting them loses nothing. */
const exited = new Set<string>();
const running = (id: string) => started.has(id) && !exited.has(id);

/* ---------- Terminals ---------- */

// Layout work is done shortly after a change, with a timer. Screen frames are not used for this,
// because they stop while the window is hidden or covered and a terminal would then never start.
const soon = (work: () => void) => setTimeout(work, 30);

/* ---------- Speech-to-text ---------- */

/**
 * Decodes a recorded clip to the 16kHz mono samples the local Whisper model expects. Decoding only
 * needs a context to run on, not real audio output, so this never opens the hardware the way a plain
 * `AudioContext` would (and then has to wait for it to close) — that cost was paid on every utterance.
 */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const probe = new OfflineAudioContext(1, 1, 16000);
  const decoded = await probe.decodeAudioData(await blob.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

/**
 * The 16kHz samples as plain numbers for IPC, rounded to 4 decimals. That is far finer than Whisper
 * can hear (about -80dB), but it makes the JSON the main process forwards to the worker roughly a third
 * the size, which is serialized and parsed again on every utterance.
 */
const pcmForIpc = (pcm: Float32Array): number[] => Array.from(pcm, (value) => Math.round(value * 1e4) / 1e4);

api.on("mic:status", (status: { status: string; percent?: number; message?: string }) => {
  if (status.status === "downloading") toast(`Downloading the local speech model… ${status.percent ?? 0}%`);
  else if (status.status === "error") toast(`Speech-to-text: ${status.message}`, true);
});

/* ---------- Recon: a local voice assistant to talk to ---------- */

// "armed" listens for the wake word "Recon". "talk" is a live conversation: everything the user says
// goes to the Manager terminal and each of its messages is read aloud, until the user says "that's all"
// or stays quiet for a while. "Turn off the mic" turns the whole feature off.
type VoicePhase = "idle" | "armed" | "talk";
let voicePhase: VoicePhase = "idle";
/** The terminal the Manager answers through (it needs one to send to); its messages there are spoken. */
let voiceAnchorId = "";
let voiceStream: MediaStream | null = null;
let voiceCtx: AudioContext | null = null;
let voiceAnalyser: AnalyserNode | null = null;
let voiceWatchTimer = 0;
let voiceRecorder: MediaRecorder | null = null;
let voiceChunks: BlobPart[] = [];
let voiceRecording = false;
let voiceUtteranceStart = 0;
let voiceLastLoud = 0;
let voiceReplyPending: { id: string; text: string } | null = null;
/** Things said to the Manager that it has not answered yet. */
let voiceWaiting = 0;
/** When the conversation last had something in it (the user talking or an answer read out). */
let voiceLastActive = 0;
/** No recording starts before this, so the assistant's own voice is not heard as the user's. */
let voiceQuietUntil = 0;

/** Root-mean-square loudness of a frame, 0 (silence) upward; a cheap, fully local stand-in for real VAD. */
const VOICE_RMS_ON = 0.025;
const VOICE_RMS_OFF = 0.015;
/**
 * Silence that ends an utterance: nothing is transcribed until it has passed, so it is felt on every turn.
 * In a conversation it is longer, since people pause while saying what they want. A pause right after
 * "Recon" that runs past the shorter one is not lost: the rest is recorded as the next utterance.
 */
const VOICE_SILENCE_MS = 750;
const VOICE_TALK_SILENCE_MS = 1000;
const VOICE_MAX_UTTERANCE_MS = 15000;
const VOICE_MIN_UTTERANCE_MS = 250;
/** A conversation with nothing said or answered for this long ends; "Recon" starts the next one. */
const VOICE_TALK_IDLE_MS = 45_000;
/** While the Manager is still working on something, the conversation waits longer before ending. */
const VOICE_TALK_WAITING_MS = 3 * 60_000;
/** Checked on a timer, not animation frames: those stop while the window is minimized or covered. */
const VOICE_WATCH_MS = 50;
/**
 * How long after the assistant stops speaking the microphone still ignores sound: the speakers' output
 * still draining and the room's echo. Echo cancelling does not cover speech synthesis, so this stays.
 */
const VOICE_ECHO_MS = 350;
/** Whether a recording is being transcribed or sent, shown so a pause after speaking does not look like nothing happened. */
let voiceBusy = 0;

function voiceLog(text: string, className = "line"): void {
  const log = $("voiceLog");
  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  log.append(line);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 30) log.firstChild?.remove();
}

function voiceSetState(phase: VoicePhase): void {
  voicePhase = phase;
  const state = $("voiceState");
  state.textContent = phase === "talk"
    ? (voiceBusy ? "Talking · got it…" : voiceWaiting ? "Talking · Manager is working…" : "Talking · listening")
    : phase === "armed" ? 'Say "Recon"' : "Off";
  state.className = phase === "talk" ? "talk" : phase === "armed" ? "armed" : "dim";
  $("voiceToggle").classList.toggle("talking", phase === "talk");
  $("voice").classList.toggle("talk", phase === "talk");
}

/** Reads text aloud. Answers queue up behind each other; `now` cuts off whatever is being said first. */
function voiceSpeak(text: string, now = false): void {
  try {
    if (now) speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = voicePick();
    if (voice) utterance.voice = voice;
    // A touch lower and more measured than the default: calm, like a butler.
    utterance.pitch = 0.85;
    utterance.rate = 0.98;
    // Speech synthesis cannot be listened to, so the orb is driven by its word boundaries instead.
    utterance.onstart = () => { orbKick = 1; };
    utterance.onboundary = () => { orbKick = Math.min(1, orbKick + 0.7); };
    speechSynthesis.speak(utterance);
  } catch {
    // speech synthesis is unavailable; the panel's text is still there to read
  }
}

/**
 * Recon's voice, JARVIS-like: a British man when this computer has one (Windows: Settings > Time &
 * Language > Speech > Add voices > English (United Kingdom) adds George), otherwise another male
 * English voice, otherwise the default. The list fills in after startup, so it is looked up on use.
 */
const VOICE_PREFERENCE = [/george/i, /ryan/i, /thomas/i, /uk english male/i, /en-gb.*\bmale\b/i, /\bmark\b/i, /\bdavid\b/i, /\bguy\b/i];
function voicePick(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  for (const pattern of VOICE_PREFERENCE) {
    const match = voices.find((v) => pattern.test(`${v.name} ${v.lang}`));
    if (match) return match;
  }
  return voices.find((v) => v.lang.toLowerCase() === "en-gb") ?? null;
}

/* ---------- Recon's orb: a circular wave that moves with whoever is talking ---------- */

type OrbMode = "armed" | "listen" | "think" | "speak";
/** Points around the wave; the left half mirrors the right, low pitches at the top. */
const ORB_POINTS = 128;
const orbLevels = new Float32Array(ORB_POINTS / 2);
const orbTarget = new Float32Array(ORB_POINTS / 2);
let orbBins: Uint8Array<ArrayBuffer> | null = null;
let orbFrame = 0;
let orbLastDraw = 0;
let orbSpin = 0;
/** Jumps on each word Recon says and dies away, so its voice has a rhythm on the orb. */
let orbKick = 0;
let orbColors: Record<OrbMode, string> | null = null;
const orbStill = matchMedia("(prefers-reduced-motion: reduce)").matches;

function orbStart(): void {
  if (orbFrame) return;
  const css = getComputedStyle(document.documentElement);
  const color = (name: string) => css.getPropertyValue(name).trim();
  orbColors = { armed: color("--open"), listen: color("--accent"), think: color("--topic"), speak: color("--recon") };
  orbLevels.fill(0);
  orbFrame = requestAnimationFrame(orbDraw);
}

function orbStop(): void {
  cancelAnimationFrame(orbFrame);
  orbFrame = 0;
  const canvas = $("voiceOrb") as HTMLCanvasElement;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

function orbRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function orbMode(speaking: boolean): OrbMode {
  if (speaking) return "speak";
  if (voicePhase !== "talk") return "armed";
  return voiceBusy || (voiceWaiting && !voiceRecording) ? "think" : "listen";
}

/** A closed, smooth curve through the points: each corner becomes a curve through the midpoints. */
function orbPath(ctx: CanvasRenderingContext2D, xs: number[], ys: number[]): void {
  const n = xs.length;
  ctx.beginPath();
  ctx.moveTo((xs[n - 1] + xs[0]) / 2, (ys[n - 1] + ys[0]) / 2);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    ctx.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[next]) / 2, (ys[i] + ys[next]) / 2);
  }
  ctx.closePath();
}

function orbDraw(time: number): void {
  orbFrame = 0;
  if (voicePhase === "idle" || !orbColors) return;
  orbFrame = requestAnimationFrame(orbDraw);
  let speaking = false;
  try { speaking = speechSynthesis.speaking; } catch { /* unavailable */ }
  const mode = orbMode(speaking);
  // Waiting for "Recon" can last all day: a calm ring at a lower frame rate is enough then.
  if (mode === "armed" && !voiceRecording && time - orbLastDraw < 66) return;
  const dt = Math.min(0.1, (time - orbLastDraw) / 1000);
  orbLastDraw = time;
  const canvas = $("voiceOrb") as HTMLCanvasElement;
  const size = canvas.clientWidth;
  if (!size) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const half = orbLevels.length;
  if (mode === "speak") {
    orbKick = Math.max(0.25, orbKick * Math.pow(0.08, dt));
    for (let i = 0; i < half; i++) {
      const wave = Math.abs(Math.sin(time / 110 + i * 0.45) * Math.sin(time / 260 - i * 0.19));
      orbTarget[i] = orbKick * (0.25 + 0.75 * wave) * (1 - (i / half) * 0.5);
    }
  } else if (voiceAnalyser) {
    if (!orbBins || orbBins.length !== voiceAnalyser.frequencyBinCount) orbBins = new Uint8Array(voiceAnalyser.frequencyBinCount);
    voiceAnalyser.getByteFrequencyData(orbBins);
    // Speech sits roughly between 90 Hz and 3 kHz; the bins are spread so low pitches get more of the ring.
    const hz = voiceAnalyser.context.sampleRate / voiceAnalyser.fftSize;
    const low = Math.max(1, Math.round(90 / hz));
    const span = Math.round(3000 / hz) - low;
    const gain = mode === "armed" ? 0.45 : mode === "think" ? 0.3 : 1;
    for (let i = 0; i < half; i++) {
      const value = orbBins[low + Math.floor(span * Math.pow(i / half, 1.5))] / 255;
      orbTarget[i] = Math.max(0, (value - 0.3) / 0.7) * gain;
    }
  } else orbTarget.fill(0);
  let level = 0;
  for (let i = 0; i < half; i++) {
    // Each point leans on its neighbours, so a voice's separate harmonics read as one wave, not spikes.
    const target = (orbTarget[Math.max(0, i - 1)] + orbTarget[i] * 2 + orbTarget[Math.min(half - 1, i + 1)]) / 4;
    // Rises fast, falls slowly, like a VU meter.
    const rate = target > orbLevels[i] ? 0.55 : 0.14;
    orbLevels[i] += (target - orbLevels[i]) * rate;
    level += orbLevels[i] / half;
  }

  const color = orbColors[mode];
  const c = size / 2;
  const radius = size * 0.27;
  const reach = size * 0.13;
  if (!orbStill) orbSpin += dt * (mode === "think" ? 2.6 : 0.25 + level * 1.5);

  // The HUD: an outer ring of ticks turning slowly, and two arcs turning the other way.
  ctx.lineCap = "round";
  ctx.strokeStyle = orbRgba(color, 0.22);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.47, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2 + orbSpin * 0.4;
    const long = i % 6 === 0;
    const r1 = size * 0.47 - (long ? size * 0.045 : size * 0.022);
    ctx.strokeStyle = orbRgba(color, long ? 0.5 : 0.22);
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.lineTo(c + Math.cos(a) * size * 0.47, c + Math.sin(a) * size * 0.47);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  for (let k = 0; k < 2; k++) {
    const a = -orbSpin * (mode === "think" ? 1 : 0.7) + k * Math.PI;
    ctx.strokeStyle = orbRgba(color, mode === "think" ? 0.9 : 0.45);
    ctx.beginPath();
    ctx.arc(c, c, size * 0.405, a, a + (mode === "think" ? 1.4 : 0.9));
    ctx.stroke();
  }

  // The core glows brighter the louder it is.
  const core = ctx.createRadialGradient(c, c, 0, c, c, radius);
  core.addColorStop(0, orbRgba(color, 0.35 + level * 0.5));
  core.addColorStop(0.6, orbRgba(color, 0.08 + level * 0.2));
  core.addColorStop(1, orbRgba(color, 0));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(c, c, radius, 0, Math.PI * 2);
  ctx.fill();

  // The wave itself: outward with the sound, plus a fainter echo inward. A slow breath keeps it alive in silence.
  const outerX: number[] = [];
  const outerY: number[] = [];
  const innerX: number[] = [];
  const innerY: number[] = [];
  for (let i = 0; i < ORB_POINTS; i++) {
    const j = i < half ? i : ORB_POINTS - 1 - i;
    const breath = orbStill ? 0 : 0.035 * (1 + Math.sin(time / 700 + j * 0.35));
    // Half the swell is the overall loudness, so the ring grows as one and the pitches ride on top of it.
    const lift = Math.min(1, orbLevels[j] * 0.55 + level * 0.45 + breath);
    const a = (i / ORB_POINTS) * Math.PI * 2 - Math.PI / 2;
    const outer = radius + reach * lift;
    const inner = radius - reach * 0.4 * lift;
    outerX.push(c + Math.cos(a) * outer);
    outerY.push(c + Math.sin(a) * outer);
    innerX.push(c + Math.cos(a) * inner);
    innerY.push(c + Math.sin(a) * inner);
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = 8 + level * 18;
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = orbRgba(color, 0.95);
  orbPath(ctx, outerX, outerY);
  ctx.stroke();
  ctx.fillStyle = orbRgba(color, 0.06 + level * 0.12);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 1;
  ctx.strokeStyle = orbRgba(color, 0.4);
  orbPath(ctx, innerX, innerY);
  ctx.stroke();
}

/** A short tone: rising when a conversation starts, falling when it ends, a tick when something was sent. */
function voiceTone(kind: "start" | "end" | "sent"): void {
  const ctx = voiceCtx;
  if (!ctx) return;
  const notes = kind === "start" ? [660, 880] : kind === "end" ? [660, 440] : [880];
  const t = ctx.currentTime;
  notes.forEach((frequency, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, t + i * 0.11);
    gain.gain.exponentialRampToValueAtTime(0.06, t + i * 0.11 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.1);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + i * 0.11);
    osc.stop(t + i * 0.11 + 0.11);
  });
  // The tone comes out of the speakers too; it is not the user talking.
  voiceQuietUntil = Math.max(voiceQuietUntil, Date.now() + notes.length * 110 + 150);
}

/** Starts listening for "Recon". Returns false when the microphone could not be opened. */
async function voiceStart(): Promise<boolean> {
  if (voicePhase !== "idle") return true;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast("Recon could not open the microphone. Check this computer's microphone privacy settings, then click Recon.", true);
    return false;
  }
  voiceStream = stream;
  $("voiceToggle").classList.add("on");
  $("voice").hidden = false;
  $("voiceLog").textContent = "";
  $("voiceReply").hidden = true;
  voiceWaiting = 0;
  voiceSetState("armed");
  const ctx = new AudioContext();
  voiceCtx = ctx;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  voiceAnalyser = analyser;
  api.send("voice:listening", true);
  voiceWatchTimer = window.setInterval(voiceWatch, VOICE_WATCH_MS);
  orbStart();
  // Chromium lists the installed voices only once speech has been used, so the first answer would be
  // read in the default voice instead of Recon's. A silent, empty sentence loads the list now.
  try {
    const warmUp = new SpeechSynthesisUtterance(" ");
    warmUp.volume = 0;
    speechSynthesis.speak(warmUp);
  } catch {
    // speech synthesis is unavailable; answers are still shown as text
  }
  // The speech model loads on its first request, which would otherwise make the first "Recon" wait
  // seconds for it. A tenth of a second of silence starts it now; whatever it hears there is dropped.
  void api.invoke("mic:transcribe", Array.from({ length: 1600 }, () => 0)).catch(() => {});
  return true;
}

function voiceStop(): void {
  if (voicePhase === "idle") return;
  clearInterval(voiceWatchTimer);
  // Also tells the main process to stop taking the Manager's messages: they now go to the terminal as usual.
  api.send("voice:listening", false);
  if (voiceRecorder && voiceRecorder.state !== "inactive") { voiceRecorder.onstop = null; voiceRecorder.stop(); }
  voiceRecorder = null;
  voiceRecording = false;
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceStream = null;
  void voiceCtx?.close();
  voiceCtx = null;
  voiceAnalyser = null;
  orbStop();
  voiceReplyPending = null;
  voiceWaiting = 0;
  voiceBusy = 0;
  $("voiceToggle").classList.remove("on");
  $("voice").hidden = true;
  $("voiceReply").hidden = true;
  try { speechSynthesis.cancel(); } catch { /* unavailable */ }
  voiceSetState("idle");
}

/** Starts a conversation: from now on everything said goes to the Manager, with no wake word. */
function voiceWake(): void {
  if (voicePhase !== "talk") {
    voiceTone("start");
    voiceLog("Listening. Talk to me; say \"that's all\" when you're done.");
  }
  voiceLastActive = Date.now();
  voiceSetState("talk");
}

/** Ends the conversation without turning the mic off: "Recon" starts the next one. */
function voiceSleep(message: string): void {
  if (voicePhase !== "talk") return;
  // A question still open ("Shall I go ahead?") ends with the conversation; it is never answered later by surprise.
  voiceFolderPending = null;
  voiceSetState("armed");
  voiceTone("end");
  voiceLog(message);
}

function voiceRms(data: Float32Array): number {
  let sum = 0;
  for (const value of data) sum += value * value;
  return Math.sqrt(sum / data.length);
}

function voiceWatch(): void {
  if (voicePhase === "idle" || !voiceAnalyser) return;
  const now = Date.now();
  // The assistant's own voice through the speakers is not the user (speech synthesis bypasses echo cancelling).
  let speaking = false;
  try { speaking = speechSynthesis.speaking; } catch { /* unavailable */ }
  if (speaking) {
    voiceQuietUntil = Math.max(voiceQuietUntil, now + VOICE_ECHO_MS);
    voiceLastActive = now;
  }
  // A conversation nobody has said anything in for a while ends by itself.
  if (voicePhase === "talk" && !voiceRecording && !speaking && now - voiceLastActive > (voiceWaiting ? VOICE_TALK_WAITING_MS : VOICE_TALK_IDLE_MS)) {
    voiceSleep('Gone quiet. Say "Recon" to talk again.');
  }
  const data = new Float32Array(voiceAnalyser.fftSize);
  voiceAnalyser.getFloatTimeDomainData(data);
  const rms = voiceRms(data);
  if (!voiceRecording) {
    if (rms > VOICE_RMS_ON && now >= voiceQuietUntil) voiceBeginUtterance();
  } else {
    if (rms > VOICE_RMS_OFF) voiceLastLoud = now;
    if (voicePhase === "talk") voiceLastActive = now;
    const silence = voicePhase === "talk" ? VOICE_TALK_SILENCE_MS : VOICE_SILENCE_MS;
    if (now - voiceUtteranceStart > VOICE_MAX_UTTERANCE_MS || now - voiceLastLoud > silence) voiceEndUtterance();
  }
}

function voiceBeginUtterance(): void {
  if (!voiceStream) return;
  voiceRecording = true;
  voiceUtteranceStart = Date.now();
  voiceLastLoud = voiceUtteranceStart;
  voiceChunks = [];
  const recorder = new MediaRecorder(voiceStream);
  recorder.ondataavailable = (event) => { if (event.data.size) voiceChunks.push(event.data); };
  recorder.start();
  voiceRecorder = recorder;
}

function voiceEndUtterance(): void {
  voiceRecording = false;
  const recorder = voiceRecorder;
  voiceRecorder = null;
  if (!recorder) return;
  const elapsed = Date.now() - voiceUtteranceStart;
  recorder.onstop = () => {
    if (elapsed >= VOICE_MIN_UTTERANCE_MS) void voiceHandleUtterance(new Blob(voiceChunks, { type: recorder.mimeType }));
  };
  recorder.stop();
}

async function voiceHandleUtterance(blob: Blob): Promise<void> {
  if (voicePhase === "idle") return;
  // Only a conversation shows it: while armed, every sound in the room is recorded and checked.
  const shown = voicePhase === "talk";
  if (shown) { voiceBusy++; voiceSetState("talk"); }
  try {
    await voiceTranscribeAndAct(blob);
  } finally {
    if (shown) {
      voiceBusy = Math.max(0, voiceBusy - 1);
      if ((voicePhase as VoicePhase) !== "idle") voiceSetState(voicePhase);
    }
  }
}

async function voiceTranscribeAndAct(blob: Blob): Promise<void> {
  try {
    const pcm = await toPcm16k(blob);
    const answer = await api.invoke("mic:transcribe", pcmForIpc(pcm));
    // Transcribing takes a moment: if the feature was turned off meanwhile, this clip is stale.
    if ((voicePhase as VoicePhase) === "idle") return;
    if (answer?.error) {
      // Surfaced so a failing speech model is visible instead of looking like the mic heard nothing.
      toast(`Recon didn't catch that: ${answer.error}`, true);
      return;
    }
    const text = String(answer?.text || "");
    if (!text) return;
    const heard: { matched: boolean; after: string; command: "off" | "sleep" | null; open: { name: string; explicit: boolean } | null } =
      await api.invoke("voice:wake", text);
    // Outside a conversation only what starts with "Recon" counts; other talk in the room is ignored.
    if (voicePhase === "armed" && !heard.matched) return;
    if (heard.command === "off") {
      voiceLog(`You: ${text}`, "heard");
      await voiceSwitch(false);
      voiceSpeak("Mic off.", true);
      toast('Recon is off. Click Recon in the top bar to turn it back on.');
      return;
    }
    if (heard.command === "sleep") {
      if (voicePhase === "talk") {
        voiceSpeak("Okay.", true);
        voiceSleep('Okay. Say "Recon" when you need me.');
      }
      return;
    }
    const wasTalking = voicePhase === "talk";
    if (!wasTalking) voiceAnchorId = active;
    voiceWake();
    const said = heard.matched ? heard.after : text;
    if (voiceFolderPending) await voiceAnswerFolder(said);
    else if (heard.open && await voiceOpenProject(said, heard.open)) return;
    else if (said.trim()) await voiceAskManager(said);
    // When the user already went on talking after a pause, "Yes?" would talk over them and into their recording.
    else if (!wasTalking && !voiceRecording) voiceSpeak("Yes?");
  } catch (error) {
    // An unexpected failure (a clip that wouldn't decode, a dropped IPC call) — surfaced so it isn't
    // mistaken for the mic simply hearing nothing; a genuinely missed utterance still just waits for the next one.
    console.error("[voice]", error);
    toast(`Recon hit an error: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

/** A project Recon was asked to open, waiting for the user's spoken "yes" since it restarts every terminal. */
let voiceFolderPending: { folder: string; name: string } | null = null;

/**
 * "Open the Ecoshift project": handled here, not by the Manager. Returns false when the name matches no
 * known project and the user did not say "project" or "folder", so the request goes to the Manager instead.
 */
async function voiceOpenProject(said: string, request: { name: string; explicit: boolean }): Promise<boolean> {
  if (!request.name) {
    voiceLog(`You: ${said}`, "heard");
    voiceSpeak("Opening the folder picker.");
    $("folder").click();
    return true;
  }
  const { folder }: { folder: string | null } = await api.invoke("voice:find-project", request.name);
  if (!folder) {
    if (!request.explicit) return false;
    voiceLog(`You: ${said}`, "heard");
    voiceLog(`No project called "${request.name}" in the brain yet.`);
    voiceSpeak(`I couldn't find a project called ${request.name}. Open it once with Choose project folder and I'll know it from then on.`);
    return true;
  }
  voiceLog(`You: ${said}`, "heard");
  const name = folder.split(/[\\/]+/).filter(Boolean).pop() ?? folder;
  if (workspace.folder && folder.toLowerCase() === workspace.folder.toLowerCase()) {
    voiceSpeak(`${name} is already open.`);
    return true;
  }
  if (openFiles.some(isDirty)) {
    voiceLog("Save or close the files with unsaved changes first.");
    voiceSpeak(`You have unsaved files open. Save them first, then ask me again.`);
    return true;
  }
  if (started.size) {
    voiceFolderPending = { folder, name };
    voiceLog(`Open ${folder}? Every terminal restarts there. Say "yes" to go ahead.`);
    voiceSpeak(`Opening ${name} restarts every terminal. Shall I go ahead?`);
    return true;
  }
  voiceSpeak(`Opening ${name}.`);
  await switchFolder(folder, true);
  return true;
}

/** The user's answer to "Shall I go ahead?": yes opens the project, anything else leaves things as they are. */
async function voiceAnswerFolder(said: string): Promise<void> {
  const pending = voiceFolderPending!;
  voiceFolderPending = null;
  voiceLog(`You: ${said}`, "heard");
  if (/^\W*(?:yes|yeah|yep|sure|ok(?:ay)?|go ahead|do it|please do|confirm(?:ed)?|affirmative)\b/i.test(said)) {
    voiceSpeak(`Opening ${pending.name}.`);
    await switchFolder(pending.folder, true);
  } else {
    voiceLog("Left the project as it is.");
    voiceSpeak("Very well, I'll leave it.");
  }
}

async function voiceAskManager(command: string): Promise<void> {
  voiceLog(`You: ${command}`, "heard");
  const result = await api.invoke("voice:ask", voiceAnchorId, command);
  if (voicePhase === "idle") return;
  if (result?.error) {
    voiceLog(result.error);
    voiceSpeak(result.error);
    return;
  }
  voiceAnchorId = result.anchor;
  voiceWaiting++;
  voiceLastActive = Date.now();
  voiceTone("sent");
  voiceSetState("talk");
}

api.on("voice:reply", (id: string, text: string, spoken?: string) => {
  if (voicePhase === "idle") return;
  voiceWaiting = Math.max(0, voiceWaiting - 1);
  // Kept to insert into the terminal if wanted; the conversation does not wait for it.
  voiceReplyPending = { id, text };
  $("voiceReplyText").textContent = text;
  $("voiceReply").hidden = false;
  voiceLog(`Manager: ${text.length > 240 ? `${text.slice(0, 240)}…` : text}`, "answer");
  // An answer opens the conversation again, so the user can answer back without saying "Recon".
  voiceWake();
  voiceSpeak(spoken || text);
});

/** The user's own switch: it is remembered, and Recon starts listening with the app while it is on. */
async function voiceSwitch(on: boolean): Promise<void> {
  if (on && !(await voiceStart())) return;
  if (!on) voiceStop();
  workspace.voiceOn = on;
  api.invoke("ui:save", { voiceOn: on });
}
$("voiceToggle").onclick = () => void voiceSwitch(voicePhase === "idle");
$("voiceClose").onclick = () => void voiceSwitch(false);
// Clicking the state starts or ends a conversation by hand, for when saying "Recon" is not convenient.
$("voiceState").onclick = $("voiceOrb").onclick = () => {
  if (voicePhase === "armed") {
    voiceAnchorId = active;
    voiceWake();
  } else if (voicePhase === "talk") voiceSleep('Paused. Say "Recon" to talk again.');
};
$("voiceHush").onclick = () => {
  try { speechSynthesis.cancel(); } catch { /* unavailable */ }
};
$("voiceInsert").onclick = async () => {
  if (!voiceReplyPending) return;
  const { id, text } = voiceReplyPending;
  // Pasted on one line, not submitted: the user still presses Enter themselves. The main process strips
  // anything in the Manager's text that could end the paste early, and refuses while Claude Code is not
  // running there; the answer then stays here to insert later.
  const pasted = await api.invoke("term:paste", id, text, true);
  if (pasted?.error) return toast(pasted.error, true);
  if (voiceReplyPending?.id !== id || voiceReplyPending.text !== text) return;
  select(id);
  voiceReplyPending = null;
  $("voiceReply").hidden = true;
};
$("voiceDiscard").onclick = () => {
  voiceReplyPending = null;
  $("voiceReply").hidden = true;
};

function makePanel(profile: Profile): void {
  // `profile` is this call's snapshot; workspace is replaced wholesale after every IPC round trip
  // (a rename included), so anything shown at click time must look the current one up instead.
  const now = () => workspace.profiles.find((p) => p.id === profile.id) ?? profile;
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
  name.title = `${profile.name} (double-click to rename)`;
  name.ondblclick = () => startRename(profile.id, name);
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.textContent = profile.kind === "ollama" ? `offline · ${profile.model}` : profile.kind === "free" ? "free AI providers" : profile.configDir ? "own sign-in" : "your normal Claude Code sign-in";
  const eye = document.createElement("button");
  eye.className = "icon eye";
  eye.title = "Show this account's email";
  eye.textContent = "👁";
  eye.hidden = profile.kind === "ollama" || profile.kind === "free";
  eye.onclick = () => {
    if (revealedEmails.has(profile.id)) revealedEmails.delete(profile.id);
    else revealedEmails.add(profile.id);
    showNetwork();
  };
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  const restart = document.createElement("button");
  restart.className = "icon";
  restart.title = "Restart this terminal";
  restart.textContent = "↻";
  restart.onclick = () => {
    if (running(profile.id) && !confirm(`Restart ${now().name}'s terminal? What is running there now is closed.`)) return;
    start(profile.id);
  };
  const remove = document.createElement("button");
  remove.className = "icon remove";
  remove.title = "Remove this profile from the workspace";
  remove.textContent = "✕";
  remove.onclick = async () => {
    if (!confirm(`Remove ${now().name}? Its terminal closes. Its sign-in and past sessions stay on disk.`)) return;
    const answer = await api.invoke("profile:remove", profile.id);
    if (answer.error) return toast(answer.error, true);
    workspace = answer;
    render();
  };
  // The terminal's job. Claude Code is told about it when the terminal starts.
  const role = document.createElement("select");
  role.className = "small role";
  role.title = "This terminal's job. Manager hands out work, Builder writes, Reviewer reviews, Tester tests; they hand work to each other.";
  role.dataset.profile = profile.id;
  fillRoleSelect(role, profile.role ?? "");
  role.hidden = profile.kind === "free";
  role.onchange = async () => {
    if (role.value === MANAGE_ROLES) {
      role.value = now().role ?? "";
      return openRoles(now().role);
    }
    workspace = await api.invoke("profile:role", profile.id, role.value);
    if (started.has(profile.id) && confirm(`${now().name} gets its new role when its terminal restarts. Restart it now? What is running there is closed.`)) start(profile.id);
  };
  // Messages from other terminals wait while the user is typing here; this shows them and sends one now.
  const waiting = document.createElement("button");
  waiting.className = "waiting";
  waiting.hidden = true;
  waiting.onclick = () => api.invoke("term:deliver-now", profile.id);
  bar.append(dot, name, hint, eye, spacer, waiting, role, restart, remove);
  draggableTerminal(bar, profile.id);
  const body = document.createElement("div");
  body.className = "term";
  panel.append(bar, body);
  // Under the terminal: its own weekly and session usage, and whether Claude Code said it hit a limit.
  const usageBar = document.createElement("div");
  usageBar.className = "usagebar";
  usageBar.dataset.profile = profile.id;
  usageBar.hidden = (profile.kind ?? "claude") !== "claude";
  panel.append(usageBar);
  showUsageBars();
  $("panels").append(panel);

  const term = new Terminal({ cursorBlink: true, fontFamily: "Consolas, 'Cascadia Mono', Menlo, monospace", fontSize: workspace.fontSize ?? 13,
    theme: { background: "#000000" }, scrollback: 5000 });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(body);
  // Ctrl+Alt+1..6, Ctrl+Alt+B, Ctrl+Alt+F and Ctrl+Alt+0 (text size back to normal) belong to the app
  // (switch terminal, show or hide the brain or the files), not to the terminal.
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => !(appShortcut(event) && /^[0-6bef]$/i.test(event.key)));
  term.onData((data: string) => api.send("term:input", profile.id, data));
  term.onResize(({ cols, rows }: { cols: number; rows: number }) => api.send("term:resize", profile.id, cols, rows));
  // A click on the bar's own controls (the role list above all) must keep focus there: moving it to
  // the terminal would close the list the moment it opens.
  panel.addEventListener("mousedown", (event) => select(profile.id, !(event.target as HTMLElement).closest("select, input, button")));
  terms.set(profile.id, { term, fit, panel });
  // The terminal follows its own box, not only the window: the usage bar under it can appear or change
  // height after the first fit, and the last row would otherwise end up hidden behind it.
  new ResizeObserver(() => fitSoon()).observe(body);
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

/** Swaps a terminal's name for an inline input. Enter saves (validated like adding a profile), Esc cancels. */
function startRename(id: string, nameEl: HTMLSpanElement): void {
  const before = nameEl.textContent ?? "";
  const input = document.createElement("input");
  input.className = "name-edit";
  input.value = before;
  input.maxLength = 30;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const finish = async (commit: boolean): Promise<void> => {
    if (settled) return;
    settled = true;
    const value = input.value.trim();
    input.replaceWith(nameEl);
    if (!commit || !value || value === before) return;
    const answer = await api.invoke("profile:rename", id, value);
    if (answer.error) return toast(answer.error, true);
    workspace = answer;
    render();
    const saved = workspace.profiles.find((p) => p.id === id)?.name ?? value;
    if (running(id)) toast(`Renamed. ${saved} keeps signing messages to other terminals as "${before}" until it restarts.`);
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
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
  exited.delete(id);
  entry.term.reset();
  fitAll();
  api.send("term:start", id, entry.term.cols, entry.term.rows);
}

function fitAll(): void {
  for (const { fit, panel } of terms.values()) if (panel.offsetParent) fit.fit();
}

/* ---------- Split layout: drag a terminal beside another one, and drag the gaps to resize ---------- */

let splitTree: SplitNode | null = null;
/** Width of the gap between two panes, which is also the handle that resizes them. Matches .gutter. */
const GUTTER_PX = 8;
/** A pane can be resized down to this, but not further: below it a terminal is no use. */
const MIN_PANE_PX = 140;
/** How far the pointer moves on a terminal's bar before it counts as a drag rather than a click. */
const DRAG_START_PX = 6;
let fitFrame = 0;

/** Refits the terminals at most once per frame while a gap is dragged. */
function fitSoon(): void {
  if (!fitFrame) fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitAll(); });
}

function saveSplit(): void {
  workspace.split = splitTree;
  api.invoke("ui:save", { split: splitTree });
}

/** Puts the panels in place: as the split tree in grid mode, or one after another for tabs. */
function layoutPanels(): void {
  const host = $("panels");
  const ids = workspace.profiles.map((p) => p.id);
  const grid = workspace.layout !== "tabs" && !!workspace.folder;
  host.classList.toggle("split", grid);
  if (!grid) {
    host.replaceChildren(...ids.map((id) => terms.get(id)!.panel));
    for (const id of ids) terms.get(id)!.panel.style.flex = "";
    return;
  }
  splitTree = splitReconcile(splitTree ?? workspace.split, ids);
  host.replaceChildren(...(splitTree ? [buildSplit(splitTree, 1)] : []));
  if (JSON.stringify(splitTree) !== JSON.stringify(workspace.split ?? null)) saveSplit();
  soon(fitAll);
}

function buildSplit(node: SplitNode, size: number): HTMLElement {
  if (isSplitLeaf(node)) {
    const panel = terms.get(node.id)!.panel;
    panel.style.flex = `${size} 1 0`;
    return panel;
  }
  const box = document.createElement("div");
  box.className = `split ${node.dir}`;
  box.style.flex = `${size} 1 0`;
  node.children.forEach((child, i) => {
    if (i) box.append(makeGutter(node, i - 1, box));
    box.append(buildSplit(child, node.sizes[i]));
  });
  return box;
}

/** The gap between panes i and i + 1 of a split: dragging it moves room from one to the other. */
function makeGutter(branch: SplitBranch, i: number, box: HTMLElement): HTMLElement {
  const gutter = document.createElement("div");
  gutter.className = `gutter ${branch.dir}`;
  gutter.title = "Drag to resize";
  gutter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    gutter.setPointerCapture(event.pointerId);
    gutter.classList.add("dragging");
    const across = branch.dir === "row";
    const rect = box.getBoundingClientRect();
    const items = [...box.children].filter((el) => !el.classList.contains("gutter")) as HTMLElement[];
    const length = (across ? rect.width : rect.height) - (items.length - 1) * GUTTER_PX;
    const start = across ? event.clientX : event.clientY;
    const [a, b] = [branch.sizes[i], branch.sizes[i + 1]];
    const min = Math.min(MIN_PANE_PX / length, (a + b) / 2);
    const move = (e: PointerEvent) => {
      const first = Math.max(min, Math.min(a + ((across ? e.clientX : e.clientY) - start) / length, a + b - min));
      branch.sizes[i] = first;
      branch.sizes[i + 1] = a + b - first;
      items[i].style.flex = `${first} 1 0`;
      items[i + 1].style.flex = `${a + b - first} 1 0`;
      fitSoon();
    };
    const stop = () => {
      gutter.classList.remove("dragging");
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", stop);
      gutter.removeEventListener("pointercancel", stop);
      fitAll();
      saveSplit();
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", stop);
    gutter.addEventListener("pointercancel", stop);
  });
  return gutter;
}

/** The terminal and zone under the pointer while terminal `id` is dragged, or null where it cannot land. */
function dropAt(x: number, y: number, id: string): { target: string; zone: DropZone; rect: DOMRect } | null {
  const panel = document.elementFromPoint(x, y)?.closest("#panels .panel") as HTMLElement | null;
  if (!panel || panel.dataset.id === id) return null;
  const rect = panel.getBoundingClientRect();
  const zone = splitZone(x - rect.left, y - rect.top, rect.width, rect.height);
  // In tabs only one terminal shows, so swapping with it would change nothing visible.
  if (zone === "center" && workspace.layout === "tabs") return null;
  return { target: panel.dataset.id!, zone, rect };
}

function showDropHint(drop: ReturnType<typeof dropAt>): void {
  const hint = $("dropHint");
  hint.hidden = !drop;
  if (!drop) return;
  const { left, top, width, height } = drop.rect;
  const area = {
    left: [left, top, width / 2, height], right: [left + width / 2, top, width / 2, height], top: [left, top, width, height / 2],
    bottom: [left, top + height / 2, width, height / 2], center: [left, top, width, height],
  }[drop.zone];
  Object.assign(hint.style, { left: `${area[0]}px`, top: `${area[1]}px`, width: `${area[2]}px`, height: `${area[3]}px` });
  hint.textContent = drop.zone === "center" ? "Swap" : "";
}

/**
 * Lets terminal `id` be dragged by `handle` (its bar, or its tab) onto another terminal: onto one side
 * of it to sit beside it, onto its middle to swap places. From tabs, it switches to the split layout.
 */
function draggableTerminal(handle: HTMLElement, id: string): void {
  let draggedAt = 0;
  // A drag that ends on its own tab is not also a click on it.
  handle.addEventListener("click", (event) => {
    if (Date.now() - draggedAt < 300) event.stopImmediatePropagation();
  }, true);
  handle.addEventListener("pointerdown", (event) => {
    const control = (event.target as HTMLElement).closest("button, select, input");
    if (event.button !== 0 || (control && control !== handle) || !workspace.folder) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    let dragging = false;
    let drop: ReturnType<typeof dropAt> = null;
    const ghost = $("dragGhost");
    const move = (e: PointerEvent) => {
      if (!dragging) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_START_PX) return;
        dragging = true;
        handle.setPointerCapture(e.pointerId);
        document.body.classList.add("dragging-terminal");
        terms.get(id)?.panel.classList.add("drag-source");
        ghost.textContent = workspace.profiles.find((p) => p.id === id)?.name ?? "";
        ghost.hidden = false;
      }
      Object.assign(ghost.style, { left: `${e.clientX + 14}px`, top: `${e.clientY + 14}px` });
      drop = dropAt(e.clientX, e.clientY, id);
      showDropHint(drop);
    };
    const end = (apply: boolean) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      if (!dragging) return;
      draggedAt = Date.now();
      document.body.classList.remove("dragging-terminal");
      terms.get(id)?.panel.classList.remove("drag-source");
      ghost.hidden = true;
      showDropHint(null);
      if (apply && drop) void dropTerminal(id, drop.target, drop.zone);
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !dragging) return;
      e.stopPropagation();
      end(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  });
}

async function dropTerminal(id: string, target: string, zone: DropZone): Promise<void> {
  if (workspace.layout === "tabs") {
    workspace = await api.invoke("workspace:layout", "grid");
    $("work").classList.remove("tabs");
    $("layout").textContent = "Tabs";
  }
  const ids = workspace.profiles.map((p) => p.id);
  splitTree = splitDrop(splitReconcile(splitTree ?? workspace.split, ids), id, target, zone);
  saveSplit();
  layoutPanels();
  select(id);
}

function select(id: string, focus = true): void {
  active = id;
  for (const [key, { panel }] of terms) panel.classList.toggle("active", key === id);
  for (const tab of $("tabs").children) (tab as HTMLElement).classList.toggle("active", (tab as HTMLElement).dataset.id === id);
  soon(() => {
    fitAll();
    if (focus) terms.get(id)?.term.focus();
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
    exited.delete(id);
    revealedEmails.delete(id);
    recentText.delete(id);
    limitShownAt.delete(id);
    limitStates.delete(id);
  }
  const count = workspace.profiles.length;
  $("panels").style.setProperty("--cols", String(count <= 3 ? count : Math.ceil(count / 2)));
  $("work").classList.toggle("tabs", workspace.layout === "tabs");
  $("layout").textContent = workspace.layout === "tabs" ? "Grid" : "Tabs";
  $("folder").textContent = workspace.folder ? workspace.folder.split(/[\\/]/).pop()! : "Choose project folder";
  $("folder").title = workspace.folder || "Folder every terminal starts in";
  $("tabs").textContent = "";
  for (const profile of workspace.profiles) {
    if (!terms.has(profile.id)) makePanel(profile);
    else {
      // makePanel only runs for a new panel, so a rename has to be applied to the existing one by hand.
      const nameEl = terms.get(profile.id)!.panel.querySelector(".name") as HTMLElement;
      if (nameEl.textContent !== profile.name) {
        nameEl.textContent = profile.name;
        nameEl.title = `${profile.name} (double-click to rename)`;
      }
    }
    const tab = document.createElement("button");
    tab.dataset.id = profile.id;
    tab.textContent = profile.name;
    tab.style.borderTop = `2px solid ${profile.color}`;
    tab.onclick = () => select(profile.id);
    draggableTerminal(tab, profile.id);
    $("tabs").append(tab);
  }
  for (const { panel } of terms.values()) {
    panel.hidden = !workspace.folder;
    (panel.querySelector(".remove") as HTMLElement).hidden = count <= 1;
  }
  layoutPanels();
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
  if (!$("files").hidden && treeRoot !== workspace.folder) loadTree();
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

// A message for this terminal is waiting because the user is typing in it.
api.on("term:waiting", (id: string, count: number) => {
  const button = terms.get(id)?.panel.querySelector(".waiting") as HTMLButtonElement | null;
  if (!button) return;
  button.hidden = !count;
  button.textContent = `✉ ${count}`;
  button.title = `${count === 1 ? "A message" : `${count} messages`} from another terminal ${count === 1 ? "waits" : "wait"} until you send or clear what you are typing here. Click to send ${count === 1 ? "it" : "the first one"} now.`;
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
  noteLimitState(id, tail);
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
  custom: { baseUrl: string; model: string; hasKey: boolean };
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
    note.textContent = `${provider.note} Get a key: `;
    const link = document.createElement("a");
    link.href = provider.keyUrl;
    link.textContent = provider.keyUrl;
    link.title = "Open this page in your browser";
    link.onclick = (event) => {
      event.preventDefault();
      api.invoke("free:key-page", provider.id);
    };
    note.append(link);
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
  // One provider of the user's own choosing, tried after the ones above.
  const own = document.createElement("div");
  own.className = "provider";
  own.dataset.id = "custom";
  const ownHead = document.createElement("div");
  ownHead.className = "head";
  const ownName = document.createElement("b");
  ownName.textContent = "Your own provider";
  const ownNote = document.createElement("span");
  ownNote.className = "dim";
  ownNote.textContent = "Any service with an OpenAI-compatible API, including one on your own computer or network. Tried last.";
  ownHead.append(ownName, ownNote);
  const ownUrl = document.createElement("input");
  ownUrl.className = "baseurl";
  ownUrl.placeholder = "Address, for example http://localhost:1234/v1";
  ownUrl.value = info.custom.baseUrl;
  ownUrl.style.gridColumn = "1 / -1";
  const ownKey = document.createElement("input");
  ownKey.type = "password";
  ownKey.className = "key";
  ownKey.placeholder = info.custom.hasKey ? "Key saved. Type a new one to replace it." : "API key, if it needs one";
  const ownModel = document.createElement("input");
  ownModel.className = "model";
  ownModel.placeholder = "Model name";
  ownModel.value = info.custom.model;
  const ownResult = document.createElement("div");
  ownResult.className = "outcome dim";
  own.append(ownHead, ownUrl, ownKey, ownModel, ownResult);
  list.append(own);
  $("freeDialog").hidden = false;
}

function freeEntries(): { id: string; key?: string; model: string; baseUrl?: string }[] {
  return [...document.querySelectorAll<HTMLElement>("#providers .provider")].map((box) => {
    const key = (box.querySelector(".key") as HTMLInputElement).value;
    const baseUrl = (box.querySelector(".baseurl") as HTMLInputElement | null)?.value;
    return { id: box.dataset.id!, model: (box.querySelector(".model") as HTMLInputElement).value, ...(key ? { key } : {}), ...(baseUrl !== undefined ? { baseUrl } : {}) };
  });
}

$("free").onclick = () => openFreeDialog();
$("freeCancel").onclick = () => ($("freeDialog").hidden = true);
// Tests exactly what is in the form, without saving it: testing keys must have no side effect.
$("freeTest").onclick = async () => {
  $("freeError").textContent = "";
  for (const box of document.querySelectorAll<HTMLElement>("#providers .outcome")) box.textContent = "Testing...";
  const results: Record<string, string> = await api.invoke("free:test", freeEntries());
  for (const box of document.querySelectorAll<HTMLElement>("#providers .provider")) {
    const line = box.querySelector(".outcome") as HTMLElement;
    const outcome = results[box.dataset.id!];
    line.textContent = outcome ?? "No key entered.";
    line.className = "outcome " + (outcome === "working" ? "good" : outcome ? "bad" : "dim");
  }
};
$("freeForm").onsubmit = async (event) => {
  event.preventDefault();
  const before = freeContained;
  const saved = await api.invoke("free:save", freeEntries(), ($("contained") as HTMLInputElement).checked);
  if (saved.error) {
    $("freeError").textContent = saved.error;
    $("freeError").scrollIntoView({ block: "nearest" });
    return;
  }
  workspace = saved;
  freeContained = ($("contained") as HTMLInputElement).checked;
  $("freeDialog").hidden = true;
  render();
  showFreeHint();
  const free = workspace.profiles.find((p) => p.kind === "free");
  if (free && before !== freeContained && started.has(free.id)) {
    toast("The container setting changed. Restart the free terminal (↻) for it to take effect.");
  }
};
/** Hides most of an email so it can be shown on screen without exposing it, e.g. "e••••@gmail.com". */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "•".repeat(email.length);
  return email[0] + "••••" + email.slice(at);
}
/** Each Claude profile's title bar says which account it is signed in with, and warns about duplicates. */
function showNetwork(): void {
  $("net").hidden = isOnline;
  for (const profile of workspace?.profiles ?? []) {
    const panel = terms.get(profile.id)?.panel;
    const hint = panel?.querySelector(".hint") as HTMLElement | null;
    if (!hint || profile.kind === "ollama" || profile.kind === "free") continue;
    const email = accounts[profile.id];
    const twin = email ? workspace.profiles.find((p) => p.id !== profile.id && accounts[p.id] === email) : undefined;
    hint.classList.toggle("warn", !isOnline || !!twin);
    const revealed = revealedEmails.has(profile.id);
    const shown = email ? (revealed ? email : maskEmail(email)) : "not signed in yet";
    hint.textContent = shown + (twin ? ` · same account as ${twin.name}` : "") + (isOnline ? "" : " · needs internet");
    hint.title = twin
      ? "Both profiles use the same Claude account. To change this one: type /logout, then /login, and approve in a private browser window signed in to the other account."
      : "";
    const eye = panel?.querySelector(".eye") as HTMLButtonElement | null;
    if (eye) {
      eye.hidden = !email;
      eye.textContent = revealed ? "🙈" : "👁";
      eye.title = revealed ? "Hide this account's email" : "Show this account's email";
    }
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

api.on("term:exit", (id: string) => exited.add(id) && terms.get(id)?.term.write("\r\n\x1b[90m[The terminal closed. Press ↻ to start it again.]\x1b[0m\r\n"));

$("folder").onclick = async () => {
  // Picked first, so a user who cancels the native picker is never asked to confirm a restart first.
  const folder: string | null = await api.invoke("workspace:pick-folder");
  if (folder) await switchFolder(folder);
};

/** Makes `folder` the project: every terminal restarts there. `confirmed` when the user already agreed by voice. */
async function switchFolder(folder: string, confirmed = false): Promise<void> {
  if (!folder || folder === workspace.folder) return;
  // Open files belong to the old folder and close with it.
  const unsaved = openFiles.filter(isDirty).length;
  if (!confirmed && unsaved && !confirm(`${unsaved} open file${unsaved === 1 ? " has" : "s have"} unsaved changes that will be lost. Change the project folder anyway?`)) return;
  if (!confirmed && started.size && !confirm("Changing the project folder restarts every terminal in the new folder. Running Claude Code sessions are closed; you can resume them later from the brain. Continue?")) return;
  // The free terminal is never auto-started by render() below, so if it was already running it
  // must be restarted by hand too, or it would keep working in the folder it had before.
  const free = workspace.profiles.find((p) => p.kind === "free");
  const freeWasRunning = !!free && started.has(free.id);
  workspace = await api.invoke("workspace:set-folder", folder);
  keepOpenList = true;
  closeAllFiles();
  keepOpenList = false;
  started.clear();
  await showKit();
  render();
  void restoreOpenFiles();
  if (freeWasRunning) start(free!.id);
  offerSharedNotes();
}
$("layout").onclick = async () => {
  workspace = await api.invoke("workspace:layout", workspace.layout === "tabs" ? "grid" : "tabs");
  $("work").classList.toggle("tabs", workspace.layout === "tabs");
  $("layout").textContent = workspace.layout === "tabs" ? "Grid" : "Tabs";
  layoutPanels();
  select(active);
};
$("toggle").onclick = () => {
  const brain = $("brain");
  brain.hidden = !brain.hidden;
  $("divider").hidden = brain.hidden;
  $("toggle").textContent = brain.hidden ? "Show brain" : "Hide brain";
  soon(() => { fitAll(); resizeMap(); });
  if (!brain.hidden) showUsage();
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
  resizeTimer = window.setTimeout(() => {
    // A brain width saved in a wider window must still leave room for the terminals.
    if (workspace?.brainWidth) setBrainWidth(workspace.brainWidth);
    fitAll();
    resizeMap();
  }, 120);
});

/* ---------- Comfort: text size, panel width, shortcuts ---------- */

const DEFAULT_FONT_SIZE = 13;
/** The A− and A+ buttons say what the text size is now. */
function showFontSize(): void {
  const size = workspace.fontSize ?? DEFAULT_FONT_SIZE;
  $("fontSize").textContent = String(size);
  $("smaller").title = `Smaller terminal text (now ${size}px). Ctrl+Alt+0 goes back to ${DEFAULT_FONT_SIZE}px.`;
  $("bigger").title = `Larger terminal text (now ${size}px). Ctrl+Alt+0 goes back to ${DEFAULT_FONT_SIZE}px.`;
}
function setFontSize(size: number): void {
  workspace.fontSize = Math.max(9, Math.min(24, size));
  for (const { term } of terms.values()) term.options.fontSize = workspace.fontSize;
  editor?.updateOptions({ fontSize: workspace.fontSize });
  diffEditor?.updateOptions({ fontSize: workspace.fontSize });
  soon(fitAll);
  showFontSize();
  toast(`Terminal text size: ${workspace.fontSize}px`);
  api.invoke("ui:save", { fontSize: workspace.fontSize });
}
$("smaller").onclick = () => setFontSize((workspace.fontSize ?? DEFAULT_FONT_SIZE) - 1);
$("bigger").onclick = () => setFontSize((workspace.fontSize ?? DEFAULT_FONT_SIZE) + 1);

function setBrainWidth(width: number): void {
  const limited = Math.max(260, Math.min(width, window.innerWidth - 320));
  const brain = $("brain");
  brain.style.flex = `0 0 ${limited}px`;
  brain.style.maxWidth = "none";
  workspace.brainWidth = limited;
}
$("divider").addEventListener("pointerdown", (event) => {
  const divider = $("divider");
  divider.setPointerCapture(event.pointerId);
  divider.classList.add("dragging");
  const move = (e: PointerEvent) => setBrainWidth(window.innerWidth - e.clientX);
  const stop = () => {
    divider.classList.remove("dragging");
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", stop);
    soon(() => { fitAll(); resizeMap(); });
    api.invoke("ui:save", { brainWidth: workspace.brainWidth });
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", stop);
});

/**
 * Ctrl+Alt with a key is one of the app's shortcuts. AltGr counts as Ctrl+Alt on Windows, but on
 * many European layouts it types characters (AltGr+7 is "{" in German), so it is left to the terminal.
 */
function appShortcut(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.altKey && !event.getModifierState("AltGraph");
}
window.addEventListener("keydown", (event) => {
  if (!appShortcut(event)) return;
  if (/^[1-6]$/.test(event.key)) {
    const profile = workspace.profiles[Number(event.key) - 1];
    if (profile) select(profile.id);
    event.preventDefault();
  } else if (event.key.toLowerCase() === "b") {
    $("toggle").click();
    event.preventDefault();
  } else if (event.key.toLowerCase() === "e") {
    if (openFiles.length) showEditor($("editor").hidden);
    event.preventDefault();
  } else if (event.key.toLowerCase() === "f") {
    showFiles($("files").hidden);
    event.preventDefault();
  } else if (event.key === "0") {
    setFontSize(DEFAULT_FONT_SIZE);
    event.preventDefault();
  }
}, true);

/* ---------- Dialogs: Esc or a click outside closes them ---------- */

const DIALOGS = ["dialog", "freeDialog", "shareDialog", "roleDialog"];
for (const id of DIALOGS) {
  $(id).addEventListener("mousedown", (event) => {
    if (event.target === $(id)) $(id).hidden = true;
  });
}
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const open = DIALOGS.map($).filter((d) => !d.hidden);
  if (!open.length) return;
  for (const dialog of open) dialog.hidden = true;
  event.preventDefault();
  terms.get(active)?.term.focus();
}, true);

/* ---------- Terminal roles ---------- */

/** The last entry of every terminal's role list opens the role manager instead of picking a role. */
const MANAGE_ROLES = "__manage";

function fillRoleSelect(select: HTMLSelectElement, value: string): void {
  select.length = 0;
  for (const option of roles) select.add(new Option(option.name, option.id));
  select.add(new Option("Manage roles…", MANAGE_ROLES));
  // A role that was deleted meanwhile shows as no role, as it is for Claude Code.
  select.value = roles.some((r) => r.id === value) ? value : "";
}

/** After roles were added, renamed or removed: every terminal's list shows the new set. */
async function refreshRoles(): Promise<void> {
  await showKit();
  for (const select of document.querySelectorAll<HTMLSelectElement>(".bar select.role")) {
    fillRoleSelect(select, workspace.profiles.find((p) => p.id === select.dataset.profile)?.role ?? "");
  }
}

interface RoleEntry { id: string; name: string; prompt: string; builtIn: boolean; usedBy: string[] }
let roleEntries: RoleEntry[] = [];
/** The role shown in the form; "" while a new role is being written. */
let roleShown = "";

function showRole(id: string): void {
  const entry = roleEntries.find((r) => r.id === id);
  roleShown = entry?.id ?? "";
  for (const button of $("roleList").querySelectorAll<HTMLButtonElement>("button")) button.classList.toggle("on", button.dataset.id === roleShown);
  const name = $("roleName") as HTMLInputElement;
  const prompt = $("rolePrompt") as HTMLTextAreaElement;
  name.value = entry?.name ?? "";
  prompt.value = entry?.prompt ?? "";
  name.readOnly = prompt.readOnly = !!entry?.builtIn;
  $("roleInfo").textContent = !entry
    ? "A new role. Give it a name and write its instructions, then save."
    : `${entry.builtIn ? "Built in, so it cannot be changed; copy it to make your own version. " : ""}${
        entry.usedBy.length ? `Used by: ${entry.usedBy.join(", ")}.` : "No terminal has this role."}`;
  $("roleError").textContent = "";
  $("roleSave").hidden = !!entry?.builtIn;
  $("roleDelete").hidden = !entry || entry.builtIn;
  $("roleCopy").hidden = !entry;
  if (!entry) name.focus();
}

async function loadRoles(selected?: string): Promise<void> {
  roleEntries = await api.invoke("role:list");
  const list = $("roleList");
  list.textContent = "";
  for (const entry of roleEntries) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = entry.id;
    const title = document.createElement("span");
    title.textContent = entry.name;
    const sub = document.createElement("span");
    sub.className = "dim";
    sub.textContent = [entry.builtIn ? "built in" : "yours", entry.usedBy.length ? `${entry.usedBy.length} terminal${entry.usedBy.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    button.append(title, sub);
    button.onclick = () => showRole(entry.id);
    list.append(button);
  }
  showRole(roleEntries.some((r) => r.id === selected) ? selected! : selected === "" ? "" : roleEntries[0]?.id ?? "");
}

async function openRoles(selected?: string): Promise<void> {
  await loadRoles(selected || undefined);
  $("roleDialog").hidden = false;
}

/** Terminals already running with a role that just changed get it only on a restart; say so. */
function roleChangedNotice(id: string): void {
  const running = workspace.profiles.filter((p) => p.role === id && started.has(p.id)).map((p) => p.name);
  if (running.length) toast(`${running.join(", ")} ${running.length === 1 ? "gets" : "get"} the changed role when restarted (↻).`);
}

/* ---------- Top bar menu ---------- */
// Roles and Team memory are set up once and rarely changed, so they sit behind ⋯ instead of in the bar.

function showMoreMenu(open: boolean): void {
  $("moreItems").hidden = !open;
  $("moreMenu").setAttribute("aria-expanded", String(open));
}
$("moreMenu").onclick = () => showMoreMenu($("moreItems").hidden);
// Picking an item, clicking elsewhere or pressing Esc closes it.
$("moreItems").addEventListener("click", () => showMoreMenu(false));
window.addEventListener("mousedown", (event) => {
  if (!$("moreItems").hidden && !(event.target as HTMLElement).closest(".menuwrap")) showMoreMenu(false);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("moreItems").hidden) {
    showMoreMenu(false);
    event.preventDefault();
  }
});

$("roles").onclick = () => openRoles();
$("roleClose").onclick = () => ($("roleDialog").hidden = true);
$("roleNew").onclick = () => showRole("");
$("roleCopy").onclick = () => {
  const entry = roleEntries.find((r) => r.id === roleShown);
  showRole("");
  if (!entry) return;
  ($("roleName") as HTMLInputElement).value = `${entry.name} copy`.slice(0, 30);
  ($("rolePrompt") as HTMLTextAreaElement).value = entry.prompt;
};
$("roleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = await api.invoke("role:save", {
    id: roleShown || undefined, name: ($("roleName") as HTMLInputElement).value, prompt: ($("rolePrompt") as HTMLTextAreaElement).value,
  });
  if (answer.error) return ($("roleError").textContent = answer.error);
  workspace = answer.workspace;
  await refreshRoles();
  await loadRoles(answer.role.id);
  roleChangedNotice(answer.role.id);
  toast(`Saved the role ${answer.role.name}.`);
});
$("roleDelete").onclick = async () => {
  const entry = roleEntries.find((r) => r.id === roleShown);
  if (!entry || entry.builtIn) return;
  const users = entry.usedBy.length ? ` ${entry.usedBy.join(", ")} will have no role (from the next restart).` : "";
  if (!confirm(`Delete the role ${entry.name}?${users}`)) return;
  const answer = await api.invoke("role:remove", entry.id);
  if (answer.error) return ($("roleError").textContent = answer.error);
  workspace = answer;
  await refreshRoles();
  await loadRoles();
};

/* ---------- Project kit ---------- */

async function showKit(): Promise<void> {
  const info: { kits: { id: string; name: string }[]; roles: { id: string; name: string }[]; kit: string; detected: string } = await api.invoke("kit:get");
  roles = info.roles;
  const select = $("kit") as HTMLSelectElement;
  select.length = 0;
  for (const kit of info.kits) select.add(new Option(`Kit: ${kit.name}`, kit.id));
  select.value = info.kit;
  select.title = `Project kit: standing instructions for this kind of project, given to Claude Code when a terminal starts. The files in this folder suggest: ${info.detected}.`;
  select.hidden = !workspace.folder;
}
$("kit").addEventListener("change", async () => {
  workspace = await api.invoke("kit:set", ($("kit") as HTMLSelectElement).value);
  if (started.size) toast("The new kit applies to terminals when they start. Restart a terminal (↻) to use it there.");
});

/* ---------- Token usage ---------- */
// Claude tokens used this week (from Monday), this month, this year and in total, counted by the main
// process from Claude Code's own transcripts. The first count can take a few seconds; later ones are quick.

interface Tokens { input: number; output: number; cacheWrite: number; cacheRead: number; total: number }
interface Limit { percent: number; resets: number }
type PlanLimits = { session: Limit | null; week: Limit | null; plan: string; at: number } | { error: string };
interface FolderUsage { week: Tokens; month: Tokens; year: Tokens; all: Tokens; since: number;
  session: { start: number; end: number; tokens: Tokens } | null; last: number; limits?: PlanLimits }
interface Account { dir: string; names: string[]; email: string; usage: FolderUsage | null; limits: PlanLimits }
interface UsageSummary { week: Tokens; month: Tokens; year: Tokens; all: Tokens; since: number; accounts: Account[]; profiles: Record<string, FolderUsage> }

const USAGE_REFRESH_MS = 60_000;
const USAGE_OPEN_KEY = "usageOpen";

/** 1234 -> "1.2K", 8212900000 -> "8.2B": short enough for a tile. */
function shortCount(n: number): string {
  for (const [size, unit] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (n >= size) return `${(n / size).toFixed(n / size < 100 ? 1 : 0).replace(/\.0$/, "")}${unit}`;
  }
  return String(n);
}

let usageBusy = false;
let lastUsage: UsageSummary | null = null;
async function showUsage(): Promise<void> {
  if (usageBusy) return;
  usageBusy = true;
  const state = $("usageState");
  if (!$("usageTiles").childElementCount) state.textContent = "Counting…";
  try {
    const usage: UsageSummary | { error: string } = await api.invoke("usage:get");
    if ("error" in usage) {
      state.textContent = "Could not count";
      state.title = usage.error;
      return;
    }
    lastUsage = usage;
    showUsageBars();
    // The tiles are only redrawn while they can be seen; they catch up when shown again.
    if ($("brain").hidden || !($("usage") as HTMLDetailsElement).open) return;
    const tiles = $("usageTiles");
    tiles.textContent = "";
    const periods: [keyof Omit<UsageSummary, "since" | "profiles" | "accounts">, string][] = [["week", "This week"], ["month", "This month"], ["year", "This year"], ["all", "Total"]];
    for (const [key, name] of periods) {
      const t = usage[key];
      const tile = document.createElement("div");
      tile.className = `usage-tile ${key}`;
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = name;
      const value = document.createElement("div");
      value.className = "value";
      value.textContent = shortCount(t.total);
      const split = document.createElement("div");
      split.className = "split";
      split.textContent = `${shortCount(t.output)} out · ${shortCount(t.input + t.cacheWrite)} in`;
      const exact = (n: number) => n.toLocaleString();
      tile.title = `${name}: ${exact(t.total)} tokens\n` +
        `Output (Claude's answers): ${exact(t.output)}\nInput: ${exact(t.input)}\n` +
        `Written to cache: ${exact(t.cacheWrite)}\nRead from cache: ${exact(t.cacheRead)}\n` +
        "The total leaves out cache reads: each turn reads the whole conversation back from the cache, so they would be most of it.";
      tile.append(label, value, split);
      tiles.append(tile);
    }
    showAccounts(usage.accounts ?? []);
    state.textContent = usage.since ? `since ${new Date(usage.since).toLocaleDateString()}` : "nothing yet";
    state.title = "";
  } finally {
    usageBusy = false;
  }
}
/** "48%" with when it starts over, for a limit Anthropic reported. */
function limitText(limit: Limit | null): string {
  if (!limit) return "–";
  return `${Math.round(limit.percent)}%`;
}
function resetText(limit: Limit | null): string {
  if (!limit?.resets) return "";
  const at = new Date(limit.resets);
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * One row per Claude account: its session and weekly limit as Anthropic reports them (what the Claude
 * app shows, counting everything the account did anywhere), then its tokens per period counted from
 * this computer's Claude Code transcripts.
 */
function showAccounts(accounts: Account[]): void {
  const table = $("usageAccounts") as HTMLTableElement;
  table.hidden = !accounts.length;
  const body = table.tBodies[0];
  body.textContent = "";
  for (const account of accounts) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.className = "who";
    name.textContent = account.names.join(", ");
    name.title = `${account.email || "Not signed in"}\n${account.dir}`;
    const limits = account.limits;
    for (const key of ["session", "week"] as const) {
      const cell = row.insertCell();
      cell.className = "limit";
      if ("error" in limits) {
        // An idle account's sign-in runs out after a few hours; Claude Code renews it when used there.
        cell.textContent = key === "session" && /expired|not accepted/.test(limits.error) ? "expired" : "–";
        cell.title = limits.error;
        continue;
      }
      const limit = limits[key];
      if (limit) cell.append(meter(limit.percent, 100));
      cell.append(limitText(limit));
      cell.title = limit
        ? `${Math.round(limit.percent)}% of this account's ${key === "session" ? "5-hour session" : "weekly"} limit used, as Anthropic reports it${resetText(limit) ? `. Starts over ${resetText(limit)}` : ""}.`
        : `Anthropic reported no ${key === "session" ? "session" : "weekly"} limit for this account.`;
    }
    for (const key of ["week", "month", "year", "all"] as const) {
      const cell = row.insertCell();
      const t = account.usage?.[key];
      cell.textContent = t ? shortCount(t.total) : "–";
      if (t) cell.title = `${t.total.toLocaleString()} tokens (${t.output.toLocaleString()} output), counted from Claude Code on this computer`;
    }
  }
}

/*
 * Each Claude terminal's own bar: its tokens this week and in the 5-hour session window in progress,
 * and the usage-limit state Claude Code last printed in it (reached, or a warning that it is close).
 * Claude's real limits are not on this computer, so closeness is only known when Claude Code says so.
 */
const LIMIT_NEAR_TEXT = /(approaching (?:your )?(?:usage |session |weekly |5-hour )?limit|used (\d{1,3})% of your (?:session |weekly |5-hour |usage )?limit)/i;
const RESET_TEXT = /\breset(?:s|s at| at)?\s+(?:at\s+)?([^\n\r]{1,40}?)(?=\s{2,}|[.\n\r]|$)/i;
interface LimitState { level: "reached" | "near"; weekly: boolean; resets: string; at: number }
const limitStates = new Map<string, LimitState>();

/** Remembers what Claude Code just said about the limit in a terminal, from the plain text it printed. */
function noteLimitState(id: string, tail: string): void {
  const level = LIMIT_TEXT.test(tail) ? "reached" : LIMIT_NEAR_TEXT.test(tail) ? "near" : null;
  if (!level) return;
  const before = limitStates.get(id);
  // The same message stays in the tail for a while; it keeps the time it was first seen.
  if (before?.level === level) return;
  limitStates.set(id, { level, weekly: /weekly/i.test(tail), resets: RESET_TEXT.exec(tail)?.[1].trim() ?? "", at: Date.now() });
  showUsageBars();
}

/** A small bar filled to used/budget: amber from 80%, red at or over the budget. */
function meter(used: number, budget: number): HTMLElement {
  const share = used / budget;
  const bar = document.createElement("span");
  bar.className = `meter${share >= 1 ? " over" : share >= 0.8 ? " near" : ""}`;
  const fill = document.createElement("i");
  fill.style.width = `${Math.min(100, Math.round(share * 100))}%`;
  bar.append(fill);
  return bar;
}

/** "2M", "500k", "1.5b" or "2,000,000" -> a token count; empty or unreadable -> 0 (no budget). */
function parseCount(text: string): number {
  const match = /^([\d.,]+)\s*([kmbt]?)$/i.exec(text.trim());
  if (!match) return 0;
  const n = Number(match[1].replace(/,/g, "")) * ({ "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 } as Record<string, number>)[match[2].toLowerCase()];
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function showBudget(): void {
  const budget = workspace.usageBudget ?? {};
  ($("budgetSession") as HTMLInputElement).value = budget.session ? shortCount(budget.session) : "";
  ($("budgetWeek") as HTMLInputElement).value = budget.week ? shortCount(budget.week) : "";
}

for (const id of ["budgetSession", "budgetWeek"]) {
  const input = $(id) as HTMLInputElement;
  input.onchange = () => {
    const session = parseCount(($("budgetSession") as HTMLInputElement).value);
    const week = parseCount(($("budgetWeek") as HTMLInputElement).value);
    if (input.value.trim() && !parseCount(input.value)) toast("Write the budget as a number of tokens, such as 2M, 500K or 2,000,000.", true);
    workspace.usageBudget = { session: session || undefined, week: week || undefined };
    api.invoke("ui:save", { usageBudget: { session, week } });
    showBudget();
    showUsageBars();
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") input.blur();
  };
}

function showUsageBars(): void {
  const now = Date.now();
  for (const bar of document.querySelectorAll<HTMLElement>(".usagebar")) {
    const id = bar.dataset.profile ?? "";
    const usage = lastUsage?.profiles?.[id];
    let limit = limitStates.get(id);
    // A new answer after the message means the limit has lifted; a session limit lifts within 5 hours anyway.
    if (limit && ((usage && usage.last > limit.at + 60_000) || (!limit.weekly && now - limit.at > 5 * 3_600_000))) {
      limitStates.delete(id);
      limit = undefined;
    }
    const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    // Each part has a long and a short wording; the CSS shows the short one in a narrow terminal
    // instead of cutting words off (the full figures stay in the tooltip).
    const part = (className: string, long: string, short: string) => {
      const span = document.createElement("span");
      span.className = className;
      const full = document.createElement("span");
      full.className = "long";
      full.textContent = long;
      const brief = document.createElement("span");
      brief.className = "short";
      brief.textContent = short;
      span.append(full, brief);
      return span;
    };
    const budget = workspace?.usageBudget ?? {};
    // Anthropic's own percentages, when it could be asked, are what the Claude app shows; budgets are the fallback.
    const plan = usage?.limits && !("error" in usage.limits) ? usage.limits : null;
    const weekText = `Week ${usage ? shortCount(usage.week.total) : "–"}`;
    const week = plan?.week
      ? part("week", `Week ${limitText(plan.week)} · ${shortCount(usage!.week.total)}`, `Week ${limitText(plan.week)}`)
      : part("week", budget.week ? `${weekText} of ${shortCount(budget.week)}` : weekText, weekText);
    if (plan?.week) week.prepend(meter(plan.week.percent, 100));
    else if (budget.week) week.prepend(meter(usage?.week.total ?? 0, budget.week));
    const session = plan?.session
      ? part("session", `Session ${limitText(plan.session)}${usage?.session ? ` · ${shortCount(usage.session.tokens.total)}` : ""}`, `Session ${limitText(plan.session)}`)
      : usage?.session
      ? part("session", `Session ${shortCount(usage.session.tokens.total)}${budget.session ? ` of ${shortCount(budget.session)}` : ""}`, `Session ${shortCount(usage.session.tokens.total)}`)
      : part("session", "No session in progress", "No session");
    // Every Claude terminal shows a session bar: toward the session budget when one is set, otherwise
    // through the 5-hour window by time, so the bar is there before any budget is written.
    const sessionMeter = plan?.session
      ? meter(plan.session.percent, 100)
      : budget.session
      ? meter(usage?.session?.tokens.total ?? 0, budget.session)
      : meter(usage?.session ? Math.max(0, now - usage.session.start) : 0, usage?.session ? usage.session.end - usage.session.start : 1);
    sessionMeter.title = plan?.session ? "Share of this account's session limit used, as Anthropic reports it" : budget.session ? "Session tokens toward your session budget" : "Time used of the 5-hour session window. Click to set a session budget in tokens instead.";
    sessionMeter.onclick = () => {
      if ($("brain").hidden) $("toggle").click();
      ($("usage") as HTMLDetailsElement).open = true;
      ($("budgetSession") as HTMLInputElement).focus();
    };
    session.prepend(sessionMeter);
    // The reset time sits beside the session part rather than inside it, so a narrow terminal
    // shortens the session wording instead of cutting the time off.
    const until = plan?.session?.resets
      ? part("until", `· resets ${resetText(plan.session)}`, `· ${resetText(plan.session)}`)
      : usage?.session
      ? part("until", `· until ~${time(usage.session.end)}`, `· ~${time(usage.session.end)}`)
      : null;
    const status = limit
      ? part(`limit ${limit.level}`,
        `${limit.level === "reached" ? (limit.weekly ? "Weekly limit reached" : "Limit reached") : "Near limit"}${limit.resets ? ` · resets ${limit.resets}` : ""}`,
        `${limit.level === "reached" ? "Limit" : "Near"}${limit.resets ? ` · ${limit.resets}` : ""}`)
      : part("limit ok", "Within limit", "OK");
    bar.replaceChildren(...[week, session, until, status].filter((el): el is HTMLSpanElement => !!el));
    bar.title = (plan
      ? `Anthropic: ${limitText(plan.session)} of the session limit${resetText(plan.session) ? ` (starts over ${resetText(plan.session)})` : ""}, ` +
        `${limitText(plan.week)} of the weekly limit${resetText(plan.week) ? ` (starts over ${resetText(plan.week)})` : ""}. This is what the Claude app shows.\n`
      : usage?.limits && "error" in usage.limits ? `Limits from Anthropic: ${usage.limits.error}.\n` : "") +
      "On this computer: " + (usage
      ? `This week: ${usage.week.total.toLocaleString()} tokens (${usage.week.output.toLocaleString()} output).\n` +
        (usage.session
          ? `Session window ${time(usage.session.start)} to ${time(usage.session.end)}: ${usage.session.tokens.total.toLocaleString()} tokens (${usage.session.tokens.output.toLocaleString()} output).\n`
          : "No 5-hour session window in progress.\n")
      : "Not counted yet.\n") +
      (budget.session || budget.week
        ? `Budget: ${budget.session ? `${budget.session.toLocaleString()} a session` : "no session budget"}, ${budget.week ? `${budget.week.toLocaleString()} a week` : "no weekly budget"} (set under Tokens used in the brain panel).\n`
        : "Set a session and weekly budget under Tokens used in the brain panel to see bars here.\n") +
      "Token counts cover Claude Code on this computer only; the percentages from Anthropic count everything " +
      "the account did. The limit state shows what Claude Code last printed in this terminal.";
  }
}

try {
  if (localStorage.getItem(USAGE_OPEN_KEY) === "0") ($("usage") as HTMLDetailsElement).open = false;
} catch {
  // Storage can be unavailable; the panel then simply starts open.
}
$("usage").addEventListener("toggle", () => {
  const open = ($("usage") as HTMLDetailsElement).open;
  try {
    localStorage.setItem(USAGE_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
  if (open) showUsage();
});

/* ---------- Team memory ---------- */

async function showShareInfo(): Promise<{ newNotes: number; exists: boolean }> {
  const info: { folder: string; exists?: boolean; exported?: string; sharedNotes?: number; newNotes?: number } = await api.invoke("share:info");
  $("shareInfo").textContent = !info.folder
    ? "Choose a project folder first."
    : info.exists
      ? `The share file has ${info.sharedNotes} notes (written ${info.exported}). ${info.newNotes ? `${info.newNotes} of them are new to you.` : "You already have all of them."}`
      : "This project has no share file yet.";
  ($("shareImport") as HTMLButtonElement).disabled = !info.newNotes;
  ($("shareExport") as HTMLButtonElement).disabled = !info.folder;
  return { newNotes: info.newNotes ?? 0, exists: !!info.exists };
}
/** When the opened project carries notes from teammates that this brain lacks, offer them. */
async function offerSharedNotes(): Promise<void> {
  const { newNotes } = await showShareInfo();
  $("shared").hidden = !newNotes;
  $("sharedText").textContent = `This project comes with ${newNotes} shared note${newNotes === 1 ? "" : "s"} from teammates that your brain does not have yet.`;
}
$("share").onclick = async () => {
  await showShareInfo();
  $("shareDialog").hidden = false;
};
$("shareClose").onclick = () => ($("shareDialog").hidden = true);
$("shareExport").onclick = async () => {
  const answer = await api.invoke("share:export");
  if (answer.error) return toast(answer.error, true);
  await showShareInfo();
  $("shareInfo").textContent = `Wrote ${answer.notes} notes to .alt-brain.json in the project folder. Commit it with the project to share it.`;
};
const importShared = async () => {
  const answer = await api.invoke("share:import");
  if (answer.error) return toast(answer.error, true);
  $("shared").hidden = true;
  await showShareInfo();
  $("shareInfo").textContent = `Imported ${answer.added} note${answer.added === 1 ? "" : "s"} into your brain.`;
};
$("shareImport").onclick = importShared;
$("sharedGo").onclick = importShared;
$("sharedClose").onclick = () => ($("shared").hidden = true);

/* ---------- Notes and unfinished work ---------- */

$("noteAdd").onclick = async () => {
  const input = $("noteText") as HTMLInputElement;
  const answer = await api.invoke("note:add", input.value);
  if (answer.error) return toast(answer.error, true);
  input.value = "";
  toast("Note added to this project's memory.");
};
$("noteText").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("noteAdd").click();
});

async function showUnfinished(): Promise<void> {
  const items: { title: string; project: string; folder: string; profile: string; id: string; ended: string; type: string; here: boolean }[] = await api.invoke("brain:unfinished");
  $("todo").hidden = !items.length;
  const here = items.filter((i) => i.here).length;
  // Without a project folder there is no "this project" to count.
  $("todoTitle").textContent = !workspace.folder
    ? `Unfinished work: ${items.length} across your projects`
    : here
      ? `Unfinished work: ${here} in this project, ${items.length - here} elsewhere`
      : `Unfinished work: none in this project, ${items.length} elsewhere`;
  const list = $("todoList");
  list.textContent = "";
  for (const item of items.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "todo-item";
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = `${item.here ? "" : item.project + ": "}${item.title}`;
    what.title = `${item.title} · ${item.type} · ${item.profile} · ${item.ended.slice(0, 10)}`;
    const go = document.createElement("button");
    go.textContent = "Resume";
    go.onclick = () => resumeSession({ profile: item.profile, id: item.id, folder: item.folder });
    row.append(what, go);
    list.append(row);
  }
}

/** Continue a past session in the profile it ran in. That profile's terminal restarts for it. */
async function resumeSession(ref: { profile: string; id: string; folder: string }): Promise<void> {
  const target = workspace.profiles.find((p) => p.name === ref.profile);
  if (target && running(target.id) && !confirm(`Resuming restarts ${ref.profile}'s terminal. What is running there now is closed. Continue?`)) return;
  const answer = await api.invoke("session:resume", ref);
  if (answer.error) return toast(answer.error, true);
  terms.get(answer.id)?.panel.querySelector(".cover")?.remove();
  started.add(answer.id);
  exited.delete(answer.id);
  select(answer.id);
}

/* ---------- Updates ---------- */

// The main process checks for a new version on startup, downloads it by itself, and reports each step here.
interface UpdateStatus { status: "checking" | "none" | "available" | "downloading" | "ready" | "error"; version?: string; percent?: number; message?: string }
let updateShown: UpdateStatus = { status: "none" };
/** What the user clicked Later on: the download of a version, or its install. The banner stays away for that. */
let updateDismissed = "";
const updateKey = (update: UpdateStatus) => `${update.version ?? ""}:${update.status === "ready" ? "install" : "download"}`;

function showUpdate(update: UpdateStatus): void {
  const before = updateShown;
  updateShown = update;
  const named = update.version ? `version ${update.version}` : "the new version";
  const percent = Math.max(0, Math.min(100, Math.round(Number(update.percent) || 0)));
  const text: Record<UpdateStatus["status"], string> = {
    checking: "",
    none: "",
    available: `A new version is out: downloading ${named} in the background.`,
    downloading: `Downloading ${named}… ${percent}%`,
    ready: `${update.version ? `Version ${update.version}` : "The update"} is ready. Restart to update; the terminals start again when the app reopens.`,
    // Only worth saying when the user was already watching a download; a failed check on startup stays quiet.
    error: before.status === "available" || before.status === "downloading" ? `The update could not be downloaded${update.message ? `: ${update.message}` : "."} It will be tried again next time the app starts.` : "",
  };
  const progress = $("updateProgress") as HTMLProgressElement;
  progress.hidden = update.status !== "downloading";
  progress.value = percent;
  const go = $("updateGo") as HTMLButtonElement;
  go.hidden = update.status !== "ready";
  go.disabled = false;
  $("updateText").textContent = text[update.status] ?? "";
  $("update").hidden = !text[update.status] || updateDismissed === updateKey(update);
}
api.on("update:status", (update: UpdateStatus) => showUpdate(update));
$("updateGo").onclick = async () => {
  if (!confirm("Restart to update? Every terminal closes, and they start again when the app reopens.")) return;
  ($("updateGo") as HTMLButtonElement).disabled = true;
  const answer = await api.invoke("update:install");
  if (answer?.error) {
    ($("updateGo") as HTMLButtonElement).disabled = false;
    toast(answer.error, true);
  }
};
$("updateClose").onclick = () => {
  updateDismissed = updateKey(updateShown);
  $("update").hidden = true;
};

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
/** Counts searches, so an answer that arrives after a newer search was started is dropped. */
let searchNumber = 0;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const number = ++searchNumber;
  searchTimer = window.setTimeout(async () => {
    const query = ($("search") as HTMLInputElement).value.trim();
    const results = $("results");
    if (!query) return void (results.textContent = "");
    const { matches, byMeaning }: { matches: Match[]; byMeaning: boolean } = await api.invoke("brain:search", query);
    if (number !== searchNumber) return;
    results.textContent = "";
    if (!matches.length) {
      results.innerHTML = '<div class="result dim">Nothing matches.</div>';
      return;
    }
    const how = document.createElement("div");
    how.className = "result dim";
    how.textContent = byMeaning
      ? "Found by meaning and by words."
      : "Found by matching words. For search by meaning, run Ollama with the nomic-embed-text model.";
    results.append(how);
    for (const match of matches) {
      const item = document.createElement("div");
      item.className = "result";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${match.kind} · ${match.project} · ${match.when}`;
      const text = document.createElement("div");
      text.textContent = match.text;
      item.append(meta, text);
      if (match.resume) {
        // A session: clicking it picks it out in the picture; the button continues it.
        const ref = match.resume;
        const node = nodes.find((n) => n.id === `s:${ref.profile}:${ref.id}`);
        if (node) {
          item.classList.add("go");
          item.title = "Show it in the picture";
          item.onclick = () => {
            selected = node;
            show(node);
            wake();
          };
        }
        const go = document.createElement("button");
        go.textContent = `Resume in ${ref.profile}`;
        go.onclick = (event) => {
          event.stopPropagation();
          resumeSession(ref);
        };
        item.append(go);
      }
      results.append(item);
    }
    // New results start at the top, where the best matches are, not where the last list was scrolled to.
    results.scrollTop = 0;
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

/** How big a circle is drawn on screen: it shrinks with the camera, but not so far that it becomes a speck. */
const drawnRadius = (n: GraphNode) => Math.max(radius(n) * Math.min(camera.scale, 1.2), radius(n) * 0.6, 2);

/** Room on screen for the "open now" or "unfinished" ring around a circle, so its label starts past it. */
const ringGap = (n: GraphNode) => ((n.kind === "project" && n.open) || n.unfinished ? 6 : 0);

/**
 * The space a node and its label take up, in world units: [left, top, right, bottom]. It is worked
 * out from what is drawn on screen and then turned into world units, so it stays right when circles
 * and project names stop shrinking at a minimum size. A label that is too small to be drawn gets no room.
 */
function box(n: GraphNode): [number, number, number, number] {
  const s = camera.scale, k = Math.min(s, 1.2);
  const r = drawnRadius(n) + ringGap(n), half = Math.max(r, 8 * k);
  const size = fontSize(n) * k, drawn = n.kind === "project" ? Math.max(size, 10) : size;
  const label = n.kind === "project" || size >= 7 ? 4 * k + labelWidth(n) * (drawn / fontSize(n)) + 3 : 0;
  return [n.x - (r + 3) / s, n.y - (half + 3) / s, n.x + (r + 3 + label) / s, n.y + (half + 3) / s];
}

/** The space the whole picture takes up, in world units: [left, top, right, bottom]. */
function extent(): [number, number, number, number] {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const n of nodes) {
    const [l, t, r, b] = box(n);
    left = Math.min(left, l); top = Math.min(top, t); right = Math.max(right, r); bottom = Math.max(bottom, b);
  }
  return [left, top, right, bottom];
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
  // The pull to the middle is stronger along the picture's longer side, compared with the canvas,
  // so the network takes the canvas's shape and fills it instead of a narrow band across it.
  const [left, top, right, bottom] = nodes.length ? extent() : [0, 0, 1, 1];
  const stretch = width && height ? Math.max(0.25, Math.min(8, ((right - left) / (bottom - top) / (width / height)) ** 2)) : 1;
  for (const n of nodes) {
    n.vx -= n.x * 0.004 * stretch;
    n.vy -= n.y * 0.004 / stretch;
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
  const [left, top, right, bottom] = extent();
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
    const [x, y] = toScreen(n.x, n.y), r = drawnRadius(n);
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
      const size = Math.max(textSize, important ? 10 : 0);
      ctx.font = font(n, size);
      ctx.fillText(n.label, x + r + ringGap(n) + 4 * k, y + size / 3);
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
  if (n.note) {
    const ref = n.note;
    const button = document.createElement("button");
    button.id = "resume";
    button.textContent = "Delete this note";
    button.onclick = async () => {
      if (!confirm("Delete this note from the brain?")) return;
      await api.invoke("note:remove", ref);
      selected = null;
      show(null);
    };
    detail.append(button);
  }
  if (n.resume) {
    const ref = n.resume;
    const button = document.createElement("button");
    button.id = "resume";
    button.textContent = `Resume in ${ref.profile}`;
    button.onclick = () => resumeSession(ref);
    // Takes the session out of the brain only; Claude Code keeps its transcript.
    const remove = document.createElement("button");
    remove.id = "removeSession";
    remove.textContent = "Remove from brain";
    remove.title = "Take this session out of the brain's picture and search. Claude Code's own transcript stays on disk; the session comes back if it is continued.";
    remove.onclick = async () => {
      if (!confirm(`Remove "${n.label}" from the brain? Claude Code's transcript is kept.`)) return;
      const answer = await api.invoke("session:remove", { profile: ref.profile, id: ref.id });
      if (answer.error) return toast(answer.error, true);
      selected = null;
      show(null);
    };
    detail.append(button, remove);
  }
}

function pointer(event: PointerEvent | WheelEvent | MouseEvent) {
  const rect = canvas.getBoundingClientRect(), sx = event.clientX - rect.left, sy = event.clientY - rect.top;
  let best: GraphNode | null = null, bestDistance = Infinity;
  for (const n of nodes) {
    const [x, y] = toScreen(n.x, n.y);
    const distance = Math.hypot(x - sx, y - sy);
    if (distance < drawnRadius(n) + 6 && distance < bestDistance) { best = n; bestDistance = distance; }
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
api.on("brain:graph", (data) => {
  updateGraph(data);
  show(selected || hovered);
  showUnfinished();
});


// The canvas changes size with the window, the panels and the status line above it; keep the drawing in step.
new ResizeObserver(() => resizeMap()).observe(canvas);

/* ---------- Files: the project folder ---------- */

interface FileEntry { name: string; path: string; dir: boolean }
/** The project folder the tree shows, and the folders open in it, so a refresh keeps them open. */
let treeRoot = "";
const expanded = new Set<string>();

function showFiles(open: boolean): void {
  $("files").hidden = !open;
  $("filesToggle").classList.toggle("on", open);
  if (open && treeRoot !== workspace.folder) loadTree();
  soon(fitAll);
  api.invoke("ui:save", { filesOpen: open });
}

async function loadTree(): Promise<void> {
  if (treeRoot !== workspace.folder) expanded.clear();
  treeRoot = workspace.folder;
  const name = workspace.folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
  $("filesTitle").textContent = name || "No project folder";
  $("filesTitle").title = workspace.folder;
  const tree = $("tree");
  tree.textContent = "";
  if (!workspace.folder) return void tree.append(noteRow("Choose a project folder to see its files.", 0));
  await fillFolder(tree, "", 0);
}

function noteRow(text: string, depth: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "node note-row";
  row.style.setProperty("--depth", String(depth));
  row.textContent = text;
  return row;
}

/** List one folder into `box`, opening again whichever of its subfolders were open. */
async function fillFolder(box: HTMLElement, relative: string, depth: number): Promise<void> {
  const answer: { entries?: FileEntry[]; more?: boolean; error?: string } = await api.invoke("files:list", relative);
  box.textContent = "";
  if (answer.error) return void box.append(noteRow(answer.error, depth));
  if (!answer.entries!.length) box.append(noteRow("Empty", depth));
  for (const entry of answer.entries!) box.append(fileNode(entry, depth));
  if (answer.more) box.append(noteRow("Only the first 2,000 items are shown.", depth));
}

function fileNode(entry: FileEntry, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  row.className = `node ${entry.dir ? "dir" : "file"}`;
  row.style.setProperty("--depth", String(depth));
  row.tabIndex = 0;
  row.setAttribute("role", "treeitem");
  row.title = entry.path;
  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.textContent = entry.dir ? "▸" : "";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = (entry.dir ? "📁 " : "") + entry.name;
  const insert = document.createElement("button");
  insert.className = "icon act";
  insert.textContent = "➕";
  insert.title = "Put this path into the terminal you are using, for Claude Code to look at";
  insert.onclick = (event) => {
    event.stopPropagation();
    insertPath(entry.path);
  };
  const reveal = document.createElement("button");
  reveal.className = "icon act";
  reveal.textContent = "📂";
  reveal.title = "Show it in Explorer";
  reveal.onclick = async (event) => {
    event.stopPropagation();
    const answer = await api.invoke("files:reveal", entry.path);
    if (answer.error) toast(answer.error, true);
  };
  row.append(twisty, label, insert, reveal);
  wrap.append(row);
  const children = document.createElement("div");
  children.setAttribute("role", "group");
  if (entry.dir) {
    const toggle = async () => {
      const open = !expanded.has(entry.path);
      if (open) expanded.add(entry.path);
      else expanded.delete(entry.path);
      row.setAttribute("aria-expanded", String(open));
      twisty.textContent = open ? "▾" : "▸";
      children.textContent = "";
      if (open) await fillFolder(children, entry.path, depth + 1);
    };
    row.setAttribute("aria-expanded", "false");
    row.onclick = toggle;
    if (expanded.has(entry.path)) {
      expanded.delete(entry.path);
      toggle();
    }
  } else {
    row.onclick = async () => {
      // Text files (scripts and code included) open in the editor; anything else in its own app.
      if (await openInEditor(entry.path)) return;
      const answer = await api.invoke("files:open", entry.path);
      if (answer.error) toast(answer.error, true);
      else if (answer.revealed) toast(`${entry.name} is a program or script, so it is shown in Explorer instead of being run.`);
    };
  }
  row.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      row.click();
      event.preventDefault();
    }
  };
  wrap.append(children);
  return wrap;
}

/** Paste a project file's path into the active terminal, as Claude Code's @ reference, for the user to finish the prompt. */
async function insertPath(relative: string): Promise<void> {
  if (!active || !running(active)) return toast("Start a terminal first, then put the path into it.", true);
  const target = active;
  const ref = /\s/.test(relative) ? `@"${relative}" ` : `@${relative} `;
  // A file name can hold almost any character; the paste is cleaned and only goes into Claude Code.
  const pasted = await api.invoke("term:paste", target, ref, true);
  if (pasted?.error) return toast(pasted.error, true);
  select(target);
}

$("filesToggle").onclick = () => showFiles($("files").hidden);
$("filesClose").onclick = () => showFiles(false);
$("filesRefresh").onclick = () => {
  treeRoot = workspace.folder;
  const tree = $("tree");
  fillFolder(tree, "", 0);
};
$("filesReveal").onclick = async () => {
  const answer = await api.invoke("files:reveal", "");
  if (answer.error) toast(answer.error, true);
};

/* ---------- Editor: minor edits and code reviews, in Monaco (VS Code's editor) ---------- */

interface OpenFile { path: string; model: any; mtime: number; bom: boolean; saved: number; view?: any; original?: any; gone?: boolean }
const MONACO = "../node_modules/monaco-editor/min/vs";
let monaco: any = null;
let monacoLoading: Promise<any> | null = null;
let editor: any = null;
let diffEditor: any = null;
const openFiles: OpenFile[] = [];
let current: OpenFile | null = null;
let diffing = false;
const codeHost = document.createElement("div");
const diffHost = document.createElement("div");
codeHost.style.height = diffHost.style.height = "100%";
diffHost.hidden = true;
$("editorHost").append(codeHost, diffHost);

const isDirty = (file: OpenFile) => file.model.getAlternativeVersionId() !== file.saved;

/**
 * Monaco is loaded the first time a file is opened, not at start. Its loader defines a global
 * `define`, which must not exist while the terminal scripts load, or they would stop being globals.
 */
function loadMonaco(): Promise<any> {
  if (monacoLoading) return monacoLoading;
  monacoLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${MONACO}/loader.js`;
    script.onload = () => {
      const amd = (window as any).require;
      amd.config({ paths: { vs: MONACO } });
      amd(["vs/editor/editor.main"], () => resolve((window as any).monaco), () => reject(new Error("The editor could not be loaded.")));
    };
    script.onerror = () => reject(new Error("The editor could not be loaded."));
    document.head.append(script);
  });
  monacoLoading.catch(() => (monacoLoading = null));
  return monacoLoading;
}

async function ensureEditor(): Promise<void> {
  if (editor) return;
  monaco = await loadMonaco();
  const options = {
    theme: "vs-dark", automaticLayout: true, fontSize: workspace.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: "Consolas, 'Cascadia Mono', Menlo, monospace", minimap: { enabled: false }, scrollBeyondLastLine: false,
  };
  editor = monaco.editor.create(codeHost, options);
  // Side by side reads best for a review; only a really narrow pane falls back to one column.
  diffEditor = monaco.editor.createDiffEditor(diffHost, { ...options, originalEditable: false, renderSideBySide: true, renderSideBySideInlineBreakpoint: 520 });
  const save = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;
  editor.addCommand(save, () => saveFile());
  diffEditor.getModifiedEditor().addCommand(save, () => saveFile());
  editor.onDidChangeModelContent(showEditorState);
  diffEditor.getModifiedEditor().onDidChangeModelContent(showEditorState);
}

/**
 * Open a project file in the editor. False when it is not text (or too large) and should open elsewhere.
 * Quiet is for reopening files at start: one deleted since then is skipped without a message.
 */
async function openInEditor(relative: string, quiet = false): Promise<boolean> {
  let file = openFiles.find((f) => f.path === relative);
  if (!file) {
    const answer: { text?: string; mtime?: number; bom?: boolean; error?: string; code?: string } = await api.invoke("files:read", relative);
    if (answer.error) {
      if (answer.code || quiet) return false;
      toast(answer.error, true);
      return true;
    }
    try {
      await ensureEditor();
    } catch (error) {
      toast((error as Error).message, true);
      return false;
    }
    // The file name in the address tells Monaco which language to colour it as.
    const model = monaco.editor.createModel(answer.text, undefined, monaco.Uri.file("/" + relative));
    file = { path: relative, model, mtime: answer.mtime!, bom: !!answer.bom, saved: model.getAlternativeVersionId() };
    openFiles.push(file);
  }
  showEditor(true);
  await activate(file);
  return true;
}

function showEditor(open: boolean): void {
  $("work").classList.toggle("editing", open);
  $("editor").hidden = !open;
  $("editorSplit").hidden = !open;
  $("editorShow").hidden = open || !openFiles.length;
  $("editorShow").textContent = `Editor (${openFiles.length})`;
  // The terminals share the height with the editor while it is open, so they are refitted either way.
  soon(() => {
    fitAll();
    if (open) (diffing ? diffEditor?.getModifiedEditor() : editor)?.focus();
    else terms.get(active)?.term.focus();
  });
}

async function activate(file: OpenFile): Promise<void> {
  if (current && current !== file && !diffing) current.view = editor.saveViewState();
  current = file;
  if (diffing) await showDiff(true);
  else {
    editor.setModel(file.model);
    if (file.view) editor.restoreViewState(file.view);
    editor.focus();
  }
  renderEditorTabs();
  showEditorState();
  rememberOpenFiles();
}

/*
 * Which files are open, per project folder, so a reload or a restart opens them again. Only this
 * window's storage keeps it; without storage the files are simply not reopened.
 */
const OPEN_FILES_KEY = "openFiles:";
/** Set while files close because the folder changes, so the new folder's list is not overwritten. */
let keepOpenList = false;

function rememberOpenFiles(): void {
  if (keepOpenList || !workspace?.folder) return;
  try {
    localStorage.setItem(OPEN_FILES_KEY + workspace.folder, JSON.stringify({ files: openFiles.map((f) => f.path), active: current?.path ?? null }));
  } catch {
    // storage unavailable
  }
}

async function restoreOpenFiles(): Promise<void> {
  if (!workspace.folder) return;
  let saved: { files?: unknown; active?: unknown } = {};
  try {
    saved = JSON.parse(localStorage.getItem(OPEN_FILES_KEY + workspace.folder) || "{}");
  } catch {
    return;
  }
  if (!Array.isArray(saved.files)) return;
  const paths = saved.files.filter((p): p is string => typeof p === "string");
  if (!paths.length) return;
  keepOpenList = true;
  try {
    for (const path of paths) await openInEditor(path, true);
    const active = openFiles.find((f) => f.path === saved.active);
    if (active) await activate(active);
  } finally {
    keepOpenList = false;
    // Files deleted since are left out of the list from now on.
    rememberOpenFiles();
  }
}

function renderEditorTabs(): void {
  const tabs = $("editorTabs");
  tabs.textContent = "";
  for (const file of openFiles) {
    const tab = document.createElement("div");
    tab.className = "tab" + (file === current ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.title = file.path;
    const name = document.createElement("span");
    name.textContent = file.path.split("/").pop()!;
    const dirty = document.createElement("span");
    dirty.className = "dirty";
    dirty.textContent = isDirty(file) ? "●" : "";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.title = "Close this file";
    close.onclick = (event) => {
      event.stopPropagation();
      closeFile(file);
    };
    tab.onclick = () => activate(file);
    tab.append(name, dirty, close);
    tabs.append(tab);
  }
}

/** The text next to the buttons says what needs attention: unsaved edits, or a file deleted elsewhere. */
function showEditorState(): void {
  if (!current) return;
  const dirty = isDirty(current);
  $("editorState").textContent = current.gone ? "Deleted on disk" : dirty ? "Unsaved" : "";
  ($("editorSave") as HTMLButtonElement).disabled = !dirty && !current.gone;
  for (const tab of $("editorTabs").children) {
    const file = openFiles.find((f) => f.path === (tab as HTMLElement).title);
    const dot = tab.querySelector(".dirty");
    if (file && dot) dot.textContent = isDirty(file) ? "●" : "";
  }
}

async function saveFile(force = false): Promise<void> {
  const file = current;
  if (!file) return;
  const version = file.model.getAlternativeVersionId();
  const answer = await api.invoke("files:write", { path: file.path, text: file.model.getValue(), mtime: file.mtime, bom: file.bom, force: force || file.gone });
  if (answer.error) return toast(answer.error, true);
  if (answer.conflict) {
    // Claude Code may have edited the same file meanwhile; never overwrite that without asking.
    if (confirm(`${file.path} was changed outside the editor (perhaps by Claude Code) since you opened it.\n\nOverwrite it with your version? Cancel keeps the file on disk as it is, and your edits stay here.`)) return saveFile(true);
    return;
  }
  file.mtime = answer.mtime;
  file.saved = version;
  file.gone = false;
  showEditorState();
  toast(`Saved ${file.path}`);
}

function closeFile(file: OpenFile): void {
  if (isDirty(file) && !confirm(`${file.path} has unsaved changes. Close it without saving?`)) return;
  const index = openFiles.indexOf(file);
  openFiles.splice(index, 1);
  if (current === file) {
    current = null;
    const next = openFiles[Math.min(index, openFiles.length - 1)];
    if (next) activate(next);
    else {
      editor.setModel(null);
      diffEditor.setModel(null);
      showEditor(false);
    }
  }
  file.model.dispose();
  file.original?.dispose();
  renderEditorTabs();
  $("editorShow").textContent = `Editor (${openFiles.length})`;
  rememberOpenFiles();
}

/** Close every open file at once, unsaved edits included (the caller has already asked the user). */
function closeAllFiles(): void {
  for (const file of openFiles) file.saved = file.model.getAlternativeVersionId();
  for (const file of [...openFiles]) closeFile(file);
}

/** Side by side: the file as in the last commit on the left, as it is now on the right (still editable). */
async function showDiff(on: boolean): Promise<void> {
  diffing = on;
  $("editorDiff").classList.toggle("on", on);
  if (!current) return;
  const file = current;
  if (on) {
    const answer: { text?: string | null; error?: string } = await api.invoke("files:committed", file.path);
    if (answer.error) {
      toast(answer.error, true);
      return showDiff(false);
    }
    if (answer.text === null) toast(`${file.path} is not in the last commit (a new file, or no git here), so all of it shows as added.`);
    // The old copy is still shown by the diff view, so it goes only once the new one has replaced it.
    const old = file.original;
    file.original = monaco.editor.createModel(answer.text ?? "", file.model.getLanguageId());
    if (current !== file || !diffing) return void old?.dispose();
    codeHost.hidden = true;
    diffHost.hidden = false;
    diffEditor.setModel({ original: file.original, modified: file.model });
    old?.dispose();
    diffEditor.getModifiedEditor().focus();
  } else {
    diffHost.hidden = true;
    codeHost.hidden = false;
    editor.setModel(file.model);
    editor.focus();
  }
}

/**
 * Claude Code edits files too. An open file that changed on disk is reloaded when it has no unsaved
 * edits here; with unsaved edits it is left alone, and saving asks before overwriting.
 */
async function checkOpenFiles(): Promise<void> {
  for (const file of [...openFiles]) {
    const mtime: number = await api.invoke("files:changed-at", file.path);
    if (!openFiles.includes(file)) continue;
    file.gone = !mtime;
    if (!mtime || mtime === file.mtime || isDirty(file)) continue;
    const answer = await api.invoke("files:read", file.path);
    if (answer.error || isDirty(file) || !openFiles.includes(file)) continue;
    // As an edit rather than a replacement, so Undo can still go back to the earlier text.
    file.model.pushEditOperations([], [{ range: file.model.getFullModelRange(), text: answer.text }], () => null);
    file.mtime = answer.mtime;
    file.bom = answer.bom;
    file.saved = file.model.getAlternativeVersionId();
    if (file === current) toast(`${file.path} changed on disk and was reloaded.`);
  }
  showEditorState();
}
let checking = false;
setInterval(async () => {
  if (!openFiles.length || checking) return;
  checking = true;
  try {
    await checkOpenFiles();
  } finally {
    checking = false;
  }
}, 2000);

$("editorSave").onclick = () => saveFile();
$("editorDiff").onclick = () => showDiff(!diffing);
$("editorHide").onclick = () => showEditor(false);
$("editorShow").onclick = () => showEditor(true);

/** The editor's part of the height it shares with the terminals below it (0.2 to 0.85). */
function setEditorShare(share: number): void {
  const limited = Math.max(0.2, Math.min(share, 0.85));
  $("work").style.setProperty("--editor-share", String(limited));
  workspace.editorShare = limited;
}
$("editorSplit").addEventListener("pointerdown", (event) => {
  const split = $("editorSplit");
  split.setPointerCapture(event.pointerId);
  split.classList.add("dragging");
  const top = $("editor").getBoundingClientRect().top;
  const bottom = $("panels").getBoundingClientRect().bottom;
  const move = (e: PointerEvent) => setEditorShare((e.clientY - top) / (bottom - top));
  const stop = () => {
    split.classList.remove("dragging");
    split.removeEventListener("pointermove", move);
    split.removeEventListener("pointerup", stop);
    soon(fitAll);
    api.invoke("ui:save", { editorShare: workspace.editorShare });
  };
  split.addEventListener("pointermove", move);
  split.addEventListener("pointerup", stop);
});
$("editorVscode").onclick = async () => {
  if (!current) return;
  const answer = await api.invoke("files:vscode", current.path);
  if (answer.error) toast(answer.error, true);
  else toast("Opening it in VS Code. If nothing happens, VS Code is not installed.");
};
// Closing the window with unsaved edits asks first (the question itself comes from the main process).
window.addEventListener("beforeunload", (event) => {
  if (openFiles.some(isDirty)) event.returnValue = false;
});

/* ---------- Start ---------- */

(async () => {
  workspace = await api.invoke("workspace:get");
  resizeMap();
  freeContained = (await api.invoke("free:get")).contained;
  await showKit();
  if (workspace.brainWidth) setBrainWidth(workspace.brainWidth);
  if (workspace.editorShare) setEditorShare(workspace.editorShare);
  showFontSize();
  showBudget();
  if (workspace.filesOpen) {
    $("files").hidden = false;
    $("filesToggle").classList.add("on");
  }
  render();
  void restoreOpenFiles();
  offerSharedNotes();
  showUnfinished();
  showFreeHint();
  await refreshAccounts();
  offerFoundFolders();
  showSorting(await api.invoke("sorting:get"));
  // Recon listens from the start, so saying its name is enough; the header button turns it off.
  if (workspace.voiceOn !== false) void voiceStart();
  showUsage();
  setInterval(showUsage, USAGE_REFRESH_MS);
  const frame = () => {
    if (quietFrames < QUIET_AFTER || dragged || panning) {
      step();
      draw();
    }
    requestAnimationFrame(frame);
  };
  frame();
})();
