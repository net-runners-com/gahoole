/**
 * Stopping a turn that is already running.
 *
 * A turn here is seconds of waiting on a page, and sometimes it is obvious a
 * few seconds in that it is going the wrong way. Ctrl-C ends the process,
 * which is a heavy thing to do to a session; Esc should end the turn and
 * leave the session where it was.
 *
 * A flag rather than an AbortSignal because of what has to observe it: two
 * polling loops inside the browser backend and the round loop in the tool
 * protocol, none of which take a signal today, and threading one through four
 * layers to be read in three places is more machinery than the job needs.
 *
 * Cancelling is cooperative. Nothing is torn down mid-write: the checks sit
 * between rounds and between polls, so the worst that is in flight when it
 * fires is a page read.
 */

export class Interrupted extends Error {
  constructor() {
    super("stopped");
    this.name = "Interrupted";
  }
}

/** Replaced per turn, so a cancel cannot leak into the next one. */
let turn = { cancelled: false };

export function beginTurn(): void {
  turn = { cancelled: false };
}

export function cancelTurn(): void {
  turn.cancelled = true;
}

export const cancelled = (): boolean => turn.cancelled;

/** Called wherever a loop can afford to stop. */
export function stopHere(): void {
  if (turn.cancelled) throw new Interrupted();
}

export const isInterrupted = (e: unknown): boolean =>
  e instanceof Interrupted || (e instanceof Error && e.name === "Interrupted");

/**
 * Esc, while a turn is running.
 *
 * readline owns stdin at the prompt and is idle while a question is in flight,
 * so the key is watched only for the length of a turn and raw mode is handed
 * straight back afterwards. Approval asks through readline mid-turn, so the
 * watch stands aside for that too.
 *
 * Here rather than inline in main() so it can be driven by a fake stdin: the
 * thing worth testing is that raw mode is always given back, including when
 * the same state is asked for twice.
 */
export interface KeySource {
  isTTY?: boolean;
  setRawMode?: (on: boolean) => unknown;
  on(event: "data", fn: (buf: Buffer) => void): unknown;
  off(event: "data", fn: (buf: Buffer) => void): unknown;
}

export function escWatcher(
  stdin: KeySource,
  opts: { enabled?: () => boolean; onCancel?: () => void } = {},
): (on: boolean) => void {
  let watching = false;
  const onKey = (buf: Buffer): void => {
    if (buf.toString() !== "\x1b") return;
    cancelTurn();
    opts.onCancel?.();
  };
  return (on: boolean): void => {
    if (opts.enabled?.() === false || !stdin.isTTY || on === watching) return;
    watching = on;
    if (on) {
      stdin.setRawMode?.(true);
      stdin.on("data", onKey);
    } else {
      stdin.off("data", onKey);
      stdin.setRawMode?.(false);
    }
  };
}
