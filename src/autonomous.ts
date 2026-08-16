import { log } from "./output.js";
import {
  parsePlan,
  readOutcome,
  readStepVerdicts,
  saysAllDone,
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
  /**
   * Turns the run may spend. The default is small because each one is a query
   * against the rate limit; long runs raise it and rely on the backend
   * rotating profiles to keep going.
   */
  maxSteps?: number;
  /** Called whenever the list changes, for the CLI to redraw it. */
  onPlan?: (tasks: Task[]) => void;
}

export interface AutoResult {
  tasks: Task[];
  steps: number;
  stopped: "complete" | "budget" | "stuck";
}

/**
 * Plan and start, in one turn.
 *
 * It used to only plan, which cost a query and moved nothing: measured over
 * three runs, every autonomous benchmark task spent its first turn producing a
 * list that did not parse and no work. Asking for the first step in the same
 * reply makes that turn earn its keep whether or not the list comes back in a
 * shape the parser recognises.
 */
const PLAN_PROMPT = (goal: string) => `${goal}

First write the plan as a short numbered list — one line per step, in the order
you will do them, each a concrete action you can take with the tools you have.
Between three and eight steps.

Then, in this same reply, carry out step 1 — the tool calls go after the list.
Do not wait to be asked. End with DONE once step 1 is finished, or FAILED and
why if it could not be.`;

/**
 * Carry on with the plan — as far as one reply can get.
 *
 * This replaced a turn per step, which was the obvious design and the
 * expensive one. Measured over the benchmark's three autonomous tasks: walking
 * the plan one step per turn cost 32 queries, and asking for "the remaining
 * steps, as many as you can" cost 23 for the same three passes. The model
 * batches a write and the command that runs it into a single reply; a loop
 * that hands it one step at a time forbids exactly that.
 *
 * The plan is still parsed, still shown, and still what the run is tracked
 * against — it just is not used as a leash.
 */
const STEP_PROMPT = (tasks: Task[], goal: string) => `Overall goal: ${goal}

The plan, and where we are:
${renderPlan(tasks, false)}

Carry out the steps that are still outstanding. Do as many as you can in this
one reply — put every tool call that does not need to wait for another's output
in the same reply, rather than stopping after each one.

Use the tools to actually do it; do not describe what you would do. After each
step you finish, write a line "STEP <number> DONE". If a step turns out to be
unnecessary write "STEP <number> SKIP", and if you cannot do one write
"STEP <number> FAILED" and why. If the work revealed a step the plan is
missing, add a line starting NEXT: describing it.

When the whole goal is met, write DONE on its own line and then a sentence
saying what the result actually was — the program's output, the file's
contents, whatever was asked for. The markers are for me; the sentence is for
the person who asked, and a reply that is only markers tells them nothing.`;

const CONTINUE_PROMPT = (goal: string) => `Goal: ${goal}

Is every part of that goal actually done — not described, not planned, but
done, with the tools?

If anything is left, do the next piece now with a tool call and say nothing
else. If it is genuinely all done, reply with DONE and one sentence saying
what the result was.`;

/**
 * Keep asking for the next piece until the model says it is finished.
 *
 * The stopping condition is the model's own DONE, which is why the prompt
 * spells out that describing is not doing — left vaguer, a model reports
 * completion at the first summary it writes.
 */
async function continueUntilDone(
  goal: string,
  first: string,
  deps: AutoDeps,
  maxSteps: number,
): Promise<AutoResult> {
  const tasks: Task[] = [{ id: 1, title: goal, status: "doing" }];
  deps.onPlan?.(tasks);

  if (/\bDONE\b/.test(first)) {
    tasks[0]!.status = "done";
    deps.onPlan?.(tasks);
    return { tasks, steps: 0, stopped: "complete" };
  }

  for (let steps = 1; steps <= maxSteps; steps++) {
    let text: string;
    try {
      text = await deps.run(CONTINUE_PROMPT(goal));
    } catch (e) {
      tasks[0]!.status = "failed";
      tasks[0]!.note = e instanceof Error ? e.message.slice(0, 80) : String(e);
      deps.onPlan?.(tasks);
      return { tasks, steps, stopped: "stuck" };
    }
    if (/\bDONE\b/.test(text) || /\b完了\b/.test(text)) {
      tasks[0]!.status = "done";
      deps.onPlan?.(tasks);
      return { tasks, steps, stopped: "complete" };
    }
  }
  return { tasks, steps: maxSteps, stopped: "budget" };
}

