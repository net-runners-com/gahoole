/**
 * Handoff smoke test, run under the exact condition it is built for: no API
 * key, so the model is genuinely unavailable and stage 2 genuinely fails.
 * Stage 1 has to work anyway — that is the whole point of splitting them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Lifecycle } from "./lifecycle.js";
import { createAgent, createMemory } from "./agent.js";
import { Session } from "./session.js";
import { SessionStore } from "./sessions.js";
import { classifyFailure, HandoffStore, shouldHandoff } from "./handoff.js";

const DIR = path.resolve("data/handoff");

// --- classification ---------------------------------------------------------
const rl = classifyFailure(
  Object.assign(new Error("429 rate_limit_error"), {
    status: 429,
    responseHeaders: { "retry-after": "42" },
  }),
);
assert.equal(rl.kind, "rate_limit");
assert.equal(rl.retryAfterMs, 42_000);

assert.equal(classifyFailure({ status: 529 }).kind, "overloaded");
assert.equal(classifyFailure(new Error("Overloaded")).kind, "overloaded");
assert.equal(
  classifyFailure(new Error("prompt is too long for context")).kind,
  "context",
);
assert.equal(classifyFailure(new Error("ENOENT")).kind, "other");

// SDKs wrap the real error; the classifier has to look through one layer.
assert.equal(
  classifyFailure(
    Object.assign(new Error("request failed"), {
      cause: Object.assign(new Error("rate limit"), { status: 429 }),
    }),
  ).kind,
  "rate_limit",
);

assert.ok(shouldHandoff("rate_limit") && shouldHandoff("context"));
assert.ok(!shouldHandoff("other"), "an ordinary bug is not carried forward");

// --- capture on a real rate-limited turn ------------------------------------
const resourceId = `handoff-${randomUUID().slice(0, 8)}`;
const lifecycle = new Lifecycle();
const memory = createMemory();
const sessions = new SessionStore(memory, resourceId);
sessions.register(lifecycle);
const agent = createAgent(lifecycle, memory);

const handoffs = new HandoffStore(memory, resourceId);
let captured = 0;
handoffs.register(lifecycle, {
  turnsOf: () => session.turns,
  onCaptured: () => {
    captured++;
  },
});

let session = await Session.start({ agent, memory, lifecycle, resourceId });

// Real messages in the thread, so the digest has something to read.
await session.seedContext("the deploy key lives in 1password under 'infra'");
await session.run("what did I say about the deploy key?", async () =>
  "It is in 1password under 'infra'.",
);

// Now a turn that fails the way the API fails when it throttles.
await assert.rejects(() =>
  session.run("keep going", async () => {
    throw Object.assign(new Error("rate_limit_error"), {
      status: 429,
      responseHeaders: { "retry-after": "60" },
    });
  }),
);

assert.equal(captured, 1, "the rate limit produced exactly one handoff");

const saved = handoffs.read();
assert.ok(saved, "handoff written to disk");
assert.equal(saved.reason, "rate_limit");
assert.equal(saved.retryAfterMs, 60_000);
assert.equal(saved.pending, true, "no summary — the model is unavailable");
assert.ok(
  saved.digest.includes("deploy key"),
  "the digest carries the actual conversation, with no model call",
);
assert.equal(saved.turns, 2);
assert.ok(
  saved.digest.includes("keep going") &&
    saved.digest.includes("did not complete"),
  "the prompt that failed is carried even though it never reached storage",
);

// A failure that is not worth carrying leaves the handoff alone.
await assert.rejects(() =>
  session.run("boom", async () => {
    throw new Error("TypeError: undefined is not a function");
  }),
);
assert.equal(captured, 1, "ordinary failures do not overwrite the handoff");

// --- the next session picks it up -------------------------------------------
const seed = HandoffStore.seedText(saved);
assert.ok(seed.includes("rate limit"), "seed explains why");
assert.ok(seed.includes("deploy key"), "seed carries the transcript");

const next = await session.clear();
const taken = handoffs.take();
assert.ok(taken, "take() returns the handoff");
assert.equal(handoffs.read(), undefined, "and clears it");
assert.ok(
  fs.readdirSync(path.join(DIR, "archive")).some((f) => f.startsWith(saved.sessionId)),
  "the consumed handoff is archived, not deleted",
);

await next.seedContext(HandoffStore.seedText(taken));
const { messages } = (await memory.recall({
  threadId: next.id,
  resourceId,
  last: 10,
} as never)) as { messages: unknown[] };
assert.ok(
  JSON.stringify(messages).includes("deploy key"),
  "the new session's thread contains the carried-over context",
);

// Stage 2 with no backend available: the handoff comes back untouched and
// still pending, rather than throwing or losing the digest.
const unchanged = await handoffs.summarize(saved);
assert.equal(unchanged.pending, true, "still owed a summary");
assert.equal(unchanged.summary, undefined);
assert.equal(unchanged.digest, saved.digest, "the digest survives");

await next.end("exit");
console.log(
  `ok — handoff captured without a model, ${saved.digest.length} chars of transcript carried forward`,
);
process.exit(0);
