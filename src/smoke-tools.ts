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
  CALL_PREFIX,
  buildPreamble,
  describeTool,
  formatResult,
  parseCalls,
  parseMalformed,
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

{
  // Descriptions are trimmed to their first clause; the surrounding prose is
  // load-bearing and stays (see the note on buildPreamble).
  const pre = buildPreamble([{ name: "t", description: "First. Second.", params: ["a"] }]);
  assert.ok(pre.includes("t(a) First."), "the name, params and first clause");
  assert.ok(!pre.includes("Second."), "and nothing past it");
  assert.ok(pre.includes(CALL_PREFIX), "and the marker, with a concrete example");
}
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
    'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}',
    "The file says hello.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  const answer = await inTurn(() => loop.ask("what is in a.txt?"));

  assert.equal(answer, "The file says hello.");
  assert.equal(executed, 1);
  assert.deepEqual(seen, ["pre:read_file", "post:read_file"]);
  // The preamble rides on the first question rather than costing a turn.
  assert.equal(stub.prompts.length, 2, "one round trip per exchange");
  assert.ok(stub.prompts[0]?.endsWith("what is in a.txt?"));
  assert.ok(stub.prompts[0]?.includes("Available tools:"), "preamble included");
  assert.ok(
    stub.prompts[0]?.includes("Tools you can run here: read_file(path)"),
    "and the rule restated with the question",
  );
  assert.ok(
    stub.prompts[1]?.includes("TOOL_RESULT:") &&
      stub.prompts[1].includes("contents of a.txt"),
    "the result is fed back",
  );
}