export async function runAutonomously(
  goal: string,
  deps: AutoDeps,
): Promise<AutoResult> {
  const maxSteps = deps.maxSteps ?? 8;

  const planText = await deps.run(PLAN_PROMPT(goal));
  const tasks = parsePlan(planText);

  if (tasks.length === 0) {
    // No list came back. That is not the same as being finished: the
    // benchmark's autonomy failures all looked like this — a turn that did
    // part of the job and then summarised. So instead of accepting the reply,
    // ask whether the goal is actually met, and keep going while it is not.
    log(`\x1b[2m  no plan came back; checking whether the goal is met\x1b[0m`);
    return continueUntilDone(goal, planText, deps, maxSteps);
  }

  // The planning turn was asked to do step 1 as well, so it may already be
  // behind us. Only an explicit verdict counts: a reply that is nothing but a
  // list would otherwise mark the first step finished before anything ran.
  const opening = readOutcome(planText);
  if (opening.explicit && tasks[0]) {
    tasks[0].status = opening.status;
    if (opening.note) tasks[0].note = opening.note;
    for (const title of opening.added) {
      if (tasks.length >= 12) break;
      tasks.push({ id: tasks.length + 1, title, status: "todo" });
    }
  }
  deps.onPlan?.(tasks);

  let steps = 0;
  while (steps < maxSteps) {
    const next = remaining(tasks)[0];
    if (!next) return { tasks, steps, stopped: "complete" };

    const before = remaining(tasks).length;
    next.status = "doing";
    deps.onPlan?.(tasks);
    steps++;

    let text: string;
    try {
      text = await deps.run(STEP_PROMPT(tasks, goal));
    } catch (e) {
      // A failed turn ends the run rather than burning the budget retrying;
      // the handoff has already saved the conversation.
      next.status = "failed";
      next.note = e instanceof Error ? e.message.slice(0, 80) : String(e);
      deps.onPlan?.(tasks);
      return { tasks, steps, stopped: "stuck" };
    }

    // A turn may finish several steps, and says so per step.
    const verdicts = readStepVerdicts(text);
    for (const v of verdicts) {
      const task = tasks.find((t) => t.id === v.id);
      if (task && task.status !== "done") task.status = v.status;
    }

    const outcome = readOutcome(text);
    for (const title of outcome.added) {
      if (tasks.length >= 12) break;
      tasks.push({ id: tasks.length + 1, title, status: "todo" });
    }

    // A reply that reports nothing at all still moves the run: the step it was
    // pointed at is taken as done, the same reading a single-step turn used to
    // get, so silence cannot loop forever.
    if (verdicts.length === 0) {
      next.status = outcome.status;
      if (outcome.note) next.note = outcome.note;
    }

    // And a reply that says the goal itself is met ends the run, whatever the
    // per-step bookkeeping says. Insisting every task carry its own DONE is
    // what made this path cost more than having no plan at all.
    if (saysAllDone(text)) {
      for (const t of tasks) {
        if (t.status === "todo" || t.status === "doing") t.status = "done";
      }
      deps.onPlan?.(tasks);
      return { tasks, steps, stopped: "complete" };
    }
    deps.onPlan?.(tasks);

    // No progress at all, twice running, is not a run that needs more turns.
    if (remaining(tasks).length === before && steps > 1) {
      return { tasks, steps, stopped: "stuck" };
    }

    // Three failures in a row is not a run that needs more steps.
    const tail = tasks.filter((t) => t.status !== "todo").slice(-3);
    if (tail.length === 3 && tail.every((t) => t.status === "failed")) {
      return { tasks, steps, stopped: "stuck" };
    }
  }

  return { tasks, steps, stopped: "budget" };
}
