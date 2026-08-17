/**
 * The plan an autonomous run works through.
 *
 * The list is written once by the model and then kept here, not in the
 * conversation. A model asked to carry its own todo state across a dozen
 * turns quietly drops items and re-does others; a list held by the program is
 * the same list on step nine as it was on step one, and the user can see it.
 *
 * The model still gets to change it — a step may report that a task is
 * unnecessary, or add one it discovered — but every change goes through this
 * file, so the list on screen is the list being executed.
 */

export type TaskStatus = "todo" | "doing" | "done" | "skipped" | "failed";

export interface Task {
  id: number;
  title: string;
  status: TaskStatus;
  /** Why it ended the way it did, when that is not obvious. */
  note?: string;
}

/**
 * A list item, with the emphasis a model wraps one in. The leading `**` has to
 * be allowed for rather than cleaned up afterwards: `**1. Write the file**`
 * failed to match at all, because the bullet alternative consumed the first
 * asterisk and then wanted a space where the second one was.
 */
const PLAN_LINE = /^\s*(?:\*\*|__)?\s*(?:[-*+]|\d+[.)])\s+(.{3,200})$/gm;

/**
 * Pull a numbered or bulleted list out of the model's reply. A plan arrives as
 * prose around a list far more often than as a bare list, so the surrounding
 * sentences are ignored rather than fought.
 */
export function parsePlan(text: string): Task[] {
  const tasks: Task[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(PLAN_LINE)) {
    const title = (m[1] ?? "")
      .replace(/^\**\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!title) continue;
    // A list of tools or files is not a plan; steps have verbs and length.
    if (title.length < 6) continue;
    // Nor is the same step written twice. A measured run came back with
    // twelve items of which four were two pairs — the model restated the
    // first steps at the end — and a plan that lists a step twice is a plan
    // that will be walked twice.
    const key = title.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ id: tasks.length + 1, title, status: "todo" });
  }
  return tasks.slice(0, 12);
}

export interface StepOutcome {
  status: Exclude<TaskStatus, "todo" | "doing">;
  note?: string;
  /** Tasks the step discovered are needed. */
  added: string[];
  /**
   * Did the reply actually say how it went, or is `status` the default?
   *
   * A step turn that forgets to report is treated as done, because looping on
   * silence is worse. But a turn that was asked to plan *and* work cannot be
   * read that way — a reply containing only a plan would mark the first step
   * finished before anything happened — so that caller checks this first.
   */
  explicit: boolean;
}

/**
 * Verdict words, in both languages.
 *
 * The Japanese alternatives used to sit inside the same `\b…\b` as the
 * English ones, where they could never match: `\b` is a boundary between a
 * word character and a non-word character, and no CJK character is a word
 * character, so `\b完了\b` matches only if 完了 is surrounded by ASCII. Every
 * reply that said 完了しました went unread for as long as that stood, and an
 * autonomous run in Japanese could only ever end by saying DONE in English.
 *
 * The lookarounds are the other half of it: 未完了 and 完了していません both
 * contain 完了 and mean the opposite of it.
 */
const NEGATED = "(?!.{0,4}(?:ませ|しない|できな|していな))";
const DONE_RE = new RegExp(`\\bDONE\\b|(?<!未)完了${NEGATED}`, "i");
const SKIP_RE = new RegExp(`\\b(?:SKIP|SKIPPED)\\b|不要${NEGATED}|スキップ${NEGATED}`, "i");
const FAIL_RE = new RegExp(
  `\\b(?:FAILED|BLOCKED)\\b|失敗${NEGATED}|できません|できなかった`,
  "i",
);
const ADD_RE = /^\s*(?:NEXT|ADD|追加):\s*(.{3,200})$/gim;

/**
 * Per-step verdicts inside one reply.
 *
 * A turn is asked for every outstanding step it can manage, not for one, so a
 * single reply reports on several — "STEP 2 DONE", "STEP 3 FAILED". Read them
 * all rather than collapsing the reply into a single status, which would mark
 * three finished steps as one.
 */
const STEP_RE = /\bSTEP\s*(\d+)\s*(DONE|SKIP(?:PED)?|FAILED|完了|不要|失敗)/gi;

export interface StepVerdict {
  id: number;
  status: Exclude<TaskStatus, "todo" | "doing">;
}

/**
 * Did the reply say the *goal* is met, rather than a step?
 *
 * "STEP 2 DONE" and "DONE" both contain DONE, so the per-step verdicts are
 * removed before looking. Getting this wrong is expensive in both directions:
 * read a step's DONE as the goal's and the run stops early, miss the goal's
 * and it keeps asking for work that is finished — which is what it did,
 * costing 41 queries against the 33 the same three tasks took when a single
 * DONE was allowed to end them.
 */
export function saysAllDone(text: string): boolean {
  return DONE_RE.test(text.replace(STEP_RE, ""));
}

export function readStepVerdicts(text: string): StepVerdict[] {
  const out: StepVerdict[] = [];
  for (const m of text.matchAll(STEP_RE)) {
    const id = Number(m[1]);
    const word = (m[2] ?? "").toUpperCase();
    if (!Number.isFinite(id)) continue;
    const status = /FAIL|失敗/.test(word)
      ? "failed"
      : /SKIP|不要/.test(word)
        ? "skipped"
        : "done";
    out.push({ id, status });
  }
  return out;
}

/**
 * Read a step's own verdict. Asking for a keyword is more reliable than asking
 * for JSON — the marker survives the page's markdown rendering, and a step
 * that forgets to say anything is treated as done rather than looping.
 */
export function readOutcome(text: string): StepOutcome {
  const added = [...text.matchAll(ADD_RE)].map((m) => (m[1] ?? "").trim());
  const explicit = true;
  if (FAIL_RE.test(text))
    return { status: "failed", note: firstLine(text), added, explicit };
  if (SKIP_RE.test(text))
    return { status: "skipped", note: firstLine(text), added, explicit };
  if (DONE_RE.test(text)) return { status: "done", added, explicit };
  return { status: "done", note: "no verdict given", added, explicit: false };
}

const firstLine = (t: string): string =>
  t.split("\n").find((l) => l.trim())?.trim().slice(0, 120) ?? "";

const MARK: Record<TaskStatus, string> = {
  todo: " ",
  doing: "›",
  done: "✓",
  skipped: "—",
  failed: "✗",
};

const COLOR: Record<TaskStatus, string> = {
  todo: "\x1b[2m",
  doing: "\x1b[1m",
  done: "\x1b[32m",
  skipped: "\x1b[2m",
  failed: "\x1b[31m",
};

export function renderPlan(tasks: Task[], color = true): string {
  return tasks
    .map((t) => {
      const line = `  ${MARK[t.status]} ${t.id}. ${t.title}${t.note ? ` — ${t.note}` : ""}`;
      return color ? `${COLOR[t.status]}${line}\x1b[0m` : line;
    })
    .join("\n");
}

export const remaining = (tasks: Task[]): Task[] =>
  tasks.filter((t) => t.status === "todo");
