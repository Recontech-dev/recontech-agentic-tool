// Every piece of text the app (not the user's own keys) puts into a terminal goes through here: messages
// from other terminals, the Manager's spoken answers, voice transcripts and file paths. It goes in only
// as a bracketed paste and only while the terminal's program has bracketed paste on, which Claude Code
// has and a plain shell has not; otherwise a message is held and anything else is refused.
// Kept free of Electron so it can be tested on its own.

import { Inbox } from "./inbox";
import { PasteMode, bracketedPaste } from "./paste";

export interface Pty {
  write(data: string): void;
}

export interface DeliveryEvents {
  /** A message was typed into a terminal and submitted. */
  message?(id: string): void;
  /** How many messages wait for a terminal changed. */
  waiting?(id: string, count: number): void;
}

/** How long after pasting a message its Enter is pressed. */
export const ENTER_DELAY_MS = 400;

export class Delivery {
  /** Messages from other terminals that wait while the user is typing in the terminal they are for. */
  readonly inbox = new Inbox();
  private modes = new Map<string, PasteMode>();

  constructor(private pty: (id: string) => Pty | undefined, private events: DeliveryEvents = {}, private enterMs = ENTER_DELAY_MS) {}

  /** A terminal's program started: feed the returned mode everything it writes. It starts off. */
  watch(id: string): PasteMode {
    const mode = new PasteMode();
    this.modes.set(id, mode);
    return mode;
  }

  /** The terminal's program is gone; nothing more goes in until it is watched again. */
  unwatch(id: string): void {
    this.modes.delete(id);
  }

  /**
   * Text goes into a terminal only while Claude Code reads it. After Claude Code exits the terminal is
   * a plain shell, where a "paste" is typed keys and a message would run as a command.
   */
  allowed(id: string): boolean {
    return !!this.pty(id) && this.modes.get(id)?.on === true;
  }

  /**
   * Text for the user to check and send (a voice transcript, a Manager's answer, a file path), not
   * submitted. False, with nothing written, while Claude Code is not reading that terminal.
   */
  paste(id: string, text: string, oneLine = false): boolean {
    if (!this.allowed(id)) return false;
    const data = bracketedPaste(String(text ?? ""), oneLine);
    this.inbox.typed(id, data);
    this.pty(id)!.write(data);
    return true;
  }

  /** Send a message to a terminal as a prompt, or hold it while its user is typing or Claude Code is not running there. */
  send(id: string, text: string): "sent" | "queued" {
    if (!this.pty(id)) return "sent";
    // While the user is typing there, the message waits, and so does any message after it, to keep their order.
    if (this.inbox.busy(id) || this.inbox.waiting(id) || !this.allowed(id)) {
      this.inbox.hold(id, String(text ?? ""));
      this.events.waiting?.(id, this.inbox.waiting(id));
      return "queued";
    }
    this.submit(id, text);
    return "sent";
  }

  /** Send the next waiting message to a terminal once it is free, or right away when the user asks. */
  flush(id: string, force = false): void {
    // Not even on request while Claude Code is not running there: the shell would run the message.
    if (!this.allowed(id)) return;
    const text = this.inbox.next(id, force);
    if (text === undefined) return;
    this.submit(id, text);
    this.events.waiting?.(id, this.inbox.waiting(id));
  }

  private submit(id: string, text: string): void {
    const term = this.pty(id);
    if (!term || !this.allowed(id)) return;
    // Sent as a paste so line breaks stay inside the message, then Enter to submit it, but only if the
    // same Claude Code still reads the terminal: an Enter into a shell would run whatever is on its line.
    term.write(bracketedPaste(text));
    setTimeout(() => this.pty(id) === term && this.allowed(id) && term.write("\r"), this.enterMs);
    this.events.message?.(id);
  }
}
