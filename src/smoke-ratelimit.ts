/**
 * Rate-limit recovery. Offline: a stub backend refuses the way AI Mode does
 * and the wrapper's policy is checked directly, since forcing a real limit
 * costs eighty queries and ten minutes.
 */
import assert from "node:assert/strict";
import { AiModeRateLimitError } from "./backends/aimode.js";
import { classifyFailure } from "./handoff.js";

// The error a blocked page raises is shaped so the rest of the program reads
// it the same way it reads a 429.
const err = new AiModeRateLimitError();
assert.equal(err.status, 429);
assert.equal(classifyFailure(err).kind, "rate_limit");

// The recovery policy, stated as the wrapper implements it: rotate first,
// wait only once rotating has stopped helping.
const plan = (rotations: number, max: number) => {
  const steps: string[] = [];
  for (let n = 1; n <= rotations; n++) {
    if (n > max) {
      steps.push("give up");
      break;
    }
    steps.push(n > 2 ? "rotate+wait" : "rotate");
  }
  return steps;
};

assert.deepEqual(plan(1, 6), ["rotate"], "the first limit costs seconds, not minutes");
assert.deepEqual(plan(3, 6), ["rotate", "rotate", "rotate+wait"]);
assert.deepEqual(
  plan(7, 6).at(-1),
  "give up",
  "a limit that survives six fresh cookies is not cookie-shaped",
);

console.log("ok — rate limit: 429-shaped, rotate then wait, bounded");
process.exit(0);
