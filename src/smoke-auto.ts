/**
 * Autonomous run smoke test. Offline: the turns are a scripted stub, so
 * planning, stepping, the verdict keywords, discovered tasks and every
 * stopping condition are exercised without a query.
 */
import assert from "node:assert/strict";
import { runAutonomously } from "./autonomous.js";
import { parsePlan, readOutcome, renderPlan } from "./plan.js";

// --- parsing ----------------------------------------------------------------
{
  // A plan arrives wrapped in prose far more often than as a bare list.
  const tasks = parsePlan(
    "承知しました。以下の手順で進めます。\n1. fizzbuzz.cpp を書く\n2. g++ でコンパイルする\n3. 実行して出力を確認する\nよろしいですか？",
  );
  assert.equal(tasks.length, 3);
  assert.equal(tasks[1]?.title, "g++ でコンパイルする");
  assert.ok(tasks.every((t) => t.status === "todo"));

  // Bullets count too; short fragments are not steps.
  assert.equal(parsePlan("- write the file\n- ok\n* run the tests").length, 2);
  assert.equal(parsePlan("no list here at all").length, 0);
  // A runaway list is capped.
  assert.equal(
    parsePlan(Array.from({ length: 30 }, (_, i) => `${i + 1}. step number ${i}`).join("\n"))
      .length,
    12,
  );
}

{
  assert.equal(readOutcome("wrote the file. DONE").status, "done");
  assert.equal(readOutcome("すでに存在するので SKIP").status, "skipped");
  assert.equal(readOutcome("コンパイラが無く FAILED").status, "failed");
  // A step that says nothing is done, not looped over again.
  assert.equal(readOutcome("wrote it").status, "done");
  assert.deepEqual(readOutcome("DONE\nNEXT: add a test for negatives").added, [
    "add a test for negatives",
  ]);
}

// --- the run ----------------------------------------------------------------
const script = (replies: string[]) => {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    run: async (p: string) => {
      seen.push(p);
      return replies[i++] ?? "DONE";
    },
  };
};

// One turn may finish several steps, and says so per step. Measured: walking
// the plan a step per turn cost 32 queries on the benchmark's three autonomous
// tasks, asking for everything outstanding cost 23 — the model batches a write
// and the command that runs it, and one step per turn forbids that.
{
  const s = script([
    "1. write the file\n2. compile it\n3. run it",
    "wrote and compiled.\nSTEP 1 DONE\nSTEP 2 DONE",
    "ran it.\nSTEP 3 DONE\nDONE",
  ]);
  const r = await runAutonomously("build fizzbuzz", { run: s.run });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 2, "three steps in two turns");
  assert.ok(r.tasks.every((t) => t.status === "done"));
  assert.equal(s.seen.length, 3, "one planning turn plus two working turns");
  assert.ok(
    s.seen[1]?.includes("still outstanding"),
    "the turn is asked for everything left, not for one step",
  );
  assert.ok(s.seen[1]?.includes("write the file"), "and carries the plan with it");
}

// The planning turn is asked to start work too, so its own verdict counts.
{
  const s = script([
    "1. write the file\n2. run it\nwrote it. DONE",
    "ran it.\nSTEP 2 DONE\nDONE",
  ]);
  const r = await runAutonomously("build it", { run: s.run });
  assert.equal(r.tasks[0]?.status, "done", "step 1 was finished while planning");
  assert.equal(r.steps, 1, "so only one working turn was needed");
}

// A reply that reports nothing still moves: silence is taken as done, the same
// reading a one-step turn used to get, so it cannot loop forever.
{
  const s = script([
    "1. one thing\n2. two thing",
    "I had a look around.",
    "and again.",
  ]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 4 });
  assert.equal(r.stopped, "complete");
  assert.ok(r.steps <= 2);
}

// One DONE for the whole goal ends the run, however many steps are unticked.
// Requiring each to carry its own is what made planning cost more than not
// planning at all: 41 queries against 33 on the same three benchmark tasks.
{
  const s = script([
    "1. one thing\n2. two thing\n3. three thing",
    "did the lot. DONE",
  ]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 8 });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 1, "one working turn, not three");
  assert.ok(r.tasks.every((t) => t.status === "done"));
}

