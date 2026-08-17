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
