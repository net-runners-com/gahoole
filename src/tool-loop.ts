import type { Backend } from "./backends/index.js";
import type { Lifecycle } from "./lifecycle.js";
import { createToolHooks } from "./agent.js";
import { log } from "./output.js";
import type { Profile } from "./profiles.js";
import { COMPOSER_MAX } from "./backends/aimode.js";
import {
  buildPreamble,
  buildReminder,
  describeTool,
  formatResults,
  parseBody,
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
/**
 * Does the reply claim work that no tool call could have done?
 *
 * This is the failure the benchmark surfaced most often: a turn that spends
 * zero tool calls and reports the job finished. Reasoning alone reached 3/3
 * on questions and 1/3 on tasks, and every one of those failures had an empty
 * tool count — so the gap is not capability, it is acting rather than
 * describing.
 */
function claimsWork(answer: string): boolean {
  return /(作成しました|書き込みました|保存しました|実行しました|修正しました|完了しました|削除しました|created|wrote|saved|executed|compiled|I have (written|created|run))/i.test(
    answer,
  );
}

/** Does the request need something done, rather than answered? */
/**
 * What follows a message of results.
 *
 * The reminder goes with it, and that is not belt and braces. Continuation
 * messages used to carry no instructions at all, and a recording showed what
 * that costs on a backend that is a search engine: handed the contents of two
 * files and asked to continue, it went and searched the web for "how to
 * summarize data in excel" and came back with six links. The rules only hold
 * where they are said.
 */
const CONTINUE = "Continue. Answer the original question using these results.";

/** A file that exists to be run rather than to be read. */
const RUNNABLE = /\.(py|js|mjs|ts|sh|rb|pl)$/i;

/** Tools that leave something behind. Reading is not doing. */
const CHANGES = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "run_command",
  "write_note",
]);

/**
 * Room left for the recap a rotation prepends.
 *
 * A rotated profile is a new conversation with no memory of the last one, so
 * the backend prepends what was said. That arrives after this message has
 * been built, which is why the space for it has to be left rather than
 * measured.
 */
const RECAP_ALLOWANCE = 1400;

export function needsAction(prompt: string): boolean {
  return /(作って|作成|書いて|書き込|保存|実行して|コンパイル|直して|修正|削除|並べ替え|数えて|確認して|write|create|save|run |compile|fix |delete|append|read the file)/i.test(
    prompt,
  );
}

function announcesTool(answer: string, tools: string[]): boolean {
  const named = tools.some((t) => answer.includes(t));
  if (!named) return false;
  return /を使用|を使い|使います|してみます|作成します|実行します|will use|let me|going to|I will/i.test(
    answer,
  );
}

export class ToolLoop implements Backend {
  #primed = false;
  #tools: Record<string, unknown>;
  #rounds: number;
  /** Sent once when the profile becomes active; see profiles.ts. */
  #brief = "";
  /** Restated with every question. */
  #hint = "";
  /**
   * Round trips to the model, which is the only cost that matters here: the
   * rate limit counts queries, not tool calls. Two tools in one reply is one
   * query; counting tool calls instead would have hidden exactly that.
   */
  #queries = 0;
  /** The previous round's calls, for spotting a turn going in circles. */
  #lastCalls = "";
  /** How many times that has happened, so the effect of noticing is countable. */
  #spins = 0;
  readonly #hooks: ReturnType<typeof createToolHooks>;

  constructor(
    private readonly inner: Backend,
    tools: Record<string, unknown>,
    lifecycle: Lifecycle,
    maxIterations = 4,
  ) {
    this.#tools = tools;
    this.#rounds = maxIterations;
    this.#hooks = createToolHooks(lifecycle);
  }

  /**
   * Switch profile mid-session.
   *
   * Both halves change together — a brief that says "you cannot write files"
   * next to a tool list that still has `write_file` in it teaches the model
   * that the brief is negotiable. Priming is dropped so the next question
   * carries the new preamble; the model-side conversation is left alone, so
   * switching profiles does not lose what has been said.
   */
  use(profile: Profile, tools: Record<string, unknown>): void {
    this.#tools = tools;
    this.#rounds = profile.rounds;
    this.#brief = profile.brief;
    this.#hint = profile.hint;
    this.#primed = false;
  }

