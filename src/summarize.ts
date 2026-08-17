import type { Memory } from "@mastra/memory";
import { Session } from "./session.js";
import { createOllama, ollamaReady } from "./backends/ollama.js";
import type { Backend } from "./backends/index.js";
import { log } from "./output.js";

/**
 * Summarizing a thread, whichever backend is in play.
 *
 * Mastra's own `memory.summarizeThread()` takes a provider/model string, which
 * the AI Mode backend does not have — it is a browser, not a model id. So the
 * transcript is assembled here and handed to whatever backend is configured.
 * That keeps `/compact` and the rate-limit handoff working with no API key,
 * which matters because the handoff exists precisely for the case where the
 * only available model has stopped answering.
 */
/**
 * A local model, if one is running and has what was asked for. Checked once
 * per process: a summary is not worth two seconds of finding out every time.
 */
let checked: Backend | undefined | null = null;

async function localSummarizer(): Promise<Backend | undefined> {
  if (checked !== null) return checked ?? undefined;
  checked = undefined;
  if (process.env.GAHOOLE_LOCAL_SUMMARY === "0") return undefined;
  const { ok, why } = await ollamaReady();
  if (ok) {
    checked = createOllama();
    log(`\x1b[2msummaries run locally · ${why}\x1b[0m`);
  }
  return checked ?? undefined;
}

export async function summarizeThread(
  memory: Memory,
  threadId: string,
  resourceId: string,
  instructions: string,
  limit = 60,
): Promise<string> {
  const { messages } = (await memory.recall({
    threadId,
    resourceId,
    last: limit,
  } as never)) as { messages: unknown[] };

  const lines: string[] = [];
  for (const raw of messages ?? []) {
    const m = raw as { role?: string; content?: unknown };
    const text = flatten(m.content);
    if (text) lines.push(`${m.role ?? "?"}: ${text}`);
  }
  const transcript = lines.join("\n").slice(-24_000);
  if (!transcript) return "";

  // The local model first, when there is one.
  //
  // This is the turn most worth moving off the browser: a fresh profile is
  // worth about 98 queries, measured, and condensing a transcript into notes
  // is not what a frontier model is for. It also has to work when the browser
  // has stopped answering — the handoff exists for exactly that — and a model
  // on this machine does not have a rate limit to hit.
  const question = `${instructions}\n\n---\n${transcript}\n---`;
  const local = await localSummarizer();
  if (local) {
    try {
      const answer = await local.ask(question);
      if (answer) return answer;
    } catch {
      // Falls through to the session's own backend, which is the point of
      // trying the local one first rather than only.
    }
  }

  const backend = Session.backend;
  if (!backend) return "";
  return backend.ask(question);
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flatten).join(" ").trim();
  if (content && typeof content === "object") {
    const c = content as { text?: string; parts?: unknown; content?: unknown };
    if (typeof c.text === "string") return c.text;
    if (c.parts) return flatten(c.parts);
    if (c.content) return flatten(c.content);
  }
  return "";
}
