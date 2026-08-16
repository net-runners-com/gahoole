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

const PLAN_LINE = /^\s*(?:[-*]|\d+[.)])\s+(.{3,200})$/gm;

/**
 * Pull a numbered or bulleted list out of the model's reply. A plan arrives as
 * prose around a list far more often than as a bare list, so the surrounding
 * sentences are ignored rather than fought.
 */
export function parsePlan(text: string): Task[] {
  const tasks: Task[] = [];
  for (const m of text.matchAll(PLAN_LINE)) {
    const title = (m[1] ?? "")
      .replace(/^\**\s*/, "")
      .replace(/\*\*/g, "")
      .trim();
    if (!title) continue;
    // A list of tools or files is not a plan; steps have verbs and length.
    if (title.length < 6) continue;
    tasks.push({ id: tasks.length + 1, title, status: "todo" });
  }
  return tasks.slice(0, 12);
}

export interface StepOutcome {
  status: Exclude<TaskStatus, "todo" | "doing">;
  note?: string;
  /** Tasks the step discovered are needed. */
  added: string[];
}

const DONE_RE = /\b(DONE|完了)\b/i;
const SKIP_RE = /\b(SKIP|SKIPPED|不要|スキップ)\b/i;
const FAIL_RE = /\b(FAILED|BLOCKED|失敗|できません|できなかった)\b/i;
const ADD_RE = /^\s*(?:NEXT|ADD|追加):\s*(.{3,200})$/gim;

/**
 * Read a step's own verdict. Asking for a keyword is more reliable than asking
 * for JSON — the marker survives the page's markdown rendering, and a step
 * that forgets to say anything is treated as done rather than looping.
 */
export function readOutcome(text: string): StepOutcome {
  const added = [...text.matchAll(ADD_RE)].map((m) => (m[1] ?? "").trim());
  if (FAIL_RE.test(text)) return { status: "failed", note: firstLine(text), added };
  if (SKIP_RE.test(text)) return { status: "skipped", note: firstLine(text), added };
  if (DONE_RE.test(text)) return { status: "done", added };
  return { status: "done", note: "no verdict given", added };
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
