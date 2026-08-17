/**
 * Is something above the tool loop going to ask again?
 *
 * The loop nudges a turn that changed nothing, because a turn that reads two
 * files and then reports the job done is the failure that cost the benchmark
 * most. Inside an autonomous run that nudge is redundant: the run's own loop
 * asks for the outstanding steps on the very next turn, so the nudge buys a
 * query to say what was about to be said anyway.
 *
 * Measured: three of nineteen queries in one autonomous run, four of
 * twenty-one in another — roughly a fifth of the budget spent twice.
 *
 * A flag rather than a parameter because of where it is read: deep inside a
 * loop three layers below the thing that knows, and threading it down would
 * touch every signature on the way for one boolean.
 */

let depth = 0;

export function beginDriving(): void {
  depth++;
}

export function endDriving(): void {
  depth = Math.max(0, depth - 1);
}

/** True while a loop above will ask again if this turn stops short. */
export const beingDriven = (): boolean => depth > 0;
