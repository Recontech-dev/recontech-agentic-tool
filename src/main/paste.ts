// Putting text into a terminal for Claude Code: as a bracketed paste, and only while Claude Code is
// what reads it. When Claude Code has exited the terminal is a plain shell, which ignores the paste
// markers, so the text would arrive as typed keys and run at the next Enter.

/**
 * Text wrapped in bracketed-paste markers. Every control character goes first, ESC (\x1b) and its
 * one-byte form CSI (\x9b) above all: either could end the paste early ("\x1b[201~") and have the rest
 * arrive as keys, Enter included. Tabs become spaces (a tab completes in a shell). Line breaks stay
 * unless `oneLine` is set; set it when the user is meant to read the text and press Enter themselves.
 */
export function bracketedPaste(text: string, oneLine = false): string {
  let clean = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  clean = oneLine ? clean.replace(/\n+/g, " ").replace(/ {2,}/g, " ").trim() : clean;
  return `\x1b[200~${clean}\x1b[201~`;
}

/** "ESC [ ? <modes> h|l": a program switching private modes on or off; 2004 is bracketed paste. */
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
/** Enough of the end of one chunk to finish a mode switch that the next chunk completes. */
const TAIL = 24;

/**
 * Whether the program in a terminal has bracketed paste switched on, read from what it writes.
 * Claude Code switches it on while it runs and off when it exits; a plain shell never does. A
 * terminal that was just started has it off.
 */
export class PasteMode {
  on = false;
  private tail = "";

  /** Feed everything the terminal's program writes, in order. */
  feed(data: string): void {
    const text = this.tail + data;
    PRIVATE_MODES.lastIndex = 0;
    let end = 0;
    for (let match = PRIVATE_MODES.exec(text); match; match = PRIVATE_MODES.exec(text)) {
      if (match[1].split(";").includes("2004")) this.on = match[2] === "h";
      end = PRIVATE_MODES.lastIndex;
    }
    // The part already read is not kept, so a switch is never counted twice.
    this.tail = text.slice(Math.max(end, text.length - TAIL));
  }
}