// A denied call is reported to the model as the tool's result, not as a crash.
{
  seen.length = 0;
  const stub = new StubBackend([
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
  const stub = new StubBackend(
    Array.from({ length: 20 }, () => 'TOOL_CALL: {"tool":"read_file","input":{"path":"a"}}'),
  );
  const loop = new ToolLoop(stub, tools, lifecycle, 3);
  loop.reset();
  const answer = await inTurn(() => loop.ask("loop forever"));
  assert.equal(answer, "", "the trailing call markers are stripped");
  assert.ok(stub.prompts.length <= 5, `bounded at ${stub.prompts.length} prompts`);
}

// A fenced block is the body, and angle brackets survive it — the plain-text
// path loses them to the page's markdown renderer.
{
  const fenced = [
    'TOOL_CALL: {"tool":"write_file","input":{"path":"main.cpp"}}',
    "```cpp",
    "#include <iostream>",
    'int main(){ std::cout << "Fizz"; }',
    "```",
  ].join("\n");
  const parsed = parseCalls(fenced);
  assert.equal(parsed.length, 1);
  const content = (parsed[0]!.input as { content: string }).content;
  assert.ok(content.includes("<iostream>"), "angle brackets survive");
  assert.ok(content.includes('std::cout << "Fizz"'), "so do quotes");
}

// File contents ride in a block, so quotes and newlines need no escaping.
{
  const withBody = [
    'TOOL_CALL: {"tool":"write_file","input":{"path":"a.cpp"}}',
    "TOOL_BODY:",
    '#include <iostream>',
    'int main(){ std::cout << "Fizz\n"; }',
    "TOOL_END",
  ].join("\n");
  const parsed = parseCalls(withBody);
  assert.equal(parsed.length, 1);
  assert.equal(
    (parsed[0]!.input as { content: string }).content,
    '#include <iostream>\nint main(){ std::cout << "Fizz\n"; }',
  );
}

// The failure this replaces: code inside the JSON is not valid JSON.
{
  const inline = 'TOOL_CALL: {"tool":"write_file","input":{"content":"cout << "Fizz";"}}';
  assert.equal(parseCalls(inline).length, 0);
  const bad = parseMalformed(inline);
  assert.equal(bad.length, 1, "and it is reported rather than ignored");
}

// A call missing a required field is an error the model is told about, not a
// success reported for work that did not happen.
{
  const stub = new StubBackend([
    'TOOL_CALL: {"tool":"read_file","input":{}}',
    "Sorry.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("save a note"));
  assert.ok(
    stub.prompts.at(-1)?.includes("missing path"),
    `told what was missing: ${stub.prompts.at(-1)?.slice(0, 120)}`,
  );
}

// A turn that reports work while calling nothing is the benchmark's most
// common failure, and reads exactly like success. It gets one demand for the
// real thing.
{
  const stub = new StubBackend([
    "fizzbuzz.cpp を作成しました。出力は 1 2 Fizz です。",
    'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}',
    "Done.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  assert.equal(await inTurn(() => loop.ask("ファイルを作って")), "Done.");
  assert.ok(
    stub.prompts[1]?.includes("nothing actually happened"),
    "the model is told the report was a guess",
  );
}

// An answer to a plain question is not nudged, however confident it sounds.
{
  const stub = new StubBackend(["12 です。"]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("アリスはボブより3歳年上です。ボブは何歳？"));
  assert.equal(stub.prompts.length, 1, "no nudge for a question");
}

// A malformed marker line gets one correction request.
{
  const stub = new StubBackend([
    'TOOL_CALL: {"tool":"write_file","input":{"content":"a "b" c"}}',
    'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}',
    "Done.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  assert.equal(await inTurn(() => loop.ask("write it")), "Done.");
  assert.ok(stub.prompts[1]?.includes("could not be read as JSON"));
}

// A reply that announces a tool without calling one is nudged exactly once.
{
  const stub = new StubBackend([
    "まずは read_file ツールを使用します。",
    'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}',
    "Done.",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  const answer = await inTurn(() => loop.ask("write a file"));

  assert.equal(answer, "Done.");
  assert.ok(
    stub.prompts[1]?.includes("did not emit"),
    "the nudge says what was missing",
  );
}

// Only tools that exist are nudged for: naming something unregistered is
// prose, not an intention the loop can act on.
{
  const stub = new StubBackend(["まずは deploy_rocket を使用します。"]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("go"));
  assert.equal(stub.prompts.length, 1, "no nudge for a tool that does not exist");
}

// And prose that merely mentions a tool name is left alone — a false nudge
// costs a query.
{
  const stub = new StubBackend(["read_file reads files. Anything else?"]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("what tools are there?"));
  assert.equal(stub.prompts.length, 1, "no nudge for a passing mention");
}

// And a model that keeps announcing is not nudged forever.
{
  const stub = new StubBackend([
    "read_file を使用します。",
    "やはり read_file を使用します。",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  await inTurn(() => loop.ask("write a file"));
  assert.equal(stub.prompts.length, 2, "nudged once, not twice");
}

// With no tools registered the wrapper gets out of the way entirely.
{
  const stub = new StubBackend(["plain answer"]);
  const loop = new ToolLoop(stub, {}, lifecycle);
  assert.equal(await inTurn(() => loop.ask("hi")), "plain answer");
  assert.equal(stub.prompts.length, 1, "no preamble when there is nothing to call");
}

// --- several calls in one reply, each with its own block ---------------------
{
  const reply = [
    "まず書きます。",
    'TOOL_CALL: {"tool":"write_file","input":{"path":"a.cpp"}}',
    "```cpp",
    "#include <iostream>",
    "```",
    "次に実行します。",
    'TOOL_CALL: {"tool":"run_command","input":{"command":"g++","args":["a.cpp"]}}',
  ].join("\n");

  const calls = parseCalls(reply);
  assert.equal(calls.length, 2, "both calls are parsed");
  assert.equal(
    (calls[0]!.input as { content?: string }).content,
    "#include <iostream>",
    "the block attaches to the call above it",
  );
  assert.equal(
    (calls[1]!.input as { content?: string }).content,
    undefined,
    "and not to the one after it",
  );
}

// A block written before the marker still counts when there is only one call —
// models put the code first about as often as last.
{
  const calls = parseCalls(
    ["```js", "console.log(1)", "```", 'TOOL_CALL: {"tool":"write_file","input":{"path":"a.js"}}'].join("\n"),
  );
  assert.equal(calls.length, 1);
  assert.equal((calls[0]!.input as { content?: string }).content, "console.log(1)");
}

// --- the prose from every reply survives the turn ---------------------------
//
// The plan an autonomous run asks for arrives in the same reply as the tool
// calls that begin it. Returning only the final reply threw the plan away.
{
  const stub = new StubBackend([
    ["1. ファイルを作る", "2. 実行する", 'TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}'].join("\n"),
    "できました。",
  ]);
  const loop = new ToolLoop(stub, tools, lifecycle);
  loop.reset();
  const out = await inTurn(() => loop.ask("やって"));
  assert.match(out, /1\. ファイルを作る/, "the list written alongside the calls survives");
  assert.match(out, /できました。/, "and so does the answer it ended on");
  assert.ok(!out.includes("TOOL_CALL"), "the markers themselves do not");
}

console.log(
  `ok — tool protocol: ${describeTool("read_file", tools.read_file).params.join(",")} parsed, denied, bounded`,
);
process.exit(0);
