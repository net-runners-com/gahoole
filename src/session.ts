import { randomUUID } from "node:crypto";
import type { Agent } from "@mastra/core/agent";
import type { Memory } from "@mastra/memory";
import type { Lifecycle, SessionEndReason } from "./lifecycle.js";
import { turnStore, type TurnContext } from "./turn-context.js";
import { MODEL } from "./agent.js";
import { summarizeThread } from "./summarize.js";

/**
 * A session is one Mastra memory thread. Ending a session and starting the
 * next one is the only way to change threads — which is what makes /clear,
 * /compact, /resume and /fork all land on the same code path.
 */
export class Session {
  readonly id: string;
  #turns = 0;
  #startedAt = Date.now();
  #closed = false;

  /** Supplied by the CLI; replaces agent.generate() when set. */
  static backend?: {
    ask(prompt: string, attachments?: string[]): Promise<string>;
  };

  private constructor(
    id: string,
    private readonly agent: Agent,
    private readonly memory: Memory,
    private readonly lifecycle: Lifecycle,
    readonly resourceId: string,
  ) {
    this.id = id;
  }

  static async start(opts: {
    agent: Agent;
    memory: Memory;
    lifecycle: Lifecycle;
    resourceId: string;
    sessionId?: string;
    source?: { kind: "clear" | "compact" | "resume" | "fork"; from: string };
  }): Promise<Session> {
    const id = opts.sessionId ?? randomUUID();
    const session = new Session(
      id,
      opts.agent,
      opts.memory,
      opts.lifecycle,
      opts.resourceId,
    );
    await opts.lifecycle.emit("SessionStart", {
      sessionId: id,
      resourceId: opts.resourceId,
      source: opts.source,
    });
    return session;
  }

  get turns(): number {
    return this.#turns;
  }

  /**
   * One turn: UserPromptSubmit → (PreToolUse/PostToolUse)* → Stop | StopFailure
   *
   * `executor` replaces the model call and nothing else — it runs inside the
   * same turn context, so tool hooks, counting and the Stop/StopFailure pair
   * behave identically. `src/demo.ts` uses it to script tool calls without an
   * API key; production callers omit it.
   */
  async run(
    prompt: string,
    executor?: (prompt: string) => Promise<string>,
    attachments: string[] = [],
  ): Promise<string> {
    if (this.#closed) throw new Error(`session ${this.id} is closed`);

    const turnId = randomUUID();
    this.#turns++;
    const startedAt = Date.now();

    await this.lifecycle.emit("UserPromptSubmit", {
      sessionId: this.id,
      turnId,
      prompt,
    });

    const ctx: TurnContext = {
      sessionId: this.id,
      turnId,
      toolCalls: 0,
      pending: new Map(),
    };

    try {
      // Mastra persists what it generates itself; nothing else does. Every
      // other path — the browser backend, which is the default, and any
      // executor — has to be written down here or the thread stays empty.
      //
      // It used to be neither. The database the README describes as holding
      // the messages held none of them, and everything downstream inherited
      // that: the rate-limit handoff carried one line, /compact summarized an
      // empty conversation, and a resumed session resumed nothing.
      let persist = false;
      const text = await turnStore.run(ctx, async () => {
        if (executor) {
          persist = true;
          return executor(prompt);
        }
        if (Session.backend) {
          persist = true;
          return Session.backend.ask(prompt, attachments);
        }
        const res = await this.agent.generate(prompt, {
          memory: { resource: this.resourceId, thread: this.id },
        });
        return res.text ?? "";
      });
      if (persist) await this.#save(prompt, text);

      await this.lifecycle.emit("Stop", {
        sessionId: this.id,
        turnId,
        text,
        toolCalls: ctx.toolCalls,
        ms: Date.now() - startedAt,
      });
      return text;
    } catch (e) {
      await this.lifecycle.emit("StopFailure", {
        sessionId: this.id,
        turnId,
        prompt,
        error: e instanceof Error ? e : new Error(String(e)),
        ms: Date.now() - startedAt,
      });
      throw e;
    }
  }

  async end(reason: SessionEndReason): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.lifecycle.emit("SessionEnd", {
      sessionId: this.id,
      reason,
      turns: this.#turns,
      ms: Date.now() - this.#startedAt,
    });
  }

  /** Close this session and open an empty one. */
  async clear(): Promise<Session> {
    await this.end("clear");
    return Session.start({
      agent: this.agent,
      memory: this.memory,
      lifecycle: this.lifecycle,
      resourceId: this.resourceId,
      source: { kind: "clear", from: this.id },
    });
  }

  /**
   * Summarize this thread, then open a new one seeded with that summary. The
   * summary itself costs a model call — Mastra runs it against the model given
   * here, not the agent's.
   */
  async compact(): Promise<{ next: Session; summary: string }> {
    const summary = await summarizeThread(
      this.memory,
      this.id,
      this.resourceId,
      "Summarize this conversation so it can be continued in a fresh session. Keep decisions, facts the user stated about themselves, and open questions. Drop pleasantries.",
    );

    await this.end("compact");
    const next = await Session.start({
      agent: this.agent,
      memory: this.memory,
      lifecycle: this.lifecycle,
      resourceId: this.resourceId,
      source: { kind: "compact", from: this.id },
    });
    await next.seedContext(
      `Summary of the previous session, carried forward:\n\n${summary}`,
    );
    return { next, summary };
  }

  /** Close this session and re-open an existing thread by id. */
  async resume(threadId: string): Promise<Session> {
    await this.end("resume");
    return Session.start({
      agent: this.agent,
      memory: this.memory,
      lifecycle: this.lifecycle,
      resourceId: this.resourceId,
      sessionId: threadId,
      source: { kind: "resume", from: this.id },
    });
  }

  /**
   * Branch: copy this thread's messages into a new one and continue there.
   * The original thread is left intact and can still be resumed.
   */
  async fork(): Promise<Session> {
    // No title: the lineage is already recorded in the thread's metadata, and
    // the fork gets titled by whatever is asked in it first.
    const { thread } = await this.memory.cloneThread({
      sourceThreadId: this.id,
    });
    await this.end("fork");
    return Session.start({
      agent: this.agent,
      memory: this.memory,
      lifecycle: this.lifecycle,
      resourceId: this.resourceId,
      sessionId: thread.id,
      source: { kind: "fork", from: this.id },
    });
  }

  /** Write a message into the thread without spending a turn on it. */
  async seedContext(text: string): Promise<void> {
    await this.#write([{ role: "user", text }]);
  }

  /** An exchange the model did not persist for us. */
  async #save(prompt: string, answer: string): Promise<void> {
    await this.#write([
      { role: "user", text: prompt },
      { role: "assistant", text: answer },
    ]);
  }

  async #write(items: { role: "user" | "assistant"; text: string }[]): Promise<void> {
    const messages = items
      .filter((m) => m.text.trim())
      .map((m) => ({
        id: randomUUID(),
        threadId: this.id,
        resourceId: this.resourceId,
        role: m.role,
        type: "text",
        content: { format: 2, parts: [{ type: "text", text: m.text }] },
        createdAt: new Date(),
      }));
    if (messages.length === 0) return;
    // A turn that answered is not a turn to lose over a write failing.
    await this.memory
      .saveMessages({ messages: messages as never })
      .catch((e: unknown) => {
        console.error(
          `[session] could not save the exchange: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }
}