  get tools(): Record<string, unknown> {
    return this.#tools;
  }

  get queries(): number {
    return this.#queries;
  }

  /** Rounds that repeated the previous round exactly. */
  get spins(): number {
    return this.#spins;
  }

  get name(): string {
    return `${this.inner.name}+tools`;
  }

  reset(): void {
    this.#primed = false;
    this.#lastCalls = "";
    this.inner.reset?.();
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  async ask(prompt: string, attachments: string[] = []): Promise<string> {
    // A profile with no tools still has a brief, and it is the whole of what
    // makes that profile different — so this returns early with the brief
    // attached rather than with the prompt bare.
    if (Object.keys(this.#tools).length === 0) {
      const head = [this.#primed ? "" : this.#brief, this.#hint]
        .filter(Boolean)
        .join("\n\n");
      this.#primed = true;
      this.#queries++;
      return this.inner.ask(head ? `${head}\n\n${prompt}` : prompt, attachments);
    }

    const specs = Object.entries(this.#tools).map(([n, t]) => describeTool(n, t));

    // The preamble rides on the first question rather than costing a turn of
    // its own. It used to be sent separately, on the theory that rules and a
    // question in one message get the question answered and the rules
    // forgotten — but the per-question reminder is what actually holds the
    // behaviour, and the extra round trip doubled the latency of the first
    // question in every session.
    const head = (
      this.#primed
        ? [buildReminder(specs), this.#hint]
        : [this.#brief, buildPreamble(specs), buildReminder(specs), this.#hint]
    )
      .filter(Boolean)
      .join("\n\n");
    this.#primed = true;

    this.#queries++;
    let answer = await this.inner.ask(`${head}\n\n${prompt}`, attachments);

    // Prose from every reply in the turn, not just the last one.
    //
    // Only the final reply used to survive, and everything said on the way to
    // it was thrown away — including, it turned out, the plan. An autonomous
    // run opens by asking for a numbered list; that reply also carries tool
    // calls, so the loop ran them, asked the model to continue, and returned
    // the continuation. The list never reached the parser, which reported "no
    // plan came back" on every autonomous task across five measured runs and
    // sent each of them down the open-ended path instead.
    // A reply is kept when it earned its place: it carried tool calls, or it
    // is the answer the turn ends on. A reply that had to be nudged is not
    // kept — the nudge fires because that reply claimed work it had not done,
    // and repeating the claim is the one thing worth losing.
    const said: string[] = [];
    const keep = (text: string) => {
      const prose = stripCalls(text).trim();
      if (prose && !said.includes(prose)) said.push(prose);
    };

    let nudged = false;
    let ran = 0;
    /** Has any call actually changed something, rather than looked at it? */
    let changed = false;
    /** Follow-ups spent asking for a file's contents; see below. */
    let bodiesAsked = 0;
    /** A program this turn wrote, if it has not been run. */
    let wrote: string | undefined;
    let ranSomething = false;
    // The budget can grow once, when the turn turns out to be a procedure
    // rather than a question — see the use_skill case below.
    let rounds = this.#rounds;
    for (let i = 0; i < rounds; i++) {
      const calls = parseCalls(answer);

      if (calls.length === 0) {
        // A marker line that would not parse is an attempt, not prose. Saying
        // so gets a corrected call; swallowing it ends the turn having done
        // nothing while the reply says otherwise.
        const bad = parseMalformed(answer);
        if (!nudged && bad.length > 0) {
          nudged = true;
          this.#queries++;
          answer = await this.inner.ask(
            `Your ${"TOOL_CALL:"} line could not be read as JSON (${bad[0]!.reason}), so nothing ran. Send it again. Put file contents in a ${"TOOL_BODY:"} block instead of inside the JSON.`,
          );
          continue;
        }

        // A model that says "I will use write_file" and stops has done
        // nothing, and the user sees a turn that ended with an intention. One
        // nudge is enough to convert it into the call it meant to make;
        // nudging twice would just spend the rate limit on insistence.
        if (!nudged && announcesTool(answer, Object.keys(this.#tools))) {
          nudged = true;
          this.#queries++;
          answer = await this.inner.ask(
            `You described using a tool but did not emit the ${"TOOL_CALL:"} line, so nothing ran. Emit it now, on its own line, with no other text.`,
          );
          continue;
        }

        // A program was written and never run.
        //
        // Asked for a spreadsheet, the turn wrote seven kilobytes of openpyxl
        // and stopped — twice, consistently. The file it was asked for did
        // not exist, and the reply described it as though it did. Nothing
        // above catches this: something changed, so the "nothing happened"
        // nudge stays quiet, and the reply reads like success.
        //
        // Narrow on purpose. A script that was written and not run is the
        // one case where the program can tell the job is unfinished without
        // knowing what the job was.
        if (!nudged && wrote && !ranSomething) {
          nudged = true;
          this.#queries++;
          answer = await this.inner.ask(
            `You wrote ${wrote} and did not run it, so whatever it makes does ` +
              `not exist yet. Run it now with ${"TOOL_CALL:"} run_command and ` +
              `read what it printed. If it is not meant to be run, say so in ` +
              `one sentence.`,
          );
          continue;
        }

        // Or it reports the work done having called nothing at all — the
        // benchmark's most common failure, and the one a user is least likely
        // to catch, because the reply reads exactly like success.
        // Reading is not doing. The guard used to be "nothing ran at all",
        // which let through the turn that reads a reference, prints the file
        // it was supposed to write, and stops — measured on a plugin skill,
        // which read reference.md and then set out the spec as prose. What
        // matters is whether anything *changed*, not whether anything ran.
        if (!nudged && !changed && (claimsWork(answer) || needsAction(prompt))) {
          nudged = true;
          this.#queries++;
          answer = await this.inner.ask(
            `No tool ran, so nothing actually happened — anything you reported is a guess. Do it for real now: emit one ${"TOOL_CALL:"} line and nothing else. If the task genuinely needs no tool, say why in one sentence.`,
          );
          continue;
        }
        keep(answer);
        return this.#finish(said, answer);
      }

      keep(answer);
      // Attempted, not succeeded: a call that was denied still means the model
      // tried to do the thing, and telling it nothing happened would be worse
      // advice than letting it report the refusal.
      if (calls.some((c) => CHANGES.has(c.tool))) changed = true;
      if (calls.some((c) => c.tool === "run_command")) ranSomething = true;
      for (const c of calls) {
        const p = (c.input as { path?: string }).path;
        if (c.tool === "write_file" && p && RUNNABLE.test(p)) wrote = p;
      }

      // A write with no contents: ask for them, rather than for the call
      // again.
      //
      // Four rewordings of the protocol did not stop this. Asked for a
      // spreadsheet, the model replied with sixty-seven characters — the
      // write_file line and nothing under it — three times running, then said
      // the environment was broken. The writes that did work were all short;
      // the ones that failed were all long programs. Telling it to resend the
      // call gets the same call, because the call was never the missing part.
      //
      // So the missing part is what gets asked for, on its own, in the shape
      // it is already producing: one thing per reply.
      for (const call of calls) {
        const input = call.input as Record<string, unknown>;
        if (call.tool !== "write_file" || typeof input.content === "string") continue;
        if (bodiesAsked >= 2) continue;
        bodiesAsked++;
        const name = String(input.path ?? "that file");
        // Asked as a question, and asked again differently if the first form
        // is declined.
        //
        // The first version was an instruction — "send the contents now,
        // nothing else" — and this backend is a search engine: it answered
        // "この検索に対しては回答することができなかったようです" three times while the
        // file stayed empty. A question it can answer gets an answer.
        const ways = [
          `${name} の中身はどうなりますか？ ファイル全体を1つのコードブロックで書いてください。`,
          `What should the complete contents of ${name} be? Write the whole file in a single fenced code block.`,
        ];
        for (const way of ways) {
          this.#queries++;
          const sent = await this.inner
            .ask(way)
            .catch(() => "");
          const body = parseBody(sent);
          if (body) {
            input.content = body;
            break;
          }
        }
      }

      // Loading a skill turns the turn into a procedure: read the reference,
      // look at the data, write the spec, check it, build it. Measured, four
      // rounds ran out having read one file — the same wall the typed
      // /skill command hit before it was given a working budget.
      // Choosing a skill ends the turn. The choice is all this turn was for,
      // and the caller runs the steps next — but told to stop and handed its
      // results anyway, the model carried on for twelve more calls and built
      // the thing itself with pandas. An instruction not to continue competes
      // with the results in front of it; not being asked to continue does
      // not.
      if (calls.some((c) => c.tool === "use_skill")) {
        return this.#finish(said, answer);
      }

      // The same call, with the same arguments, twice running is not progress.
      // It is what an autonomous run looks like when it has lost track of what
      // it already did, and left alone it spends the rest of the budget doing
      // it again — the benchmark's autonomous group swung between 19 and 37
      // queries for the same three tasks, and this is one of the ways.
      const signature = calls
        .map((c) => `${c.tool}:${JSON.stringify(c.input)}`)
        .join("|");
      const repeated = signature === this.#lastCalls;
      this.#lastCalls = signature;
      if (repeated) {
        this.#spins++;
        // Said out loud: a detector nobody can see is a detector nobody can
        // tell is working, which is exactly the position the first version of
        // this left the measurement in.
        log(
          `\x1b[33m  ↺ same call again — ${calls.map((c) => c.tool).join(", ")}\x1b[0m`,
        );
      }

      ran += calls.length;
      void ran;
      const outcomes: {
        tool: string;
        outcome: { output?: unknown; error?: unknown };
      }[] = [];
      for (const call of calls) {
        outcomes.push({
          tool: call.tool,
          outcome: await this.#run(call.tool, call.input),
        });
      }
      // One budget for the message, and the message is not only the results.
      //
      // The reminder rides on every question, the instruction follows the
      // results, and on a rotation a recap of the conversation is prepended to
      // all of it. A fixed results budget ignored every one of those: measured
      // running a plugin skill, two large reads plus the reminder plus a recap
      // went past what the composer accepts, the page failed to generate at
      // all, and the failure text came back as if it were the answer.
      const follow = `\n\n${CONTINUE}`;
      const budget = Math.max(
        1000,
        COMPOSER_MAX - head.length - follow.length - RECAP_ALLOWANCE,
      );
      const results = formatResults(outcomes, budget);

      this.#queries++;
      answer = await this.inner.ask(
        `${results.join("\n")}\n\n` +
          (repeated
            ? "You just ran exactly the same call again and got the same result. " +
              "Repeating it will not change anything. Either move on to the next " +
              "step, or say what is blocking you and stop.\n\n"
            : "") +
          `${CONTINUE}\n\n${buildReminder(specs)}`,
      );
    }

    // Out of iterations: hand back what we have rather than looping forever.
    keep(answer);
    return this.#finish(said, answer);
  }

  /**
   * What the turn hands back, which is never nothing.
   *
   * A turn whose replies were all tool calls and no prose used to return the
   * empty string, and the user got tool lines followed by silence — measured
   * three times running while chasing something else. Silence is not an
   * answer; if there is no prose to give, say which it was.
   */
  #finish(said: string[], last: string): string {
    const text = said.join("\n\n").trim();
    if (text) return text;
    const bare = stripCalls(last).trim();
    if (bare) return bare;
    return "(the model answered with tool calls and no words)";
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

    const tool = this.#tools[name] as
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
        // Said as an instruction rather than a diagnosis, and with both ways
        // of sending a body. A model that was told "missing content" emitted
        // exactly the same call again, twice.
        const error = new Error(
          `${name} is missing ${missing.join(", ")}, so nothing was written. ` +
            `Send the call again with the text after it, either in a fenced ` +
            `code block or between ${"TOOL_BODY:"} and ${"TOOL_END"} lines. ` +
            `Do not repeat the call without one.`,
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
