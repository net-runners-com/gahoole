/**
 * Spinner smoke test. The stream is injected rather than reaching for
 * process.stdout, so the frames, the label changes and — the part that
 * actually matters — sharing the line with other output can all be asserted
 * without a terminal.
 */
import assert from "node:assert/strict";
import { Spinner } from "./spinner.js";
import { bindLineOwner, log } from "./output.js";

const CLEAR = "\r\x1b[2K";
const writes: string[] = [];
const stream = { write: (s: string) => writes.push(s) };

const spinner = new Spinner({
  stream,
  enabled: true,
  color: false,
  intervalMs: 10,
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

spinner.start("thinking");
assert.ok(spinner.running);
assert.ok(writes[0]?.includes("\x1b[?25l"), "the cursor is hidden while spinning");
await wait(60);

const frames = writes.join("").match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g) ?? [];
assert.ok(frames.length >= 3, `animating (${frames.length} frames)`);
assert.ok(writes.join("").includes("thinking"));

// Every frame erases the previous one instead of stacking up lines.
assert.ok(
  writes.filter((w) => w.startsWith(CLEAR)).length >= frames.length - 1,
  "each frame clears the line first",
);
assert.equal(writes.join("").includes("\n"), false, "the spinner never scrolls");

spinner.label("running hello_hello");
await wait(30);
assert.ok(writes.join("").includes("running hello_hello"), "the label follows the work");

// Output from a hook has to interleave without stranding a half-drawn frame.
bindLineOwner(spinner);
const before = writes.length;
const consoleLog = console.log;
const printed: string[] = [];
console.log = (...a: unknown[]) => void printed.push(a.join(" "));
log("  ├ hello_hello {}");
console.log = consoleLog;

assert.deepEqual(printed, ["  ├ hello_hello {}"]);
assert.equal(writes[before], CLEAR, "the line is cleared before the hook prints");
assert.ok(
  writes[before + 1]?.includes("running hello_hello"),
  "and the spinner is redrawn after",
);

spinner.stop();
assert.equal(spinner.running, false);
assert.ok(writes.at(-1)?.includes("\x1b[?25h"), "the cursor comes back");

// Disabled: not a terminal, or switched off. Nothing is written at all.
const quietWrites: string[] = [];
const quiet = new Spinner({
  stream: { write: (s: string) => quietWrites.push(s) },
  enabled: false,
});
quiet.start("thinking");
quiet.label("x");
quiet.stop();
assert.deepEqual(quietWrites, [], "a disabled spinner writes nothing");

bindLineOwner(undefined);
console.log(`ok — spinner: ${frames.length} frames, line shared, silent when disabled`);
process.exit(0);
