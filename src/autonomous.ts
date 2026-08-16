import { log } from "./output.js";
import {
  parsePlan,
  readOutcome,
  remaining,
  renderPlan,
  type Task,
} from "./plan.js";

/**
 * An autonomous run: plan once, then work the list.
 *
 * The shape is deliberately not "keep calling the model until it stops". That
 * terminates when the model feels finished, which on a search-shaped model is
 * usually after describing what it would do. Here the model writes a list
 * first, and the program walks it — so "am I done?" is a question about the
 * list, not about the model's mood, and the user can watch the same list the
 * agent is executing.
 *
 * Each step is a turn of its own. That costs a query per task, which is the
 * real budget on this backend, so `maxSteps` is a hard stop and the plan is
 * capped when it is parsed. It also means a rate limit part-way through is
 * caught by the ordinary handoff machinery: the run stops, the conversation
 * is saved, and the next session picks it up.
 */

export interface AutoDeps {
  /** One turn. The CLI passes `session.run`, so hooks and handoff apply. */
  run: (prompt: string) => Promise<string>;
  maxSteps?: number;
  /** Called whenever the list changes, for the CLI to redraw it. */
  onPlan?: (tasks: Task[]) => void;
}

export interface AutoResult {
  tasks: Task[];
  steps: number;
  stopped: "complete" | "budget" | "stuck";
}

const PLAN_PROMPT = (goal: string) => `${goal}

Before doing any of it, write the plan as a short numbered list — one line per
step, in the order you will do them, each a concrete action you can take with
the tools you have. Between three and eight steps. No preamble, no commentary,
just the list.`;

const STEP_PROMPT = (task: Task, tasks: Task[], goal: string) => `Overall goal: ${goal}

The plan, and where we are:
${renderPlan(tasks, false)}

Now do step ${task.id}: ${task.title}

Use the tools to actually do it — do not describe what you would do. When the
step is finished, end your reply with DONE. If it turns out to be unnecessary
say SKIP, and if you cannot do it say FAILED and why. If doing it revealed
another step that is needed, add a line starting NEXT: describing it.`;

export async function runAutonomously(
  goal: string,
  deps: AutoDeps,
): Promise<AutoResult> {
  const maxSteps = deps.maxSteps ?? 8;

  const planText = await deps.run(PLAN_PROMPT(goal));
  const tasks = parsePlan(planText);

  if (tasks.length === 0) {
    // No list came back — the reply is the answer, and forcing a plan out of
    // it would spend queries to learn the same thing.
    log(`\x1b[2m  no plan came back; treating the reply as the answer\x1b[0m`);
    log(planText);
    return { tasks, steps: 0, stopped: "complete" };
  }

  deps.onPlan?.(tasks);

  let steps = 0;
  while (steps < maxSteps) {
    const task = remaining(tasks)[0];
    if (!task) return { tasks, steps, stopped: "complete" };

    task.status = "doing";
    deps.onPlan?.(tasks);
    steps++;

    let text: string;
    try {
      text = await deps.run(STEP_PROMPT(task, tasks, goal));
    } catch (e) {
      // A failed turn ends the run rather than burning the budget retrying;
      // the handoff has already saved the conversation.
      task.status = "failed";
      task.note = e instanceof Error ? e.message.slice(0, 80) : String(e);
      deps.onPlan?.(tasks);
      return { tasks, steps, stopped: "stuck" };
    }

    const outcome = readOutcome(text);
    task.status = outcome.status;
    if (outcome.note) task.note = outcome.note;

    for (const title of outcome.added) {
      if (tasks.length >= 12) break;
      tasks.push({ id: tasks.length + 1, title, status: "todo" });
    }
    deps.onPlan?.(tasks);

    // Three failures in a row is not a run that needs more steps.
    const tail = tasks.filter((t) => t.status !== "todo").slice(-3);
    if (tail.length === 3 && tail.every((t) => t.status === "failed")) {
      return { tasks, steps, stopped: "stuck" };
    }
  }

  return { tasks, steps, stopped: "budget" };
}
