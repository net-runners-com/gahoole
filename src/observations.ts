import fs from "node:fs";
import path from "node:path";
import { inProject } from "./paths.js";

/**
 * What a session leaves behind.
 *
 * A summary written as prose is one paragraph that has to be read whole, gets
 * re-read in full every session, and cannot be searched for the one thing you
 * wanted. claude-mem's answer is to keep observations instead: short typed
 * lines with ids, appended as they happen, and an index cheap enough to load
 * every time. This is that shape.
 *
 *   a7f21  17:04  fix   #settle treated an empty page as a finished one
 *   b0c93  17:12  find  the rate limit is keyed on the cookie, not the IP
 *
 * Three properties are what make it worth the machinery, and each one is a
 * property prose does not have. A line is a unit — you can carry twenty of
 * them and drop the twenty-first without truncating a sentence. A type is a
 * filter — "what did we decide" is a query rather than a re-read. And an id
 * is a handle — the detail can stay on disk until something asks for it.
 *
 * The file is JSONL and append-only, so a crash costs the last line rather
 * than the file, and two processes appending at once interleave rather than
 * clobber.
 */

export const TYPES = [
  "decide", // a choice made, and why
  "find", // something learned about how the world is
  "fix", // a bug and what it turned out to be
  "add", // something built
  "task", // work outstanding
] as const;

export type ObservationType = (typeof TYPES)[number];

export interface Observation {
  id: string;
  at: string;
  session: string;
  type: ObservationType;
  title: string;
  detail?: string;
}

const DIR = process.env.GAHOOLE_MEMORY_DIR
  ? path.resolve(process.env.GAHOOLE_MEMORY_DIR)
  : inProject("memory");
const FILE = (resourceId: string): string =>
  path.join(DIR, `${resourceId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);

/**
 * The line a model is asked to write.
 *
 * Deliberately the same shape as the tool protocol: a marker at the start of
 * a line, plain ASCII, nothing that markdown rendering will eat. The type is
 * one of a closed set, because a free-text category is a category nobody can
 * filter on later.
 */
export const OBS_PREFIX = "OBS";
const OBS_RE = new RegExp(
  `^[\\s>*_\`-]*${OBS_PREFIX}[ \\t]+(${TYPES.join("|")})[ \\t]+(.{4,200}?)[ \\t*_\`]*$`,
  "gim",
);

export function parseObservations(text: string): Omit<Observation, "id" | "at" | "session">[] {
  const out: Omit<Observation, "id" | "at" | "session">[] = [];
  for (const m of text.matchAll(OBS_RE)) {
    const type = (m[1] ?? "").toLowerCase() as ObservationType;
    const title = (m[2] ?? "").replace(/\*\*/g, "").trim();
    if (!title || !TYPES.includes(type)) continue;
    if (out.some((o) => o.title === title)) continue;
    out.push({ type, title });
  }
  return out;
}

/** The instruction that gets those lines back. */
export const OBSERVE_PROMPT = `Write down what this session established, as a
list of one-line notes. One note per line, in exactly this shape:

${OBS_PREFIX} decide  what was chosen, and the reason in the same line
${OBS_PREFIX} find    something learned about how things actually are
${OBS_PREFIX} fix     a bug, and what it turned out to be
${OBS_PREFIX} add     something that was built
${OBS_PREFIX} task    work that is still outstanding

Between three and twelve notes. Each one has to stand on its own months from
now, with none of this conversation around it — so name the file, the number,
the command, rather than "it" and "that". Leave out anything that was only
true while we were talking. No preamble and nothing after the list.`;

/**
 * Short, stable, and derived from the content rather than a counter, so the
 * same observation written twice gets the same id and the reader can tell.
 */
function idFor(title: string, at: string): string {
  let h = 0x811c9dc5;
  for (const ch of `${title}${at.slice(0, 10)}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0").slice(0, 6);
}

export class ObservationStore {
  constructor(private readonly resourceId: string) {}

  all(): Observation[] {
    const f = FILE(this.resourceId);
    if (!fs.existsSync(f)) return [];
    const out: Observation[] = [];
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Observation);
      } catch {
        // A half-written last line is the price of appending; skip it.
      }
    }
    return out;
  }

  /** Append, skipping anything already recorded verbatim. */
  add(
    session: string,
    items: Omit<Observation, "id" | "at" | "session">[],
    now = new Date(),
  ): Observation[] {
    if (items.length === 0) return [];
    const seen = new Set(this.all().map((o) => o.title));
    const at = now.toISOString();
    const fresh = items
      .filter((i) => !seen.has(i.title))
      .map((i) => ({ id: idFor(i.title, at), at, session, ...i }));
    if (fresh.length === 0) return [];

    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(
      FILE(this.resourceId),
      `${fresh.map((o) => JSON.stringify(o)).join("\n")}\n`,
    );
    return fresh;
  }

  /** Substring match over title and type, newest first. */
  search(query: string, limit = 20): Observation[] {
    const q = query.trim().toLowerCase();
    const hit = (o: Observation) =>
      !q || o.title.toLowerCase().includes(q) || o.type === q;
    return this.all().filter(hit).reverse().slice(0, limit);
  }

  /** The most recent, oldest first so they read as a story. */
  recent(limit = 20): Observation[] {
    return this.all().slice(-limit);
  }
}

const MARK: Record<ObservationType, string> = {
  decide: "\x1b[35m",
  find: "\x1b[36m",
  fix: "\x1b[31m",
  add: "\x1b[32m",
  task: "\x1b[33m",
};

export function renderObservations(items: Observation[], color = true): string {
  if (items.length === 0) return "  (nothing recorded yet)";
  return items
    .map((o) => {
      const when = o.at.slice(11, 16);
      const type = color ? `${MARK[o.type]}${o.type.padEnd(6)}\x1b[0m` : o.type.padEnd(6);
      const id = color ? `\x1b[2m${o.id}\x1b[0m` : o.id;
      const time = color ? `\x1b[2m${when}\x1b[0m` : when;
      return `  ${id} ${time} ${type} ${o.title}`;
    })
    .join("\n");
}

/**
 * What a new session is told about the ones before it.
 *
 * Lines rather than paragraphs, so the count can be cut to fit whatever budget
 * is going without leaving a sentence half-finished.
 */
export function seedFrom(items: Observation[]): string {
  if (items.length === 0) return "";
  return [
    "From earlier sessions, so you do not have to be told again:",
    ...items.map((o) => `- [${o.type}] ${o.title}`),
  ].join("\n");
}
