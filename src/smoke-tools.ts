/**
 * Text tool-protocol smoke test. Offline: the model is a stub that replays a
 * scripted sequence of answers, so the loop, the parser and the hook path are
 * all exercised without a query against the rate limit.
 */
import assert from "node:assert/strict";
import { Lifecycle } from "./lifecycle.js";
import { ToolLoop } from "./tool-loop.js";
import type { Backend } from "./backends/index.js";
import { turnStore, type TurnContext } from "./turn-context.js";
import {
  buildPreamble,
  describeTool,
  formatResult,
  parseCalls,
  stripCalls,
} from "./tool-protocol.js";

// --- parser -----------------------------------------------------------------
assert.deepEqual(
  parseCalls('TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}'),
  [{ tool: "read_file", input: { path: "a.txt" } }],
);

// The model formats things. Bold, quote and fence markers must not defeat it.
for (const decorated of [
  '**TOOL_CALL:** {"tool":"t","input":{}}',
  '> TOOL_CALL: {"tool":"t","input":{}}',
  '`TOOL_CALL: {"tool":"t","input":{}}`',
  '   TOOL_CALL: {"tool":"t","input":{}}   ',
]) {
  assert.equal(parseCalls(decorated).length, 1, `parsed: ${decorated}`);
}

// Prose that merely mentions the protocol is not a call.
assert.equal(parseCalls("I could use TOOL_CALL: but I will not").length, 0);
assert.equal(parseCalls('TOOL_CALL: {not json}').length, 0);

assert.equal(
  stripCalls('Here you go.\nTOOL_CALL: {"tool":"t","input":{}}\nDone.'),
  "Here you go.\nDone.",
);

// A result large enough to blow past the composer's 8192-char limit is cut.
const huge = formatResult("read_file", { output: { content: "x".repeat(20_000) } });
assert.ok(huge.length < 8_192, `result fits the composer (${huge.length})`);
assert.ok(huge.includes("[truncated]"));

assert.ok(buildPreamble([{ name: "t", description: "d", params: ["a"] }]).includes("t(a)"));
assert.equal(buildPreamble([]), "", "no tools means no preamble");

// --- the loop ---------------------------------------------------------------
// The tool hooks read the active turn from AsyncLocalStorage, which
// `Session.run()` establishes in production. Outside a turn they no-op, so the
// test has to run inside one for the hook assertions to mean anything.
const inTurn = <T>(fn: () => Promise<T>): Promise<T> => {
  const ctx: TurnContext = {
    sessionId: "s-tools",
    turnId: `t-${Math.random().toString(36).slice(2, 8)}`,
    toolCalls: 0,
    pending: new Map(),
  };
  return turnStore.run(ctx, fn);
};
class StubBackend implements Backend {
  readonly name = "stub";
  readonly prompts: string[] = [];
  constructor(private readonly script: string[]) {}
  async ask(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.script.shift() ?? "done";
  }
}

const lifecycle = new Lifecycle();
const seen: string[] = [];
lifecycle.on("PreToolUse", (e) => {
  seen.push(`pre:${e.toolName}`);
  if (e.toolName === "write_note") return { deny: "not allowed in tests" };
});
lifecycle.on("PostToolUse", (e) => {
  seen.push(`post:${e.toolName}`);
});

let executed = 0;
const tools = {
  read_file: {
    description: "Read a file",
    inputSchema: { shape: { path: 0 } },
    execute: async (input: unknown) => {
      executed++;
      return { content: `contents of ${(input as { path: string }).path}` };
    },
  },
  write_note: {
    description: "Write a note",
    inputSchema: { shape: { name: 0, body: 0 } },
    execute: async () => {
      throw new Error("must never run — PreToolUse denied it");
    },
  },
};

// A tool is called, its result comes back, then the model answers.
{
  const stub = new StubBackend([
    "ok",
    'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}',
    "The file says hello.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  const answer = await inTurn(() => loop.ask("what is in a.txt?"));

  assert.equal(answer, "The file says hello.");
  assert.equal(executed, 1);
  assert.deepEqual(seen, ["pre:read_file", "post:read_file"]);
  assert.ok(stub.prompts[0]?.includes("TOOL_CALL:"), "preamble sent first");
  assert.equal(stub.prompts[1], "what is in a.txt?");
  assert.ok(
    stub.prompts[2]?.includes("TOOL_RESULT:") &&
      stub.prompts[2].includes("contents of a.txt"),
    "the result is fed back",
  );
}

// A denied call is reported to the model as the tool's result, not as a crash.
{
  seen.length = 0;
  const stub = new StubBackend([
    "ok", // the preamble turn
    'TOOL_CALL: {"tool":"write_note","input":{"name":"x","body":"y"}}',
    "I could not save that.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  const answer = await inTurn(() => loop.ask("save a note"));

  assert.equal(answer, "I could not save that.");
  assert.ok(
    stub.prompts.at(-1)?.includes("not allowed in tests"),
    "the model is told why it was denied",
  );
  assert.deepEqual(seen, ["pre:write_note", "post:write_note"]);
}

// An unknown tool is an error the model can recover from.
{
  const stub = new StubBackend([
    "ok", // the preamble turn
    'TOOL_CALL: {"tool":"nope","input":{}}',
    "That tool does not exist.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("do something"));
  assert.ok(stub.prompts.at(-1)?.includes("no such tool: nope"));
}

// A model that only ever asks for tools is stopped rather than looped forever.
{
  const stub = new StubBackend([
    "ok", // the preamble turn
    ...Array.from({ length: 20 }, () => 'TOOL_CALL: {"tool":"read_file","input":{"path":"a"}}'),
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle, 3);
  loop.reset();
  const answer = await inTurn(() => loop.ask("loop forever"));
  assert.equal(answer, "", "the trailing call markers are stripped");
  assert.ok(stub.prompts.length <= 7, `bounded at ${stub.prompts.length} prompts`);
}

// With no tools registered the wrapper gets out of the way entirely.
{
  const stub = new StubBackend(["plain answer"]);
  const loop = new ToolLoop(stub, {}, lifecycle);
  assert.equal(await inTurn(() => loop.ask("hi")), "plain answer");
  assert.equal(stub.prompts.length, 1, "no preamble when there is nothing to call");
}

console.log(
  `ok — tool protocol: ${describeTool("read_file", tools.read_file).params.join(",")} parsed, denied, bounded`,
);
process.exit(0);
