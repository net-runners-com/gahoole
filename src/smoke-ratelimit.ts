/**
 * Rate-limit recovery. Offline: a stub backend refuses the way AI Mode does
 * and the wrapper's policy is checked directly, since forcing a real limit
 * costs eighty queries and ten minutes.
 */
import assert from "node:assert/strict";
import {
  AiModeRateLimitError,
  AiModeRefusedError,
  EmptyAnswerError,
  recoveryFor,
  type Attempts,
} from "./backends/aimode.js";
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

// --- and the decision itself, rather than a restatement of it ----------------
//
// The block above describes the policy; this runs it. The whole recovery used
// to be a run of `if`s inside a catch, where the only way to check any of it
// was to make Google fail on purpose.
{
  const fresh = (over: Partial<Attempts> = {}): Attempts => ({
    empties: 0,
    refused: false,
    relaunched: false,
    rotations: 0,
    maxRotations: 6,
    waitMs: 60_000,
    ...over,
  });

  // A rate limit rotates, and waits only once rotating has stopped helping.
  assert.deepEqual(recoveryFor(new AiModeRateLimitError(), fresh()), { do: "rotate" });
  assert.deepEqual(recoveryFor(new AiModeRateLimitError(), fresh({ rotations: 2 })), {
    do: "rotate",
    waitMs: 60_000,
  });
  assert.deepEqual(recoveryFor(new AiModeRateLimitError(), fresh({ rotations: 6 })), {
    do: "give up",
  });

  // An empty answer: again here, then again somewhere else. This is the one
  // that mattered — two runs ended at 224 seconds with "AI Mode returned
  // nothing", because the second empty had nowhere else to go.
  assert.deepEqual(recoveryFor(new EmptyAnswerError(), fresh()), { do: "retry" });
  assert.deepEqual(recoveryFor(new EmptyAnswerError(), fresh({ empties: 1 })), {
    do: "rotate",
  });
  assert.deepEqual(recoveryFor(new EmptyAnswerError(), fresh({ empties: 2 })), {
    do: "give up",
  });

  // A refusal is not deterministic, so it is worth one more ask — after a
  // pause, and only one.
  assert.deepEqual(recoveryFor(new AiModeRefusedError(), fresh()), {
    do: "retry",
    waitMs: 1200,
  });
  assert.deepEqual(recoveryFor(new AiModeRefusedError(), fresh({ refused: true })), {
    do: "give up",
  });

  // A dead browser is relaunched once; a crash that repeats is worth seeing.
  const crash = new Error("Target page, context or browser has been closed");
  assert.deepEqual(recoveryFor(crash, fresh()), { do: "relaunch" });
  assert.deepEqual(recoveryFor(crash, fresh({ relaunched: true })), { do: "give up" });

  // Anything else is not a thing to retry.
  assert.deepEqual(recoveryFor(new Error("no such file"), fresh()), { do: "give up" });
}

console.log(
  "ok — rate limit: 429-shaped, rotate then wait, bounded; recovery for empty, refusal, crash",
);
process.exit(0);
