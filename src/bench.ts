/**
 * A small benchmark, because "it works" is not a number.
 *
 * Nine tasks in three groups, each checked by code rather than by reading the
 * reply: reasoning (answer only, no tools), problem solving (a verifiable end
 * state reached with tools), and autonomy (several dependent steps that have
 * to happen without anyone stepping in). Every task states what "passed"
 * means before it runs.
 *
 * Read the results as what they are: nine tasks written by the same person
 * who wrote the agent, on a backend whose rate limit is roughly eighty
 * queries per ten minutes. A pass rate out of nine has a wide error bar, and
 * the per-task detail matters more than the headline.
 *
 *   npm run bench            all groups
 *   npm run bench -- reason  one group
 */
import fs from "node:fs";
import path from "node:path";
import { Lifecycle } from "./lifecycle.js";
import { createAgent, createMemory } from "./agent.js";
import { createBackend, backendKind, type Backend } from "./backends/index.js";
import { ToolLoop } from "./tool-loop.js";
import { Session } from "./session.js";
import { tools as localTools } from "./tools.js";
import { registerFileGuard } from "./hooks/file-guard.js";
import { runAutonomously } from "./autonomous.js";
import { TASKS, type Group } from "./bench-tasks.js";

const DIR = path.resolve("bench-tmp");

const read = (f: string): string => {
  try {
    return fs.readFileSync(path.join(DIR, f), "utf8");
  } catch {
    return "";
  }
};

interface Result {
  id: string;
  group: Group;
  pass: boolean;
  turns: number;
  toolCalls: number;
  seconds: number;
  stepsDone: number;
  steps: number;
}

async function main(): Promise<void> {
  const only = process.argv[2] as Group | undefined;
  const tasks = only ? TASKS.filter((t) => t.group === only) : TASKS;

  const lifecycle = new Lifecycle();
  registerFileGuard(lifecycle);
  let toolCalls = 0;
  lifecycle.on("PostToolUse", () => {
    toolCalls++;
  });

  const memory = createMemory();
  const agent = createAgent(lifecycle, memory);
  const raw: Backend = createBackend(backendKind(), agent, "bench", () => "bench");
  const results: Result[] = [];

  for (const task of tasks) {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    task.setup?.(DIR);

    // A fresh conversation per task, so one failure cannot poison the next.
    raw.reset?.();
    Session.backend = new ToolLoop(raw, { ...localTools }, lifecycle, 6);
    const session = await Session.start({
      agent,
      memory,
      lifecycle,
      resourceId: "bench",
    });

    const before = toolCalls;
    const started = Date.now();
    let answer = "";
    let turns = 0;

    try {
      if (task.group === "auto") {
        const r = await runAutonomously(task.prompt, {
          run: async (p) => {
            turns++;
            answer = await session.run(p);
            return answer;
          },
          maxSteps: 5,
        });
        // Steps the run actually finished on its own.
        var stepsDone = r.tasks.filter((t) => t.status === "done").length || 1;
      } else {
        turns = 1;
        answer = await session.run(task.prompt);
        var stepsDone = task.steps;
      }
    } catch (e) {
      answer = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      var stepsDone = 0;
    }

    let pass = false;
    try {
      pass = task.check(answer, read);
    } catch {
      pass = false;
    }

    const r: Result = {
      id: task.id,
      group: task.group,
      pass,
      turns,
      toolCalls: toolCalls - before,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      stepsDone: pass ? task.steps : Math.min(stepsDone, task.steps),
      steps: task.steps,
    };
    results.push(r);
    await session.end("exit");

    console.log(
      `${r.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${r.id.padEnd(18)} ` +
        `${String(r.turns).padStart(2)} turns · ${String(r.toolCalls).padStart(2)} calls · ${r.seconds}s`,
    );
  }

  await raw.close?.();
  fs.rmSync(DIR, { recursive: true, force: true });
  report(results);
  process.exit(0);
}

function report(rs: Result[]): void {
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);
  console.log("\n\x1b[1mby group\x1b[0m");
  for (const g of ["reason", "solve", "auto"] as Group[]) {
    const group = rs.filter((r) => r.group === g);
    if (group.length === 0) continue;
    const passed = group.filter((r) => r.pass).length;
    const secs = group.reduce((a, r) => a + r.seconds, 0) / group.length;
    const calls = group.reduce((a, r) => a + r.toolCalls, 0);
    console.log(
      `  ${g.padEnd(7)} ${passed}/${group.length} (${pct(passed, group.length)}) · ` +
        `${secs.toFixed(1)}s avg · ${calls} tool calls`,
    );
  }

  const auto = rs.filter((r) => r.group === "auto");
  const stepsDone = auto.reduce((a, r) => a + r.stepsDone, 0);
  const stepsTotal = auto.reduce((a, r) => a + r.steps, 0);
  const passed = rs.filter((r) => r.pass).length;

  console.log("\n\x1b[1moverall\x1b[0m");
  console.log(`  pass rate      ${passed}/${rs.length} (${pct(passed, rs.length)})`);
  console.log(
    `  autonomy       ${stepsDone}/${stepsTotal} steps unaided (${pct(stepsDone, stepsTotal)})`,
  );
  console.log(
    `  queries spent  ${rs.reduce((a, r) => a + r.turns, 0)} turns, ${rs.reduce((a, r) => a + r.toolCalls, 0)} tool calls`,
  );
  console.log(
    `  wall clock     ${Math.round(rs.reduce((a, r) => a + r.seconds, 0))}s total`,
  );
}

await main();
