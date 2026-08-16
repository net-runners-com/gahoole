/**
 * The lifecycle this project implements:
 *
 *   process   boot ──────────────────────────────────── exit
 *     └ session  SessionStart ──────────────── SessionEnd
 *         │      (/clear /compact /resume /fork re-establish it)
 *         └ turn   UserPromptSubmit ──── Stop / StopFailure
 *             └ tool call  PreToolUse ──── PostToolUse
 *
 * Every scope opens with exactly one event and closes with exactly one,
 * and an inner scope never outlives the scope that opened it.
 */

export type SessionEndReason =
  | "exit"
  | "clear"
  | "compact"
  | "resume"
  | "fork"
  | "error";

export interface ProcessStartEvent {
  pid: number;
  argv: string[];
  cwd: string;
}

export interface ProcessExitEvent {
  code: number;
  /** every session this process opened, in order */
  sessions: string[];
}

export interface SessionStartEvent {
  sessionId: string;
  resourceId: string;
  /** set when this session continues or branches another one */
  source?: { kind: "clear" | "compact" | "resume" | "fork"; from: string };
}

export interface SessionEndEvent {
  sessionId: string;
  reason: SessionEndReason;
  turns: number;
  ms: number;
}

export interface UserPromptSubmitEvent {
  sessionId: string;
  turnId: string;
  prompt: string;
}

export interface StopEvent {
  sessionId: string;
  turnId: string;
  text: string;
  toolCalls: number;
  ms: number;
}

export interface StopFailureEvent {
  sessionId: string;
  turnId: string;
  /**
   * The prompt that failed. Carried on the event because a turn that throws
   * may never have been persisted to the thread — without this, a handoff
   * built by reading storage would be missing the exchange that mattered most.
   */
  prompt: string;
  error: Error;
  ms: number;
}

export interface PreToolUseEvent {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface PostToolUseEvent {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  output?: unknown;
  error?: unknown;
  ms: number;
}

export interface LifecycleEvents {
  ProcessStart: ProcessStartEvent;
  ProcessExit: ProcessExitEvent;
  SessionStart: SessionStartEvent;
  SessionEnd: SessionEndEvent;
  UserPromptSubmit: UserPromptSubmitEvent;
  Stop: StopEvent;
  StopFailure: StopFailureEvent;
  PreToolUse: PreToolUseEvent;
  PostToolUse: PostToolUseEvent;
}

export type LifecycleEventName = keyof LifecycleEvents;

/**
 * PreToolUse is the one hook that can change what happens next: returning
 * `{ deny }` stops the call before the tool runs. Every other hook is an
 * observer — its return value is ignored.
 */
export interface PreToolUseDecision {
  deny: string;
}

export type HookResult<E extends LifecycleEventName> = E extends "PreToolUse"
  ? void | PreToolUseDecision | Promise<void | PreToolUseDecision>
  : void | Promise<void>;

export type Hook<E extends LifecycleEventName> = (
  event: LifecycleEvents[E],
) => HookResult<E>;

export class ToolDeniedError extends Error {
  constructor(
    readonly toolName: string,
    readonly reason: string,
  ) {
    super(`PreToolUse denied ${toolName}: ${reason}`);
    this.name = "ToolDeniedError";
  }
}

/**
 * Hooks run in registration order. A throwing observer hook is logged and
 * skipped rather than failing the turn — a hook is instrumentation, and
 * instrumentation that can take down the agent is worse than no hook. The
 * exception is a PreToolUse deny, which is a decision, not a failure.
 */
export class Lifecycle {
  #hooks = new Map<LifecycleEventName, Hook<LifecycleEventName>[]>();

  on<E extends LifecycleEventName>(event: E, hook: Hook<E>): this {
    const list = this.#hooks.get(event) ?? [];
    list.push(hook as Hook<LifecycleEventName>);
    this.#hooks.set(event, list);
    return this;
  }

  async emit<E extends Exclude<LifecycleEventName, "PreToolUse">>(
    event: E,
    payload: LifecycleEvents[E],
  ): Promise<void> {
    for (const hook of this.#hooks.get(event) ?? []) {
      try {
        await hook(payload);
      } catch (e) {
        console.error(`[lifecycle] ${event} hook threw:`, e);
      }
    }
  }

  /** Returns the first deny, or undefined if every hook allows the call. */
  async emitPreToolUse(
    payload: PreToolUseEvent,
  ): Promise<PreToolUseDecision | undefined> {
    for (const hook of this.#hooks.get("PreToolUse") ?? []) {
      let decision: void | PreToolUseDecision;
      try {
        decision = (await hook(payload)) as void | PreToolUseDecision;
      } catch (e) {
        console.error("[lifecycle] PreToolUse hook threw:", e);
        continue;
      }
      if (decision && "deny" in decision) return decision;
    }
    return undefined;
  }
}
