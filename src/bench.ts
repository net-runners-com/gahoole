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

const DIR = path.resolve("bench-tmp");

type Group = "reason" | "solve" | "auto";

interface Task {
  id: string;
  group: Group;
  prompt: string;
  /** Steps a person would have to take; used for the autonomy score. */
  steps: number;
  setup?: () => void;
  check: (answer: string) => boolean;
}

const read = (f: string): string => {
  try {
    return fs.readFileSync(path.join(DIR, f), "utf8");
  } catch {
    return "";
  }
};
const has = (answer: string, ...needles: string[]): boolean =>
  needles.some((n) => answer.toLowerCase().includes(n.toLowerCase()));

const TASKS: Task[] = [
  // --- reasoning: one checkable answer, arrived at in several hops ----------
  {
    id: "reason/ages",
    group: "reason",
    steps: 1,
    prompt:
      "アリスはボブより3歳年上で、ボブはキャロルの2倍の年齢です。3人の年齢の合計は33歳です。ボブは何歳ですか。数字だけ答えて。",
    check: (a) => /\b12\b/.test(a),
  },
  {
    id: "reason/schedule",
    group: "reason",
    steps: 1,
    prompt:
      "会議は9:00に始まり45分続きます。その後15分休憩し、次の会議は前の会議の2倍の長さです。2つ目の会議は何時に終わりますか。HH:MM形式で答えて。",
    check: (a) => /11:30/.test(a),
  },
  {
    id: "reason/contradiction",
    group: "reason",
    steps: 1,
    prompt:
      "「このリストの全ての数は偶数です」と言われました。リストは [2, 4, 7, 8] です。この主張は正しいですか。正しくない場合、反例の数字だけを挙げて。",
    check: (a) => /\b7\b/.test(a),
  },

  // --- problem solving: a verifiable end state, reached with tools ----------
  {
    id: "solve/write",
    group: "solve",
    steps: 1,
    prompt: `bench-tmp/greet.txt というファイルを作って、中身を正確に "hello gahoole" にして。`,
    check: () => read("greet.txt").trim() === "hello gahoole",
  },
  {
    id: "solve/compute",
    group: "solve",
    steps: 2,
    prompt:
      "1から50までの整数のうち、3の倍数の合計を、実際にプログラムを書いて実行して求めて。最後に数字だけを答えて。",
    // 3+6+...+48 = 408
    check: (a) => /\b408\b/.test(a),
  },
  {
    id: "solve/fix",
    group: "solve",
    steps: 2,
    setup: () =>
      fs.writeFileSync(
        path.join(DIR, "add.js"),
        "function add(a, b) { return a - b; }\nconsole.log(add(2, 3));\n",
      ),
    prompt:
      "bench-tmp/add.js にバグがあります。add(2,3) が 5 を出力するように直して、node で実行して確認して。",
    check: () => /return a \+ b/.test(read("add.js")),
  },

  // --- autonomy: dependent steps, no one stepping in -----------------------
  {
    id: "auto/cpp",
    group: "auto",
    steps: 3,
    prompt:
      "bench-tmp/fizz.cpp に 1から15までのFizzBuzzを出力するC++を書いて、g++でコンパイルして、実行して出力を確認する",
    check: (a) =>
      read("fizz.cpp").includes("iostream") && has(a, "FizzBuzz", "Fizz"),
  },
  {
    id: "auto/pipeline",
    group: "auto",
    steps: 3,
    prompt:
      "bench-tmp/nums.txt に 1行1つで 5,3,9,1 と書いて、node でそれを読んで昇順に並べ替えて bench-tmp/sorted.txt に書き、結果を確認する",
    check: () => read("sorted.txt").replace(/\s+/g, ",").replace(/^,|,$/g, "") === "1,3,5,9",
  },
  {
    id: "auto/inspect",
    group: "auto",
    steps: 2,
    setup: () =>
      fs.writeFileSync(
        path.join(DIR, "data.json"),
        JSON.stringify({ users: [{ name: "a" }, { name: "b" }, { name: "c" }] }),
      ),
    prompt:
      "bench-tmp/data.json を読んで users の件数を数え、その数を bench-tmp/count.txt に書く",
    check: () => read("count.txt").trim() === "3",
  },
];

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
    task.setup?.();

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
      pass = task.check(answer);
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
