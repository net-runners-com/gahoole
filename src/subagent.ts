import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Backend } from "./backends/index.js";
import type { Lifecycle } from "./lifecycle.js";
import { ToolLoop } from "./tool-loop.js";
import { log } from "./output.js";

/**
 * Subagents.
 *
 * `spawn_agent` hands a self-contained task to a second conversation and
 * returns only what it concluded. The point is context, not parallelism: a
 * subagent can read twenty files and report three sentences, and the parent
 * never carries the twenty files.
 *
 * Three things it deliberately does not do.
 *
 * It does not recurse — the child's tool set has `spawn_agent` removed, so a
 * runaway cannot spend the rate limit on grandchildren.
 *
 * It does not run in parallel. Every subagent turn is a query against a limit
 * measured at roughly 80 per ten minutes, and two agents racing to spend it
 * finish no sooner than one.
 *
 * It does not get its own hooks. The child's tool calls fire the same
 * PreToolUse and PostToolUse as the parent's, so approval still asks and the
 * guard still refuses — a task delegated to a subagent is not a way around
 * the policy.
 */

export interface SpawnDeps {
  /** Opens a second conversation; see AiModeBackend.fork. */
  fork: () => Promise<Backend>;
  /** The parent's tools; `spawn_agent` is removed from what the child gets. */
  tools: Record<string, unknown>;
  lifecycle: Lifecycle;
  /** Tool rounds the child may take before it must answer. */
  maxRounds?: number;
  /** Subagents per session, since each one costs queries. */
  maxSpawns?: number;
}

export const SPAWN_TOOL = "spawn_agent";

export function createSpawnTool(deps: SpawnDeps) {
  const maxSpawns = deps.maxSpawns ?? 4;
  let spawned = 0;

  return createTool({
    id: SPAWN_TOOL,
    description:
      "Delegate a self-contained task to a subagent and get back its findings. Use for work that needs to read a lot but report a little, such as searching several files. Give it the whole task in one instruction; it cannot ask you questions.",
    inputSchema: z.object({
      task: z
        .string()
        .describe(
          "The complete instruction, including what to report back. The subagent sees nothing of this conversation.",
        ),
    }),
    outputSchema: z.object({ report: z.string(), rounds: z.number() }),
    execute: async ({ task }) => {
      if (spawned >= maxSpawns) {
        throw new Error(
          `already spawned ${spawned} subagents this session — do this one yourself`,
        );
      }
      spawned++;

      // Everything the parent has, minus the ability to delegate again.
      const childTools = Object.fromEntries(
        Object.entries(deps.tools).filter(([name]) => name !== SPAWN_TOOL),
      );

      const backend = await deps.fork();
      const loop = new ToolLoop(
        backend,
        childTools,
        deps.lifecycle,
        deps.maxRounds ?? 3,
      );

      log(`\x1b[2m  ↳ subagent: ${task.slice(0, 70)}${task.length > 70 ? "…" : ""}\x1b[0m`);
      const started = Date.now();
      try {
        const report = await loop.ask(
          `${task}\n\nAnswer with your findings only. You are reporting to another agent, not to a person, so leave out pleasantries and offers of further help.`,
        );
        log(
          `\x1b[2m  ↲ subagent done · ${((Date.now() - started) / 1000).toFixed(1)}s\x1b[0m`,
        );
        return { report, rounds: 1 };
      } finally {
        // Close the tab whatever happened; a leaked page holds a conversation
        // open and, eventually, memory.
        await backend.close?.().catch(() => {});
      }
    },
  });
}
