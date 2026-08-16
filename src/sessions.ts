import type { Memory } from "@mastra/memory";
import type { Lifecycle } from "./lifecycle.js";

/**
 * Session bookkeeping — titles, turn counts, lineage, lookup by prefix.
 *
 * All of it is derived from the Mastra thread record, so there is no second
 * store to keep in sync: `metadata.app` on the thread is the whole schema.
 * The bookkeeping itself is installed as lifecycle hooks (`register`), which
 * keeps `Session` free of anything that only exists to make a list look good.
 */

export interface SessionSource {
  kind: "clear" | "compact" | "resume" | "fork";
  from: string;
}

export interface SessionRecord {
  id: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
  turns: number;
  source?: SessionSource;
}

interface AppMeta {
  turns?: number;
  source?: SessionSource;
}

export class AmbiguousSessionError extends Error {
  constructor(
    readonly prefix: string,
    readonly matches: string[],
  ) {
    super(
      `"${prefix}" matches ${matches.length} sessions: ${matches
        .map((m) => m.slice(0, 8))
        .join(", ")}`,
    );
    this.name = "AmbiguousSessionError";
  }
}

export class SessionStore {
  constructor(
    private readonly memory: Memory,
    private readonly resourceId: string,
  ) {}

  async list(limit = 50): Promise<SessionRecord[]> {
    const { threads } = await this.memory.listThreads({
      filter: { resourceId: this.resourceId },
      orderBy: { field: "updatedAt", direction: "DESC" },
      perPage: limit,
    } as never);

    return (threads ?? []).map((t) => {
      const app = ((t.metadata ?? {}).app ?? {}) as AppMeta;
      return {
        id: t.id,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        turns: app.turns ?? 0,
        source: app.source,
      };
    });
  }

  /** Most recently touched session, for "pick up where I left off". */
  async latest(): Promise<SessionRecord | undefined> {
    return (await this.list(1))[0];
  }

  /**
   * Accepts a full id or any unique prefix — session ids are UUIDs and nobody
   * types those. An ambiguous prefix is an error rather than a guess.
   */
  async resolve(prefix: string): Promise<string> {
    const all = await this.list(200);
    const exact = all.find((s) => s.id === prefix);
    if (exact) return exact.id;

    const matches = all.filter((s) => s.id.startsWith(prefix));
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length === 0) throw new Error(`no session matches "${prefix}"`);
    throw new AmbiguousSessionError(
      prefix,
      matches.map((m) => m.id),
    );
  }

  async rename(id: string, title: string): Promise<void> {
    await this.memory.updateThread({ id, title });
  }

  async remove(id: string): Promise<void> {
    await this.memory.deleteThread(id);
  }

  /** Read-modify-write of `metadata.app`, preserving everything else. */
  async #patch(id: string, patch: AppMeta): Promise<void> {
    const thread = await this.memory.getThreadById({ threadId: id });
    if (!thread) return;
    const metadata = { ...(thread.metadata ?? {}) };
    metadata.app = { ...((metadata.app ?? {}) as AppMeta), ...patch };
    await this.memory.updateThread({ id, metadata });
  }

  /**
   * Bookkeeping as hooks: the thread is created when the session opens, titled
   * from the first thing the user says, and its turn count moves on Stop.
   */
  register(lifecycle: Lifecycle): void {
    lifecycle.on("SessionStart", async (e) => {
      const existing = await this.memory.getThreadById({ threadId: e.sessionId });
      if (!existing) {
        await this.memory.createThread({
          threadId: e.sessionId,
          resourceId: e.resourceId,
          ...(e.source && { metadata: { app: { turns: 0, source: e.source } } }),
        });
      } else if (e.source) {
        await this.#patch(e.sessionId, { source: e.source });
      }
    });

    lifecycle.on("UserPromptSubmit", async (e) => {
      const thread = await this.memory.getThreadById({ threadId: e.sessionId });
      if (thread && !thread.title) {
        const title = e.prompt.replace(/\s+/g, " ").trim().slice(0, 60);
        if (title) await this.memory.updateThread({ id: e.sessionId, title });
      }
    });

    lifecycle.on("Stop", async (e) => {
      const thread = await this.memory.getThreadById({ threadId: e.sessionId });
      const app = ((thread?.metadata ?? {}).app ?? {}) as AppMeta;
      await this.#patch(e.sessionId, { turns: (app.turns ?? 0) + 1 });
    });
  }
}

const RELATIVE: [number, Intl.RelativeTimeFormatUnit][] = [
  [60_000, "second"],
  [3_600_000, "minute"],
  [86_400_000, "hour"],
  [Number.POSITIVE_INFINITY, "day"],
];

function ago(date: Date): string {
  const ms = Date.now() - date.getTime();
  const divisor = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  for (const [limit, unit] of RELATIVE) {
    if (ms < limit) {
      const n = Math.round(ms / divisor[unit as keyof typeof divisor]);
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
        -n,
        unit,
      );
    }
  }
  return date.toISOString();
}

export function formatSessions(
  sessions: SessionRecord[],
  currentId?: string,
): string {
  if (sessions.length === 0) return "  (no sessions yet)";
  return sessions
    .map((s) => {
      const mark = s.id === currentId ? "\x1b[32m*\x1b[0m" : " ";
      const lineage = s.source ? ` ←${s.source.kind} ${s.source.from.slice(0, 8)}` : "";
      const title = s.title ?? "\x1b[2m(untitled)\x1b[0m";
      return `${mark} ${s.id.slice(0, 8)}  ${String(s.turns).padStart(3)} turns  ${ago(s.updatedAt).padEnd(16)}  ${title}\x1b[2m${lineage}\x1b[0m`;
    })
    .join("\n");
}