// ...and a step's own DONE is not mistaken for the goal's.
{
  const s = script([
    "1. one thing\n2. two thing",
    "STEP 1 DONE",
    "STEP 2 DONE\nDONE",
  ]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 8 });
  assert.equal(r.steps, 2, "STEP 1 DONE did not end the run");
}

// A step can add work it discovered.
{
  const s = script([
    "1. read the config\n2. apply the change",
    "STEP 1 DONE\nNEXT: back up the original first",
    "STEP 2 DONE",
    "STEP 3 DONE\nDONE",
  ]);
  const r = await runAutonomously("edit config", { run: s.run });
  assert.equal(r.tasks.length, 3, "the discovered step joins the list");
  assert.equal(r.tasks[2]?.title, "back up the original first");
  assert.equal(r.stopped, "complete");
}

// The budget is a hard stop. The replies report per-step progress and never
// claim the goal itself is met, which is the only thing that ends a run early.
{
  const s = script([
    "1. one thing\n2. two thing\n3. three thing",
    "STEP 1 DONE",
    "STEP 2 DONE",
    "STEP 3 DONE",
  ]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 2 });
  assert.equal(r.stopped, "budget");
  assert.equal(r.steps, 2);
}

// Three failures in a row is not a run that needs more steps.
{
  const s = script([
    "1. one thing\n2. two thing\n3. three thing\n4. four thing",
    "STEP 1 FAILED no compiler",
    "STEP 2 FAILED still none",
    "FAILED give up",
  ]);
  const r = await runAutonomously("go", { run: s.run });
  assert.equal(r.stopped, "stuck");
  assert.equal(r.steps, 3, "and it stops without spending the fourth");
}

// A turn that throws ends the run; the handoff has already saved the session.
{
  let n = 0;
  const r = await runAutonomously("go", {
    run: async () => {
      if (n++ === 0) return "1. first thing\n2. second thing";
      throw new Error("rate_limit");
    },
  });
  assert.equal(r.stopped, "stuck");
  assert.equal(r.tasks[0]?.status, "failed");
  assert.match(r.tasks[0]?.note ?? "", /rate_limit/);
}

// No list is not the same as finished: the run asks whether the goal is met
// and keeps going while it is not.
{
  const s = script(["書きました。", "並べ替えました。", "確認しました。DONE"]);
  const r = await runAutonomously("整列して保存する", { run: s.run });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 2, "two more turns before it said DONE");
  assert.ok(s.seen[1]?.includes("not described, not planned"));
}

// A first reply that already says DONE spends nothing further.
{
  const s = script(["It is 42. DONE"]);
  const r = await runAutonomously("what is the answer?", { run: s.run });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 0);
  assert.equal(s.seen.length, 1);
}

// And a model that never says DONE is bounded.
{
  const s = script(["a", "b", "c", "d", "e", "f"]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 3 });
  assert.equal(r.stopped, "budget");
  assert.equal(r.steps, 3);
}

assert.ok(renderPlan([{ id: 1, title: "x", status: "done" }], false).includes("✓ 1. x"));

// The run's last word has to be worth reading. Asking for "STEP <n> DONE"
// markers got replies that were nothing but markers — one measured run ended
// with "STEP 2 DONE STEP 3 DONE DONE" and told the person who asked nothing
// at all about what had been built.
{
  const asked: string[] = [];
  const r = await runAutonomously("build it", {
    run: async (p) => {
      asked.push(p);
      return "1. write it\n2. run it";
    },
    maxSteps: 1,
  });
  void r;
  const step = asked[1] ?? asked[0]!;
  assert.match(step, /STEP <number> DONE/, "the markers are still asked for");
  assert.match(
    step.replace(/\s+/g, " "),
    /sentence saying what the result actually was/,
    "and so is a sentence a person can read",
  );
}

console.log("ok — autonomous: plan, step, discover, budget, stuck, no-plan");
process.exit(0);
