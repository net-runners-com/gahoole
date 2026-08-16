import { CALL_PREFIX, BODY_PREFIX, BODY_SUFFIX } from "./tool-protocol.js";

/**
 * Showing an answer while it is still being written.
 *
 * There is no streaming API behind this — the page fills in over several
 * seconds and `#settle` is already polling it — so what arrives is not a
 * delta but the whole answer so far, repeatedly. Turning that into something
 * printable is the job here, and it comes down to one rule: emit a line only
 * once it is finished.
 *
 * The last line of a growing answer is the one being written, and a terminal
 * cannot take back what it printed. So the tail is held until a newline shows
 * up behind it. That costs a line of latency and buys never having to redraw.
 *
 * Marker lines are dropped rather than shown. The user already sees the tool
 * call rendered properly a moment later, and `TOOL_CALL: {"tool":…}` scrolling
 * past in the middle of a sentence is noise that means nothing to them.
 */

const DROP = new RegExp(
  `^[\\s>*_\`]*(?:${CALL_PREFIX}|${BODY_PREFIX}|${BODY_SUFFIX})`,
);

export class LineStream {
  /** How many lines of the current reply have been handed out. */
  #emitted = 0;
  /** Whether anything at all has been printed this turn. */
  #any = false;
  /** How long the text was last time, for spotting a reply that restarted. */
  #length = 0;

  get started(): boolean {
    return this.#any;
  }

  /**
   * The lines that are finished and have not been handed out yet.
   *
   * `text` is the whole answer so far, every time — this works out the
   * difference itself rather than trusting the caller to.
   */
  feed(text: string): string[] {
    this.#restartIfShorter(text);
    // Splitting on newlines leaves a trailing "" when the text ends with one,
    // and that empty string is the line being written rather than a blank
    // line — which is why the count is the same either way.
    const lines = text.split("\n");
    return this.#take(lines, lines.length - 1);
  }

  /** Everything left, once the answer has stopped growing. */
  finish(text: string): string[] {
    this.#restartIfShorter(text);
    const lines = text.split("\n");
    return this.#take(lines, lines.length);
  }

  /**
   * Text that got shorter is a different reply, not the same one edited.
   *
   * The backend hands over the part of the page that is new since the last
   * answer, so a second reply starts from nothing rather than continuing —
   * and comparing lengths catches that where comparing line counts does not,
   * since a short new reply can have as many lines as a long finished one.
   */
  #restartIfShorter(text: string): void {
    if (text.length < this.#length) this.#emitted = 0;
    this.#length = text.length;
  }

  #take(lines: string[], upTo: number): string[] {
    if (upTo <= this.#emitted) return [];

    const out: string[] = [];
    for (let i = this.#emitted; i < upTo; i++) {
      const line = lines[i] ?? "";
      if (DROP.test(line)) continue;
      out.push(line);
    }
    this.#emitted = upTo;
    if (out.some((l) => l.trim())) this.#any = true;
    return out;
  }

  /** A new reply within the same turn: the tool loop asks more than once. */
  next(): void {
    this.#emitted = 0;
    this.#length = 0;
  }

  /** A new turn. */
  reset(): void {
    this.#emitted = 0;
    this.#length = 0;
    this.#any = false;
  }
}

/**
 * What is left to print once the turn returns.
 *
 * The final answer is not always what was streamed: the tool loop keeps the
 * prose from several replies and hands back all of it, and a nudged reply is
 * dropped from the answer but was already on screen. So rather than trying to
 * reconcile them, anything already shown is skipped and the rest is printed —
 * which is right whether the two agree or not.
 */
export function remainder(answer: string, shown: string[]): string {
  const seen = new Set(shown.map((l) => l.trim()).filter(Boolean));
  const kept = answer
    .split("\n")
    .filter((l) => !seen.has(l.trim()) || !l.trim());
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
