// The Hey Recon voice replies that wait for the user to confirm them.

/** How long a Hey Recon request waits for the Manager's answer before the answer is no longer expected. */
export const VOICE_REPLY_MS = 5 * 60_000;

/**
 * Terminals that asked the Manager something by voice. The Manager's next message to such a terminal is
 * held for the user to confirm instead of typed in; a message from any other terminal is delivered as
 * usual. Each terminal waits for at most one answer, and a newer request replaces an older one, so an
 * earlier request's expiry can never cut a newer one short.
 */
export class VoiceReplies {
  private waiting = new Map<string, { manager: string; until: number }>();

  expect(terminalId: string, manager: string, now = Date.now()): void {
    this.waiting.set(terminalId, { manager, until: now + VOICE_REPLY_MS });
  }

  /**
   * The answer to show for confirmation, when this message is the one a terminal is waiting for, or
   * null when the message should be delivered as usual. `from` is the sending terminal's name, as the
   * app (not the message) says it.
   */
  take(terminalId: string, from: string | undefined, text: string, now = Date.now()): string | null {
    const wait = this.waiting.get(terminalId);
    if (!wait) return null;
    if (now > wait.until) {
      this.waiting.delete(terminalId);
      return null;
    }
    if (!from || from.toLowerCase() !== wait.manager.toLowerCase()) return null;
    this.waiting.delete(terminalId);
    return String(text ?? "").replace(/^\[Message from the "[^"]*" terminal\]\s*/, "");
  }

  forget(terminalId: string): void {
    this.waiting.delete(terminalId);
  }

  /** Hey Recon was turned off: answers still on their way go to their terminals as ordinary messages. */
  clear(): void {
    this.waiting.clear();
  }
}
