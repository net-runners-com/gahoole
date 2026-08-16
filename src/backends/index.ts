import type { Agent } from "@mastra/core/agent";
import { AiModeBackend } from "./aimode.js";

/**
 * A backend turns a prompt into text. Two exist, and they are not equivalent:
 *
 *   ai-mode  Google AI Mode driven through a browser. No API key, no cost,
 *            no tool calling, and a silent rate limit at roughly 77-100
 *            queries. This is the default.
 *   api      A Mastra agent on the Claude API. Supports tool calling, needs
 *            ANTHROPIC_API_KEY.
 *
 * Both plug into `Session.run(prompt, executor)`, so the lifecycle, hooks,
 * sessions and handoff machinery are identical either way.
 */
export interface Backend {
  readonly name: string;
  /** `attachments` are absolute paths to local images, when the backend takes them. */
  ask(prompt: string, attachments?: string[]): Promise<string>;
  /** Begin a new model-side conversation, when the backend has one. */
  reset?(): void;
  /** A second, independent conversation — what a subagent runs in. */
  fork?(): Promise<Backend>;
  close?(): Promise<void>;
}

export type BackendKind = "ai-mode" | "api";

export function backendKind(): BackendKind {
  return process.env.GAHOOLE_BACKEND === "api" ? "api" : "ai-mode";
}

export function createBackend(
  kind: BackendKind,
  agent: Agent,
  resourceId: string,
  sessionIdOf: () => string,
): Backend {
  if (kind === "ai-mode") {
    return new AiModeBackend({
      headed: process.env.GAHOOLE_HEADED === "1",
      hl: process.env.GAHOOLE_HL,
    });
  }
  const api: Backend = {
    name: "claude-api",
    // The API is stateless per call, so a fork is the same object.
    fork: async () => api,
    async ask(prompt: string) {
      const res = await agent.generate(prompt, {
        memory: { resource: resourceId, thread: sessionIdOf() },
      });
      return res.text ?? "";
    },
  };
  return api;
}

export { AiModeBackend } from "./aimode.js";
export { AiModeRateLimitError } from "./aimode.js";
