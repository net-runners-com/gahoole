import fs from "node:fs";
import path from "node:path";
import type { Memory } from "@mastra/memory";
import type { Lifecycle, StopFailureEvent } from "./lifecycle.js";
import { summarizeThread } from "./summarize.js";
import {
  OBSERVE_PROMPT,
  ObservationStore,
  parseObservations,
} from "./observations.js";
import { inProject } from "./paths.js";

/**
 * Carrying a conversation across a rate limit.
 *
 * The awkward part of this problem: summarizing costs a model call, and the
 * reason we are here is that model calls are being refused. So the handoff is
 * written in two stages.
 *
 *   Stage 1 — digest.  Mechanical. Reads the thread out of libSQL and writes a
 *     transcript excerpt to disk. No model, no network, cannot itself be rate
 *     limited. This always happens, and on its own it is enough to continue.
 *
 *   Stage 2 — summary. A model call, attempted after the digest is already
 *     safe on disk. Expected to fail while the limit is in force; when it does,
 *     the handoff stays `pending` and the next session that manages a
 *     successful turn upgrades it in the background.
 *
 * The next session reads whichever of the two exists, newest wins.
 */

const DIR = process.env.HANDOFF_DIR
  ? path.resolve(process.env.HANDOFF_DIR)
  : inProject("handoff");

export type FailureKind = "rate_limit" | "overloaded" | "context" | "other";

export interface FailureClass {
  kind: FailureKind;
  /** From `retry-after`, when the API sent one. */
  retryAfterMs?: number;
  status?: number;
}

export interface Handoff {
  version: 1;
  resourceId: string;
  sessionId: string;
  createdAt: string;
  reason: FailureKind;
  retryAfterMs?: number;
  turns: number;
  /** Always present — mechanical, written without a model. */
  digest: string;
  /** Present once a model call succeeded. */
  summary?: string;
  /**
   * The same session as typed one-line notes.
   *
   * A prose summary has to be read whole and re-read every time; notes can be
   * carried twenty at a time, filtered by type, and cut to a budget without
   * leaving a sentence half-finished. See observations.ts.
   */
  notes?: { type: string; title: string }[];
  /** True while the summary is still owed. */
  pending: boolean;
}

/**
 * Rate limiting arrives in several shapes depending on how deep in the stack
 * it surfaces, so classify on status code, error name and message together
 * rather than trusting any one of them.
 */
export function classifyFailure(error: unknown): FailureClass {
  const e = error as {
    status?: number;
    statusCode?: number;
    name?: string;
    message?: string;
    responseHeaders?: Record<string, string>;
    headers?: Record<string, string> | Headers;
    cause?: unknown;
  };
  const status = e?.status ?? e?.statusCode;
  const message = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();

  const headerBag = e?.responseHeaders ?? e?.headers;
  const retryAfterRaw =
    headerBag instanceof Headers
      ? headerBag.get("retry-after")
      : (headerBag?.["retry-after"] ?? headerBag?.["Retry-After"]);
  const retryAfterMs = retryAfterRaw
    ? Number(retryAfterRaw) * 1000 || undefined
    : undefined;

  // AI Mode never returns a 429 — it returns 200 with the answer replaced by
  // an error string, which the backend turns into this.
  if (/aimoderatelimit/.test(message)) {
    return { kind: "rate_limit", status };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(message)) {
    return { kind: "rate_limit", status, retryAfterMs };
  }
  if (status === 529 || status === 503 || /overloaded/.test(message)) {
    return { kind: "overloaded", status, retryAfterMs };
  }
  // Deliberately narrow: a bare /context/ also matches
  // `launchPersistentContext`, and a browser that failed to start would be
  // filed as a context overflow and trigger a handoff.
  if (
    /context (length|window|limit)|maximum context|max_tokens|prompt is too long|token limit/.test(
      message,
    )
  ) {
    return { kind: "context", status };
  }
  // Some SDK errors wrap the real one.
  if (e?.cause && e.cause !== error) {
    const inner = classifyFailure(e.cause);
    if (inner.kind !== "other") return inner;
  }
  return { kind: "other", status };
}

/** These are the failures worth carrying forward; a typo in a tool is not. */
export const shouldHandoff = (k: FailureKind): boolean =>
  k === "rate_limit" || k === "overloaded" || k === "context";

function fileFor(resourceId: string): string {
  return path.join(DIR, `${resourceId.replace(/[^\w.-]/g, "_")}.json`);
}

export class HandoffStore {
  constructor(
    private readonly memory: Memory,
    private readonly resourceId: string,
  ) {
    fs.mkdirSync(DIR, { recursive: true });
  }

  read(): Handoff | undefined {
    const f = fileFor(this.resourceId);
    if (!fs.existsSync(f)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as Handoff;
    } catch {
      return undefined;
    }
  }

