import { stdout } from "node:process";

/**
 * A one-line spinner for the wait between asking and answering.
 *
 * AI Mode takes six to fifteen seconds for a plain answer and longer once
 * tools are in play, which is long enough that a silent terminal reads as a
 * hang. The label tracks what is actually happening — thinking, or the name
 * of the tool currently running — so the wait is legible rather than merely
 * animated.
 *
 * Anything else that prints while it is running must go through `log()` in
 * `output.ts`, which clears the spinner's line first and redraws afterwards.
 * Writing directly to stdout mid-spin leaves the frame stranded in the
 * scrollback.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR = "\r\x1b[2K";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

export interface SpinnerOptions {
  /** Defaults to process.stdout; injected so the behaviour can be tested. */
  stream?: { write(s: string): unknown };
  enabled?: boolean;
  color?: boolean;
  intervalMs?: number;
}

export class Spinner {
  #timer?: NodeJS.Timeout;
  #frame = 0;
  #startedAt = 0;
  #label = "";
  readonly #enabled: boolean;
  readonly #out: { write(s: string): unknown };
  readonly #color: boolean;
  readonly #interval: number;

  constructor(opts: SpinnerOptions = {}) {
    this.#out = opts.stream ?? stdout;
    this.#enabled =
      opts.enabled ??
      (Boolean(stdout.isTTY) && !process.env.GAHOOLE_NO_SPINNER);
    this.#color = opts.color ?? !process.env.NO_COLOR;
    this.#interval = opts.intervalMs ?? 80;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(label: string): void {
    if (!this.#enabled || this.#timer) return;
    this.#label = label;
    this.#startedAt = Date.now();
    this.#frame = 0;
    this.#out.write(HIDE);
    this.#draw();
    this.#timer = setInterval(() => {
      this.#frame = (this.#frame + 1) % FRAMES.length;
      this.#draw();
    }, this.#interval);
    // Never hold the process open on the spinner alone.
    this.#timer.unref?.();
  }

  /** Change what the spinner says without restarting the elapsed clock. */
  label(label: string): void {
    this.#label = label;
    if (this.#timer) this.#draw();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#out.write(`${CLEAR}${SHOW}`);
  }

  /** Erase the current frame so another writer can use the line. */
  clear(): void {
    if (this.#timer) this.#out.write(CLEAR);
  }

  /** Put the frame back after someone else has written. */
  redraw(): void {
    if (this.#timer) this.#draw();
  }

  #draw(): void {
    const secs = ((Date.now() - this.#startedAt) / 1000).toFixed(1);
    const body = `${FRAMES[this.#frame]} ${this.#label} ${secs}s`;
    this.#out.write(`${CLEAR}${this.#color ? `${DIM}${body}${RESET}` : body}`);
  }
}
