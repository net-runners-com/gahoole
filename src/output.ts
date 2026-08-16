/**
 * Everything that prints while a turn is in flight goes through here.
 *
 * The spinner owns its line; a bare `console.log` during a spin leaves the
 * half-drawn frame stranded above the new text. `log()` clears that line
 * first and lets the spinner redraw afterwards, so hook output and the
 * spinner can share the terminal without either having to know about the
 * other's timing.
 */
export interface LineOwner {
  clear(): void;
  redraw(): void;
}

let owner: LineOwner | undefined;

export function bindLineOwner(o: LineOwner | undefined): void {
  owner = o;
}

export function log(...args: unknown[]): void {
  owner?.clear();
  console.log(...args);
  owner?.redraw();
}

export function logError(...args: unknown[]): void {
  owner?.clear();
  console.error(...args);
  owner?.redraw();
}