  #write(h: Handoff): void {
    // Write-then-rename so a crash mid-write cannot leave a truncated handoff.
    const f = fileFor(this.resourceId);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(h, null, 2));
    fs.renameSync(tmp, f);
  }

  /** Consume the handoff, archiving it rather than deleting it. */
  take(): Handoff | undefined {
    const h = this.read();
    if (!h) return undefined;
    const archive = path.join(DIR, "archive");
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(
      fileFor(this.resourceId),
      path.join(archive, `${h.sessionId}-${Date.parse(h.createdAt)}.json`),
    );
    return h;
  }

  /**
   * Stage 1. Reads the thread straight out of storage and formats it. Runs on
   * the failure path, so it swallows its own errors — a handoff that throws
   * while handling a rate limit would take the process down with it.
   */
  async capture(
    sessionId: string,
    failure: FailureClass,
    turns: number,
    /** The prompt that failed — usually not yet in storage. */
    unsavedPrompt?: string,
  ): Promise<Handoff | undefined> {
    try {
      const stored = await this.#digest(sessionId);
      const digest = unsavedPrompt
        ? `${stored}\nuser: ${unsavedPrompt}\n(this last turn did not complete)`
        : stored;
      const handoff: Handoff = {
        version: 1,
        resourceId: this.resourceId,
        sessionId,
        createdAt: new Date().toISOString(),
        reason: failure.kind,
        ...(failure.retryAfterMs && { retryAfterMs: failure.retryAfterMs }),
        turns,
        digest,
        pending: true,
      };
      this.#write(handoff);
      return handoff;
    } catch (e) {
      console.error(`[handoff] capture failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async #digest(sessionId: string, limit = 40): Promise<string> {
    const { messages } = (await this.memory.recall({
      threadId: sessionId,
      resourceId: this.resourceId,
      last: limit,
    } as never)) as { messages: unknown[] };

    const lines: string[] = [];
    for (const raw of messages ?? []) {
      const m = raw as {
        role?: string;
        content?: unknown;
      };
      const text = extractText(m.content);
      if (!text) continue;
      const clipped = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      lines.push(`${m.role ?? "?"}: ${clipped}`);
    }
    return lines.join("\n");
  }

  /**
   * Stage 2. Expected to fail while the limit is in force — the caller treats
   * a rejection as "try again later", not as an error worth surfacing.
   */
  async summarize(handoff: Handoff): Promise<Handoff> {
    // Notes rather than a paragraph, in the shape observations.ts stores and
    // searches. The prose summary is kept as a fallback for the case where no
    // note line came back in a readable shape.
    const summary = await summarizeThread(
      this.memory,
      handoff.sessionId,
      this.resourceId,
      OBSERVE_PROMPT,
    );
    if (!summary) return handoff;

    const parsed = parseObservations(summary);
    const notes = parsed.map((o) => ({ type: o.type, title: o.title }));
    if (notes.length > 0) {
      // Recorded where a later session can search them, not only where this
      // one handoff can be read.
      new ObservationStore(this.resourceId).add(handoff.sessionId, parsed);
    }

    const upgraded: Handoff = { ...handoff, summary, notes, pending: false };
    // Only overwrite if nothing newer landed while the model was working.
    const current = this.read();
    if (current && current.createdAt === handoff.createdAt) this.#write(upgraded);
    return upgraded;
  }

  /** What the next session should be seeded with. */
  static seedText(h: Handoff): string {
    const head =
      h.reason === "rate_limit"
        ? "The previous session was cut short by a rate limit."
        : h.reason === "overloaded"
          ? "The previous session was cut short because the API was overloaded."
          : "The previous session ran out of context.";
    const body = h.notes?.length
      ? `What that session established:\n${h.notes.map((n) => `- [${n.type}] ${n.title}`).join("\n")}`
      : h.summary
        ? `Summary of what happened:\n\n${h.summary}`
        : `No summary was possible (the model was unavailable). Raw transcript excerpt:\n\n${h.digest}`;
    return `${head} Continue from here.\n\n${body}`;
  }

  /**
   * Wire the two stages onto the lifecycle. `onCaptured` lets the CLI report
   * what happened and decide whether to open a fresh session.
   */
  register(
    lifecycle: Lifecycle,
    opts: {
      turnsOf: (sessionId: string) => number;
      onCaptured?: (h: Handoff, f: FailureClass) => void | Promise<void>;
    },
  ): void {
    lifecycle.on("StopFailure", async (e: StopFailureEvent) => {
      const failure = classifyFailure(e.error);
      if (!shouldHandoff(failure.kind)) return;

      const handoff = await this.capture(
        e.sessionId,
        failure,
        opts.turnsOf(e.sessionId),
        e.prompt,
      );
      if (!handoff) return;

      await opts.onCaptured?.(handoff, failure);

      // Stage 2, best effort. A failure here is the expected case.
      void this.summarize(handoff).catch(() => {});
    });
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractText).join(" ").trim();
  if (content && typeof content === "object") {
    const c = content as { text?: string; parts?: unknown; content?: unknown };
    if (typeof c.text === "string") return c.text;
    if (c.parts) return extractText(c.parts);
    if (c.content) return extractText(c.content);
  }
  return "";
}
