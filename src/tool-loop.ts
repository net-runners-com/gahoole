import type { Backend } from "./backends/index.js";
import type { Lifecycle } from "./lifecycle.js";
import { createToolHooks } from "./agent.js";
import {
  buildPreamble,
  buildReminder,
  describeTool,
  formatResult,
  parseCalls,
  stripCalls,
} from "./tool-protocol.js";

/**
 * Gives a text-only backend the tool loop it does not have.
 *
 * Wraps another backend: the first turn of a session carries a preamble
 * listing the tools and the marker syntax, and every answer is scanned for
 * calls. A call is executed and its result sent back as the next turn, until
 * the model answers without asking for anything.
 *
 * Two things this deliberately does not do differently from native tool use:
 * calls go through PreToolUse/PostToolUse exactly as they would otherwise, so
 * a policy denial still denies; and a denial is reported to the model as the
 * tool's result rather than as an error, so it can choose something else.
 *
 * Must run inside `Session.run()`: the hooks read the active turn from
 * AsyncLocalStorage, and outside a turn they have nothing to attribute a call
 * to and stay silent.
 *
 * The cost is turns. Each tool call is a round trip to the model, and on AI
 * Mode every round trip counts against a rate limit of roughly 77-100
 * queries — hence `maxIterations`.
 */
export class ToolLoop implements Backend {
  #primed = false;
  readonly #hooks: ReturnType<typeof createToolHooks>;

  constructor(
    private readonly inner: Backend,
    private readonly tools: Record<string, unknown>,
    lifecycle: Lifecycle,
    private readonly maxIterations = 4,
  ) {
    this.#hooks = createToolHooks(lifecycle);
  }

  get name(): string {
    return `${this.inner.name}+tools`;
  }

  reset(): void {
    this.#primed = false;
    this.inner.reset?.();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  async ask(prompt: string): Promise<string> {
    if (Object.keys(this.tools).length === 0) return this.inner.ask(prompt);

    const specs = Object.entries(this.tools).map(([n, t]) => describeTool(n, t));

    if (!this.#primed) {
      // The preamble is its own turn: a model that receives instructions and a
      // question together tends to answer the question and forget the rules.
      await this.inner.ask(buildPreamble(specs));
      this.#primed = true;
    }

    // ...and the rule is restated with the question, because several turns
    // later the preamble no longer competes with the model's own instincts.
    let answer = await this.inner.ask(`${buildReminder(specs)}\n\n${prompt}`);

    for (let i = 0; i < this.maxIterations; i++) {
      const calls = parseCalls(answer);
      if (calls.length === 0) return stripCalls(answer);

      const results: string[] = [];
      for (const call of calls) {
        results.push(formatResult(call.tool, await this.#run(call.tool, call.input)));
      }

      answer = await this.inner.ask(
        `${results.join("\n")}\n\nContinue. Answer the original question using these results.`,
      );
    }

    // Out of iterations: hand back what we have rather than looping forever.
    return stripCalls(answer);
  }

  /** One tool call, through the same hooks a native tool call would take. */
  async #run(
    name: string,
    input: unknown,
  ): Promise<{ output?: unknown; error?: unknown }> {
    const decision = await this.#hooks.beforeToolCall({ toolName: name, input });
    if (decision) {
      await this.#hooks.afterToolCall({ toolName: name, output: decision.output });
      return { output: decision.output };
    }

    const tool = this.tools[name] as
      | { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }
      | undefined;
    if (!tool?.execute) {
      const error = new Error(`no such tool: ${name}`);
      await this.#hooks.afterToolCall({ toolName: name, error });
      return { error };
    }

    try {
      const output = await tool.execute(input, {});
      await this.#hooks.afterToolCall({ toolName: name, output });
      return { output };
    } catch (error) {
      await this.#hooks.afterToolCall({ toolName: name, error });
      return { error };
    }
  }
}
