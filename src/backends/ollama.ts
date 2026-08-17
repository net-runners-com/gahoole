import type { Backend } from "./index.js";

/**
 * A model running on this machine, for the turns that do not need the good one.
 *
 * The binding constraint here is not quality, it is the rate limit: a fresh
 * browser profile is worth about 98 queries, measured, and a benchmark run
 * spends thirty of them. Some of what it spends them on does not need a
 * frontier model at all — summarising a session into notes, condensing a
 * transcript for the handoff. Those are the turns this takes.
 *
 * Spoken to over HTTP with no client library: Ollama's /api/chat is three
 * fields, and a dependency for that would be a dependency to keep working.
 *
 * It is deliberately not the main backend. Driving tools well is the hard part
 * and the local models that do it are large; the ones that fit in a few
 * gigabytes are good enough to summarise and not to act.
 */

export interface OllamaOptions {
  model?: string;
  host?: string;
  /** Seconds before a local model is assumed to be stuck. */
  timeoutMs?: number;
}

export const ollamaModel = (): string =>
  process.env.GAHOOLE_OLLAMA_MODEL ?? "qwen3:4b";

export const ollamaHost = (): string =>
  process.env.GAHOOLE_OLLAMA_HOST ?? "http://127.0.0.1:11434";

/** Is there something listening, and does it have the model? */
export async function ollamaReady(
  opts: OllamaOptions = {},
): Promise<{ ok: boolean; why: string }> {
  const host = opts.host ?? ollamaHost();
  const model = opts.model ?? ollamaModel();
  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, why: `${host} answered ${res.status}` };
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name ?? "");
    // Ollama names a model `qwen3:4b`, and `qwen3` means `qwen3:latest`.
    const wanted = model.includes(":") ? model : `${model}:latest`;
    if (!names.includes(wanted)) {
      return {
        ok: false,
        why: `${host} has no ${wanted} — ollama pull ${model}`,
      };
    }
    return { ok: true, why: `${wanted} on ${host}` };
  } catch (e) {
    return {
      ok: false,
      why: `nothing on ${host} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

export function createOllama(opts: OllamaOptions = {}): Backend {
  const host = opts.host ?? ollamaHost();
  const model = opts.model ?? ollamaModel();
  // A conversation of its own, so this can be asked follow-ups without the
  // caller threading history through.
  let history: { role: string; content: string }[] = [];

  const backend: Backend = {
    name: `ollama:${model}`,
    fork: async () => createOllama(opts),
    reset: () => {
      history = [];
    },
    async ask(prompt: string) {
      history.push({ role: "user", content: prompt });
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: history, stream: false }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      if (!res.ok) {
        throw new Error(`${model} answered ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        message?: { content?: string };
        error?: string;
      };
      if (body.error) throw new Error(`${model}: ${body.error}`);
      const text = (body.message?.content ?? "").trim();
      // Small reasoning models narrate before answering; the tags are theirs,
      // not the answer's.
      const answer = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      history.push({ role: "assistant", content: answer });
      return answer;
    },
  };
  return backend;
}
