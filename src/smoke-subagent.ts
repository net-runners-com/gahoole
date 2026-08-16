/**
 * Subagent smoke test. Offline: the backend is a stub whose fork is another
 * stub, so delegation, the recursion guard, the spawn cap and the shared hook
 * path are all exercised without a browser or a query.
 */
import assert from "node:assert/strict";
import { Lifecycle } from "./lifecycle.js";
import type { Backend } from "./backends/index.js";
import { createSpawnTool, SPAWN_TOOL } from "./subagent.js";
import { ToolLoop } from "./tool-loop.js";
import { turnStore, type TurnContext } from "./turn-context.js";

class Stub implements Backend {
  readonly prompts: string[] = [];
  forks = 0;
  closed = 0;
  constructor(
    readonly name: string,
    private readonly script: string[],
    private readonly childScript: string[] = [],
  ) {}
  async ask(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return this.script.shift() ?? "done";
  }
  async fork(): Promise<Backend> {
    this.forks++;
    const parent = this;
    const child = new Stub("child", [...this.childScript]);
    const close = child.close.bind(child);
    child.close = async () => {
      parent.closed++;
      await close();
    };
    children.push(child);
    return child;
  }
  async close(): Promise<void> {}
}

const children: Stub[] = [];
const lifecycle = new Lifecycle();
const seen: string[] = [];
lifecycle.on("PreToolUse", (e) => {
  seen.push(e.toolName);
});

let read = 0;
const tools: Record<string, unknown> = {
  read_file: {
    description: "Read a file.",
    inputSchema: { shape: { path: 0 } },
    execute: async () => {
      read++;
      return { content: "the answer is 42" };
    },
  },
};

const inTurn = <T>(fn: () => Promise<T>): Promise<T> =>
  turnStore.run(
    { sessionId: "s", turnId: "t", toolCalls: 0, pending: new Map() } as TurnContext,
    fn,
  );

// The parent delegates; the child reads a file and reports; the parent answers.
const parent = new Stub(
  "parent",
  [
    `TOOL_CALL: {"tool":"${SPAWN_TOOL}","input":{"task":"find the answer in a.txt"}}`,
    "The answer is 42.",
  ],
  ['TOOL_CALL: {"tool":"read_file","input":{"path":"a.txt"}}', "42"],
);

tools[SPAWN_TOOL] = createSpawnTool({
  fork: () => parent.fork(),
  tools,
  lifecycle,
});

const loop = new ToolLoop(parent, tools, lifecycle);
const answer = await inTurn(() => loop.ask("what is the answer?"));

assert.equal(answer, "The answer is 42.");
assert.equal(parent.forks, 1, "one subagent");
assert.equal(read, 1, "the child did the reading");
assert.deepEqual(seen, [SPAWN_TOOL, "read_file"], "both calls take the same hook path");
assert.equal(parent.closed, 1, "the child's tab is closed afterwards");
assert.ok(
  parent.prompts.at(-1)?.includes("42"),
  "the parent receives the child's report",
);

// The child is never given the ability to spawn.
const childPreamble = children[0]?.prompts[0] ?? "";
assert.ok(childPreamble.includes("read_file"), "the child inherits the tools");
assert.ok(!childPreamble.includes(SPAWN_TOOL), "but not the one that spawns more");

// The cap is enforced, and says what to do instead.
{
  const capped = createSpawnTool({
    fork: () => parent.fork(),
    tools,
    lifecycle,
    maxSpawns: 1,
  }) as unknown as { execute: (i: unknown, c?: unknown) => Promise<unknown> };
  await inTurn(() => capped.execute({ task: "one" }, {}) as Promise<unknown>);
  await assert.rejects(
    () => capped.execute({ task: "two" }, {}) as Promise<unknown>,
    /do this one yourself/,
  );
}

console.log(
  `ok — subagent: delegated, ${read} read by the child, recursion and cap refused`,
);
process.exit(0);
