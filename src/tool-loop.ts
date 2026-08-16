import type { Backend } from "./backends/index.js";
import type { Lifecycle } from "./lifecycle.js";
import { createToolHooks } from "./agent.js";
import {
  buildPreamble,
  buildReminder,
  describeTool,
  formatResult,
  parseCalls,
  parseMalformed,
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
/**
 * Does this reply talk about running a tool without actually calling one?
 * Deliberately narrow — it wants an announcement ("I will use write_file"),
 * not a passing mention, because a false positive spends a query.
 */
function announcesTool(answer: string, tools: string[]): boolean {
  const named = tools.some((t) => answer.includes(t));
  if (!named) return false;
  return /を使用|を使い|使います|してみます|作成します|実行します|will use|let me|going to|I will/i.test(
    answer,
  );
}

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

  async ask(prompt: string, attachments: string[] = []): Promise<string> {
    if (Object.keys(this.tools).length === 0)
      return this.inner.ask(prompt, attachments);

    const specs = Object.entries(this.tools).map(([n, t]) => describeTool(n, t));

    // The preamble rides on the first question rather than costing a turn of
    // its own. It used to be sent separately, on the theory that rules and a
    // question in one message get the question answered and the rules
    // forgotten — but the per-question reminder is what actually holds the
    // behaviour, and the extra round trip doubled the latency of the first
    // question in every session.
    const head = this.#primed
      ? buildReminder(specs)
      : `${buildPreamble(specs)}\n\n${buildReminder(specs)}`;
    this.#primed = true;

    let answer = await this.inner.ask(`${head}\n\n${prompt}`, attachments);

    let nudged = false;
    for (let i = 0; i < this.maxIterations; i++) {
      const calls = parseCalls(answer);

      if (calls.length === 0) {
        // A marker line that would not parse is an attempt, not prose. Saying
        // so gets a corrected call; swallowing it ends the turn having done
        // nothing while the reply says otherwise.
        const bad = parseMalformed(answer);
        if (!nudged && bad.length > 0) {
          nudged = true;
          answer = await this.inner.ask(
            `Your ${"TOOL_CALL:"} line could not be read as JSON (${bad[0]!.reason}), so nothing ran. Send it again. Put file contents in a ${"TOOL_BODY:"} block instead of inside the JSON.`,
          );
          continue;
        }

        // A model that says "I will use write_file" and stops has done
        // nothing, and the user sees a turn that ended with an intention. One
        // nudge is enough to convert it into the call it meant to make;
        // nudging twice would just spend the rate limit on insistence.
        if (!nudged && announcesTool(answer, Object.keys(this.tools))) {
          nudged = true;
          answer = await this.inner.ask(
            `You described using a tool but did not emit the ${"TOOL_CALL:"} line, so nothing ran. Emit it now, on its own line, with no other text.`,
          );
          continue;
        }
        return stripCalls(answer);
      }

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
      | {
          execute?: (input: unknown, ctx?: unknown) => Promise<unknown>;
          inputSchema?: { shape?: Record<string, { isOptional?: () => boolean }> };
        }
      | undefined;

    // A call missing a required field must not be reported as a success. It
    // happened: asked to write a file, the model emitted the JSON but not the
    // block carrying the contents, and two "write_file ok" lines went by with
    // nothing on disk. Say what is missing and the next attempt has it.
    const shape = tool?.inputSchema?.shape;
    if (shape) {
      const given = (input ?? {}) as Record<string, unknown>;
      const missing = Object.entries(shape)
        // Required unless the schema says otherwise: a field that cannot say
        // is treated as required, which fails loudly rather than silently.
        .filter(([k, v]) => given[k] === undefined && v?.isOptional?.() !== true)
        .map(([k]) => k);
      if (missing.length > 0) {
        const error = new Error(
          `${name} is missing ${missing.join(", ")} — file contents go in a fenced code block on the line after the call`,
        );
        await this.#hooks.afterToolCall({ toolName: name, error });
        return { error };
      }
    }

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
