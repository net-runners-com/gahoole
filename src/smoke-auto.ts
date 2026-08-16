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

// Plan, then one turn per step, then complete.
{
  const s = script([
    "1. write the file\n2. compile it\n3. run it",
    "wrote it. DONE",
    "compiled. DONE",
    "ran it. DONE",
  ]);
  const r = await runAutonomously("build fizzbuzz", { run: s.run });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 3);
  assert.ok(r.tasks.every((t) => t.status === "done"));
  assert.equal(s.seen.length, 4, "one planning turn plus one per step");
  assert.ok(s.seen[1]?.includes("Now do step 1"), "steps are given one at a time");
  assert.ok(s.seen[2]?.includes("write the file"), "and carry the plan with them");
}

// A step can add work it discovered.
{
  const s = script([
    "1. read the config\n2. apply the change",
    "DONE\nNEXT: back up the original first",
    "DONE",
    "DONE",
  ]);
  const r = await runAutonomously("edit config", { run: s.run });
  assert.equal(r.tasks.length, 3, "the discovered step joins the list");
  assert.equal(r.tasks[2]?.title, "back up the original first");
  assert.equal(r.stopped, "complete");
}

// The budget is a hard stop.
{
  const s = script(["1. one thing\n2. two thing\n3. three thing"]);
  const r = await runAutonomously("go", { run: s.run, maxSteps: 2 });
  assert.equal(r.stopped, "budget");
  assert.equal(r.steps, 2);
}

// Three failures in a row is not a run that needs more steps.
{
  const s = script([
    "1. one thing\n2. two thing\n3. three thing\n4. four thing",
    "FAILED no compiler",
    "FAILED still none",
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

// No list means the reply was the answer, and no queries are spent forcing one.
{
  const s = script(["It is 42."]);
  const r = await runAutonomously("what is the answer?", { run: s.run });
  assert.equal(r.stopped, "complete");
  assert.equal(r.steps, 0);
  assert.equal(s.seen.length, 1);
}

assert.ok(renderPlan([{ id: 1, title: "x", status: "done" }], false).includes("✓ 1. x"));

console.log("ok — autonomous: plan, step, discover, budget, stuck, no-plan");
process.exit(0);
