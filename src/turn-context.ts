import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Tool hooks are configured once on the Agent, but PreToolUse/PostToolUse have
 * to report which session and turn they belong to. Mastra runs tool calls
 * inside the same async context as the `generate()` that triggered them, so an
 * AsyncLocalStorage carries the turn down to the hooks without threading it
 * through every call site.
 */
export interface TurnContext {
  sessionId: string;
  turnId: string;
  /** incremented by the PreToolUse bridge; read back when the turn closes */
  toolCalls: number;
  /**
   * Mastra's tool hooks do not expose a tool call id, so Pre/Post are paired by
   * tool name in call order. With two concurrent calls to the *same* tool the
   * durations can be swapped between them; the events themselves are still
   * correct.
   */
  pending: Map<string, { seq: number; startedAt: number }[]>;
}

export const turnStore = new AsyncLocalStorage<TurnContext>();

export const currentTurn = (): TurnContext | undefined => turnStore.getStore();
