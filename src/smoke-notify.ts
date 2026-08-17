/**
 * The thing the browser backend's four notices are made of.
 *
 * They were single variables, so `onAiModePartial(a)` followed by
 * `onAiModePartial(b)` left only b, and a was gone without a word. Nothing in
 * the program did that yet — the CLI registers each once — but the shape
 * guaranteed that the first thing to try would fail quietly, and there was no
 * way to test any of it without driving a browser.
 */
import assert from "node:assert/strict";
import { notifier } from "./notify.js";

// --- more than one listener --------------------------------------------------
{
  const n = notifier<[string]>("test");
  const seen: string[] = [];

  assert.equal(n.listening, false, "nothing yet");
  const stopA = n.add((s) => seen.push(`a:${s}`));
  const stopB = n.add((s) => seen.push(`b:${s}`));
  assert.equal(n.listening, true);

  n.emit("one");
  assert.deepEqual(seen, ["a:one", "b:one"], "both, in the order they arrived");

  stopA();
  n.emit("two");
  assert.deepEqual(seen, ["a:one", "b:one", "b:two"], "and stopping stops one of them");

  stopA();
  n.emit("three");
  assert.equal(seen.length, 4, "stopping twice is not an error");

  stopB();
  assert.equal(n.listening, false);
  n.emit("four");
  assert.equal(seen.length, 4, "and nothing listening is not an error either");
}

// --- clearing ----------------------------------------------------------------
//
// `onAiModePartial(undefined)` is how streaming is turned off when the output
// is a pipe, so undefined has to keep meaning "none of them".
{
  const n = notifier<[string]>("test");
  let count = 0;
  n.add(() => count++);
  n.add(() => count++);
  n.add(undefined);
  n.emit("x");
  assert.equal(count, 0, "undefined clears every listener");
  assert.equal(n.listening, false);

  // And what it returns can still be called.
  n.add(undefined)();
}

// --- a listener that throws --------------------------------------------------
//
// These are notices, not steps. A caller that asked to be told and then failed
// to handle it must not take the question down.
{
  const n = notifier<[string]>("noisy");
  const after: string[] = [];
  n.add(() => {
    throw new Error("badly written");
  });
  n.add((s) => after.push(s));

  const wrote: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string) => {
    wrote.push(String(chunk));
    return true;
  };
  try {
    n.emit("still delivered");
  } finally {
    (process.stderr as { write: unknown }).write = real;
  }

  assert.deepEqual(after, ["still delivered"], "the next listener still hears it");
  assert.match(wrote.join(""), /\[noisy\] listener threw: badly written/, "and it is not silent");
}

// --- changing the listeners while it is emitting ------------------------------
{
  const n = notifier<[]>("test");
  let ran = 0;
  const stop = n.add(() => {
    ran++;
    stop(); // a one-shot, which is a reasonable thing to write
    n.add(() => ran++); // and one that adds another
  });
  n.emit();
  assert.equal(ran, 1, "the set being walked is a copy");
  n.emit();
  assert.equal(ran, 2, "the one added during the emit hears the next one");
}

// --- arguments come through as they are ---------------------------------------
{
  const n = notifier<[number, boolean]>("rotation");
  let got: [number, boolean] | undefined;
  n.add((a, b) => {
    got = [a, b];
  });
  n.emit(3, true);
  assert.deepEqual(got, [3, true]);
}

// --- the four the backend exposes --------------------------------------------
//
// Registering used to return nothing, so a caller had no way to stop
// listening and a second caller replaced the first. Each returns the way to
// stop now. What they carry is only produced by a browser run; this is the
// contract, not the traffic.
{
  const m = await import("./backends/aimode.js");
  const stops = [
    m.onAiModeRateLimit(() => {}),
    m.onAiModeRelaunch(() => {}),
    m.onAiModeEmpty(() => {}),
    m.onAiModePartial(() => {}),
  ];
  for (const stop of stops) {
    assert.equal(typeof stop, "function", "registering returns the way to stop");
    stop();
    stop(); // twice is not an error
  }
  // And clearing, which is how a pipe turns streaming off.
  assert.equal(typeof m.onAiModePartial(undefined), "function");
}

console.log("ok — notify: several listeners, stopping, clearing, throwing, re-entrancy");
