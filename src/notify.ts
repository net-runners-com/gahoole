/**
 * Somewhere to send a notice that more than one thing may be listening for.
 *
 * The browser backend reports four things a person wants to see while waiting:
 * a rate limit and the rotation that answers it, a relaunch after a crash, a
 * retry of a question that came back empty, and the answer as it is written.
 *
 * Each of those used to be a single variable — `onPartial = fn` — so a second
 * caller silently replaced the first. Two things watching the same event is
 * not a mistake; losing one of them without a word is. Registering adds, and
 * returns the way to stop.
 *
 * A listener that throws is not allowed to take the run down with it. These
 * are notices, not steps: the caller asked to be told, and being told badly is
 * their problem, not the question's.
 */

export interface Notifier<A extends unknown[]> {
  /** Add a listener; the returned function removes it. `undefined` clears all. */
  add(fn: ((...args: A) => void) | undefined): () => void;
  /** Whether anything is listening — for work not worth doing otherwise. */
  readonly listening: boolean;
  emit(...args: A): void;
}

export function notifier<A extends unknown[]>(
  /** Named in the warning when a listener throws, so it can be found. */
  what = "notice",
): Notifier<A> {
  const listeners = new Set<(...args: A) => void>();

  return {
    add(fn) {
      // `undefined` clears, which is how streaming is turned off for a pipe.
      if (!fn) {
        listeners.clear();
        return () => {};
      }
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    get listening() {
      return listeners.size > 0;
    },
    emit(...args) {
      // A copy, so a listener that removes itself — or adds another — does not
      // change the set being walked.
      for (const fn of [...listeners]) {
        try {
          fn(...args);
        } catch (e) {
          process.stderr.write(
            `[${what}] listener threw: ${e instanceof Error ? e.message : String(e)}\n`,
          );
        }
      }
    },
  };
}
