import type { Memory } from "@mastra/memory";
import { Session } from "./session.js";

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

  const backend = Session.backend;
  if (!backend) return "";
  return backend.ask(`${instructions}\n\n---\n${transcript}\n---`);
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
