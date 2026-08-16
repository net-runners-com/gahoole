import fs from "node:fs";
import path from "node:path";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import type { Lifecycle } from "./lifecycle.js";
import { currentTurn } from "./turn-context.js";
import { tools } from "./tools.js";

export const MODEL = "anthropic/claude-opus-5";

/** Everything — messages, thread metadata, traces — lands in this one file. */
export const DB_URL = process.env.GAHOOLE_DB_URL ?? "file:./data/gahoole.db";

export function createMemory(): Memory {
  // libSQL opens the file but will not create its parent directory.
  const file = DB_URL.startsWith("file:") ? DB_URL.slice("file:".length) : null;
  if (file) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  return new Memory({
    storage: new LibSQLStore({ id: "gahoole-storage", url: DB_URL }),
  });
}

/**
 * The bridge from Mastra's tool hooks to the PreToolUse / PostToolUse scope of
 * the lifecycle. Exported separately from the agent so it can be driven
 * directly by tests without a model call.
 *
 * A denial is returned as the tool's output — Mastra short-circuits execution
 * rather than throwing, so the model sees the refusal as a normal tool result
 * and can react to it.
 */
export function createToolHooks(lifecycle: Lifecycle) {
  return {
    beforeToolCall: async ({
      toolName,
      input,
    }: {
      toolName: string;
      input: unknown;
    }) => {
        const turn = currentTurn();
        if (!turn) return;

        const seq = ++turn.toolCalls;
        const queue = turn.pending.get(toolName) ?? [];
        queue.push({ seq, startedAt: Date.now() });
        turn.pending.set(toolName, queue);

        const decision = await lifecycle.emitPreToolUse({
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          toolCallId: `${turn.turnId}:${seq}`,
          toolName,
          input,
        });

        if (decision) {
          return {
            proceed: false as const,
            output: { denied: true, reason: decision.deny },
          };
        }
      return undefined;
    },

    afterToolCall: async ({
      toolName,
      output,
      error,
    }: {
      toolName: string;
      output?: unknown;
      error?: unknown;
    }) => {
      const turn = currentTurn();
      if (!turn) return;

      const started = turn.pending.get(toolName)?.shift();
      await lifecycle.emit("PostToolUse", {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        toolCallId: `${turn.turnId}:${started?.seq ?? 0}`,
        toolName,
        output,
        error,
        ms: started ? Date.now() - started.startedAt : 0,
      });
    },
  };
}

export function createAgent(
  lifecycle: Lifecycle,
  memory: Memory,
  /** MCP tools, already namespaced `<server>_<tool>` by MCPClient.listTools() */
  mcpTools: Record<string, unknown> = {},
): Agent {
  return new Agent({
    id: "gahoole",
    name: "Gahoole",
    instructions: [
      "You are a local assistant with a persistent memory of this conversation.",
      "Use read_file when the user asks what is in a file, and write_note when they ask you to record something.",
      "Tools whose name is prefixed with a server name come from an MCP server; prefer them for anything they cover.",
      "Keep responses focused and brief.",
    ].join(" "),
    model: MODEL,
    memory,
    // Local and MCP tools are one flat set, so they share one hook path.
    tools: { ...tools, ...(mcpTools as typeof tools) },
    hooks: createToolHooks(lifecycle),
  });
}
