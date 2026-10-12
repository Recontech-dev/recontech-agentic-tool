// The voice conversation with the Manager: its messages back are spoken and shown, not typed in.

/**
 * How long after the last request or answer the Manager's messages still count as part of the
 * conversation. Each new request or answer starts it again, so a long task can report back as it goes.
 */
export const VOICE_REPLY_MS = 10 * 60_000;

/**
 * Terminals the user spoke to the Manager through. While a conversation lasts, every message the
 * Manager sends to such a terminal is spoken (and shown, to insert if wanted) instead of typed in; a
 * message from any other terminal is delivered as usual.
 */
export class VoiceReplies {
  private waiting = new Map<string, { manager: string; until: number }>();

  expect(terminalId: string, manager: string, now = Date.now()): void {
    this.waiting.set(terminalId, { manager, until: now + VOICE_REPLY_MS });
  }

  /**
   * The answer to speak, when this message is the Manager's to a terminal in a conversation, or null
   * when the message should be delivered as usual. `from` is the sending terminal's name, as the app
   * (not the message) says it.
   */
  take(terminalId: string, from: string | undefined, text: string, now = Date.now()): string | null {
    const wait = this.waiting.get(terminalId);
    if (!wait) return null;
    if (now > wait.until) {
      this.waiting.delete(terminalId);
      return null;
    }
    if (!from || from.toLowerCase() !== wait.manager.toLowerCase()) return null;
    // The conversation goes on: a progress note is often followed by a "done".
    wait.until = now + VOICE_REPLY_MS;
    return String(text ?? "").replace(/^\[Message from the "[^"]*" terminal\]\s*/, "");
  }

  forget(terminalId: string): void {
    this.waiting.delete(terminalId);
  }

  /** The voice feature was turned off: answers still on their way go to their terminals as ordinary messages. */
  clear(): void {
    this.waiting.clear();
  }
}
