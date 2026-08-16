/**
 * Offline smoke test: exercises every part of the lifecycle that does not need
 * a model call, so `npm run smoke` works without an API key.
 *
 * Covered: hook dispatch and ordering, the PreToolUse deny path, Pre/Post
 * pairing through the Mastra tool-hook bridge, and libSQL thread persistence
 * (create → clone → list).
 *
 * Not covered: a real turn. Set ANTHROPIC_API_KEY and run `npm run dev`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lifecycle } from "./lifecycle.js";
import { createAgent, createMemory, createToolHooks } from "./agent.js";
import { turnStore, type TurnContext } from "./turn-context.js";
import { Session } from "./session.js";
import { AmbiguousSessionError, SessionStore } from "./sessions.js";
import { extractAttachments } from "./attachments.js";

const seen: string[] = [];

const lifecycle = new Lifecycle();
for (const e of [
  "ProcessStart",
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "PostToolUse",
] as const) {
  lifecycle.on(e, () => {
    seen.push(e);
  });
}
lifecycle.on("PreToolUse", (ev) => {
  seen.push("PreToolUse");
  if (ev.toolName === "write_note") return { deny: "denied by smoke test" };
});
// A throwing observer must not take the turn down.
lifecycle.on("PreToolUse", () => {
  throw new Error("observer hooks are allowed to fail");
});

const memory = createMemory();
const agent = createAgent(lifecycle, memory);

// --- tool-hook bridge -------------------------------------------------------
const hooks = createToolHooks(lifecycle);

const ctx: TurnContext = {
  sessionId: "s-smoke",
  turnId: "t-smoke",
  toolCalls: 0,
  pending: new Map(),
};

await turnStore.run(ctx, async () => {
  const allowed = await hooks.beforeToolCall({
    toolName: "read_file",
    input: { path: "package.json" },
  });
  assert.equal(allowed, undefined, "read_file is allowed through");
  await hooks.afterToolCall({
    toolName: "read_file",
    output: { content: "" },
  });

  const denied = await hooks.beforeToolCall({
    toolName: "write_note",
    input: { name: "x", body: "y" },
  });
  assert.equal(denied?.proceed, false, "write_note is short-circuited");
  assert.deepEqual(denied?.output, {
    denied: true,
    reason: "denied by smoke test",
  });
});

assert.equal(ctx.toolCalls, 2, "both calls counted on the turn");
assert.deepEqual(seen, ["PreToolUse", "PostToolUse", "PreToolUse"]);

// --- attachment extraction ---------------------------------------------------
{
  const tmp = path.join(os.tmpdir(), `gahoole-smoke-${randomUUID().slice(0, 8)}.png`);
  fs.writeFileSync(tmp, "not really a png, but it exists");

  // A dragged-in path arrives quoted and is stripped out of the question.
  const quoted = extractAttachments(`'${tmp}' これ何`);
  assert.deepEqual(quoted.paths, [tmp]);
  assert.equal(quoted.prompt, "これ何");

  // Bare paths work too, as long as the file is really there.
  assert.deepEqual(extractAttachments(tmp).paths, [tmp]);

  // Merely naming a file is not an attachment.
  assert.deepEqual(extractAttachments("look at screenshot.png please").paths, []);
  // Nor is a real file that is not an image.
  assert.deepEqual(extractAttachments("package.json").paths, []);

  fs.rmSync(tmp);
}

// --- session scope ----------------------------------------------------------
const resourceId = `smoke-${randomUUID().slice(0, 8)}`;
const sessions = new SessionStore(memory, resourceId);
sessions.register(lifecycle);

const session = await Session.start({
  agent,
  memory,
  lifecycle,
  resourceId,
});
assert.ok(seen.includes("SessionStart"));

const forked = await session.fork();
assert.notEqual(forked.id, session.id, "fork opens a different thread");
assert.ok(
  seen.filter((e) => e === "SessionEnd").length === 1,
  "forking ends exactly one session",
);

// --- session store -----------------------------------------------------------
const listed = await sessions.list();
assert.equal(listed.length, 2, `both sessions listed (got ${listed.length})`);
assert.equal(listed[0]!.id, forked.id, "newest first");
assert.deepEqual(
  listed[0]!.source,
  { kind: "fork", from: session.id },
  "lineage recorded on the fork",
);

// The list is scoped to this resource, not the whole database.
const otherStore = new SessionStore(memory, `other-${randomUUID().slice(0, 8)}`);
assert.equal((await otherStore.list()).length, 0, "list filters by resource");

// Prefix lookup: unique resolves, empty is ambiguous, nonsense errors.
assert.equal(await sessions.resolve(forked.id.slice(0, 8)), forked.id);
await assert.rejects(() => sessions.resolve(""), AmbiguousSessionError);
await assert.rejects(() => sessions.resolve("zzzzzzzz"), /no session matches/);

await sessions.rename(forked.id, "renamed by smoke");
assert.equal((await sessions.latest())?.title, "renamed by smoke");

// Turn counts come from the Stop hook, so a session with no turns reads 0.
assert.equal(listed[0]!.turns, 0);

await sessions.remove(session.id);
assert.equal((await sessions.list()).length, 1, "delete removes the session");

await forked.end("exit");

console.log(`ok — ${seen.length} lifecycle events, session store verified`);
process.exit(0);
