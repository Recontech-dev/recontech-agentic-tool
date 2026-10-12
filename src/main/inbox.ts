// Messages from other terminals wait while the user is typing in the terminal they are for. A message
// is pasted and submitted with Enter, so arriving in the middle of the user's own typing would mix
// the two together and send the user's half-written prompt with it.

/** How long after the last key a terminal still counts as being typed in. */
export const IDLE_MS = 2500;

// Bracketed-paste markers and other escape sequences (arrow keys, function keys) change no text.
const ESCAPES = /\x1b\[20[01]~|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO./g;

interface State {
  /** About how many characters the user has typed and not yet sent or cleared. */
  draft: number;
  /** When the user last typed in this terminal. */
  last: number;
  waiting: string[];
}

export class Inbox {
  private states = new Map<string, State>();

  private state(id: string): State {
    let state = this.states.get(id);
    if (!state) this.states.set(id, (state = { draft: 0, last: 0, waiting: [] }));
    return state;
  }

  /**
   * Note what the user typed into a terminal. Enter, Ctrl+C and Ctrl+U end the draft; Backspace
   * shortens it; other keys without text (arrows and the like) leave it as it is.
   */
  typed(id: string, data: string, now = Date.now()): void {
    const text = data.replace(ESCAPES, "");
    // Only escape sequences: arrow keys, or reports the terminal sends by itself (focus, cursor position).
    if (!text) return;
    const state = this.state(id);
    state.last = now;
    for (const char of text) {
      if (char === "\r" || char === "\n" || char === "\x03" || char === "\x15") state.draft = 0;
      else if (char === "\x7f" || char === "\b") state.draft = Math.max(0, state.draft - 1);
      else if (char >= " ") state.draft++;
    }
  }

  /** True while the user has unsent text in the terminal or typed there a moment ago. */
  busy(id: string, now = Date.now()): boolean {
    const state = this.states.get(id);
    return !!state && (state.draft > 0 || now - state.last < IDLE_MS);
  }

  /** Keep a message until the terminal is free. */
  hold(id: string, text: string): void {
    this.state(id).waiting.push(text);
  }

  waiting(id: string): number {
    return this.states.get(id)?.waiting.length ?? 0;
  }

  /** The next waiting message, if the terminal is free, or `force` says to send it anyway. */
  next(id: string, force = false, now = Date.now()): string | undefined {
    const state = this.states.get(id);
    if (!state?.waiting.length || (!force && this.busy(id, now))) return undefined;
    return state.waiting.shift();
  }

  /** Terminals that have messages waiting. */
  pending(): string[] {
    return [...this.states].filter(([, state]) => state.waiting.length).map(([id]) => id);
  }

  /** A new shell starts with an empty prompt; its waiting messages still go to it. */
  restarted(id: string): void {
    const state = this.states.get(id);
    if (state) state.draft = 0;
  }

  /** The terminal is gone for good, with whatever was waiting for it. */
  forget(id: string): void {
    this.states.delete(id);
  }
}
