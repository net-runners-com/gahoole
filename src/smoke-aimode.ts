/**
 * AI Mode backend smoke test — the only one that talks to the network.
 *
 * Two turns, so both paths are covered: the opening navigation and the
 * follow-up typed into the composer. Roughly 15 seconds and two queries
 * against a limit measured at 77-100, so it is safe to run repeatedly, but it
 * is kept out of `npm run smoke` because it is not offline.
 */
import assert from "node:assert/strict";
import { AiModeBackend } from "./backends/aimode.js";

const backend = new AiModeBackend({ hl: "en" });

// A value the model cannot know from anywhere but this conversation, so the
// second turn proves continuity rather than testing how literally the model
// follows an instruction.
const TOKEN = String(Math.floor(Math.random() * 9000) + 1000);

try {
  const first = await backend.ask(
    `Remember this number for later: ${TOKEN}. Reply with a short acknowledgement.`,
  );
  assert.ok(first.length > 0, "the first turn produced an answer");

  // The follow-up has to reach the same conversation, not open a new one.
  const second = await backend.ask(
    "What number did I ask you to remember? Reply with the digits.",
  );
  assert.ok(
    second.includes(TOKEN),
    `the follow-up lost the conversation (expected ${TOKEN}): ${second.slice(0, 200)}`,
  );

  // Page furniture must not survive into the answer.
  assert.ok(
    !/不正確な情報|responses may include mistakes/i.test(second),
    "the disclaimer is stripped",
  );

  console.log(`ok — 2 turns through AI Mode, context preserved`);
} finally {
  await backend.close();
}
process.exit(0);
