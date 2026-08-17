import fs from "node:fs";
import type { Agent } from "@mastra/core/agent";
import { AiModeBackend, AiModeRateLimitError } from "./aimode.js";

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

export type BackendKind = "ai-mode" | "api" | "stub" | "replay";

export function backendKind(): BackendKind {
  const want = process.env.GAHOOLE_BACKEND;
  return want === "api" || want === "stub" || want === "replay" ? want : "ai-mode";
}

/**
 * A recorded session, played back.
 *
 * `GAHOOLE_BACKEND=replay GAHOOLE_REPLAY=run.jsonl` answers from what the real
 * backend said, in order. Everything above it — the tool loop, the nudges, the
 * autonomous loop, the CLI — runs for real against real answers, instantly and
 * identically every time.
 *
 * The prompts are checked as they go, not because they have to match but
 * because a divergence is the interesting part: it means the change under test
 * altered what would have been asked, and the rest of the recording is about
 * a conversation that no longer exists. It says so and keeps going, since a
 * changed prompt is usually the point.
 */
function createReplay(): Backend {
  const file = process.env.GAHOOLE_REPLAY ?? "";
  let turns: { prompt: string; answer: string }[] = [];
  try {
    turns = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { prompt: string; answer: string });
  } catch {
    turns = [];
  }

  let i = 0;
  let warned = false;
  const replay: Backend = {
    name: `replay(${turns.length})`,
    fork: async () => replay,
    reset: () => {
      i = 0;
    },
    async ask(prompt: string) {
      const turn = turns[i];
      if (!turn) {
        throw new Error(
          `the recording has ${turns.length} turns and this is number ${i + 1}`,
        );
      }
      i++;
      const gist = (s: string) => s.replace(/\s+/g, " ").trim().slice(-90);
      if (!warned && gist(turn.prompt) !== gist(prompt)) {
        warned = true;
        process.stderr.write(
          `[replay] turn ${i} was asked something else — from here the ` +
            `recording answers a different conversation\n` +
            `  recorded: …${gist(turn.prompt)}\n` +
            `  now:      …${gist(prompt)}\n`,
        );
      }
      return turn.answer;
    },
  };
  return replay;
}

/**
 * A backend that answers from a script.
 *
 * `GAHOOLE_BACKEND=stub GAHOOLE_STUB='["first","second"]'` — replies come out
 * in order and the last one repeats. It exists so the CLI can be driven end to
 * end without a browser, a key or a network: the largest file in the project
 * is `cli.ts`, and until this it could only be tested by using it.
 *
 * The replies may carry TOOL_CALL lines like any other, so the tool loop, the
 * hooks and the approval prompt are all exercised for real.
 */
function createStub(): Backend {
  let replies: string[] = [];
  try {
    const raw = process.env.GAHOOLE_STUB ?? "[]";
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) replies = parsed.map(String);
  } catch {
    replies = [process.env.GAHOOLE_STUB ?? ""];
  }
  let i = 0;
  const stub: Backend = {
    name: "stub",
    fork: async () => stub,
    reset: () => {
      i = 0;
    },
    async ask(prompt: string) {
      // Echoed back so a test can assert on what the model was actually sent.
      if (process.env.GAHOOLE_STUB_ECHO === "1") {
        process.stderr.write(`[stub<] ${prompt.replace(/\n/g, "\\n")}\n`);
      }
      const reply = replies[Math.min(i, replies.length - 1)] ?? "";
      i++;
      // The one failure worth being able to script: a rate limit is the only
      // error the program has a whole recovery path for, and that path could
      // not be exercised without waiting for a real one.
      if (reply === "__RATE_LIMIT__") throw new AiModeRateLimitError();
      return reply;
    },
  };
  return stub;
}

export function createBackend(
  kind: BackendKind,
  agent: Agent,
  resourceId: string,
  sessionIdOf: () => string,
): Backend {
  if (kind === "stub") return createStub();
  if (kind === "replay") return createReplay();
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
export { AiModeRateLimitError, AiModeRefusedError } from "./aimode.js";
