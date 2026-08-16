/**
 * gahoole against Claude Code, on the same nine tasks.
 *
 * What this measures is a **harness plus a model**, not a model. Claude Code
 * gets native tool calling and a purpose-built Read/Write/Bash toolset;
 * gahoole types into a browser and parses markers out of rendered prose. Any
 * gap includes that difference, and on the tool-using groups it is most of it.
 * The reasoning group is the one place the comparison is close to fair — no
 * tools are involved, so it is prompt in, answer out on both sides.
 *
 * Each contender runs in its own scratch directory, so nobody inherits
 * anybody's files, and every task is verified by the same code from
 * bench-tasks.ts rather than by reading the reply.
 *
 *   npm run duel              everyone
 *   npm run duel -- claude    only the Claude Code side
 *   npm run duel -- gahoole   only gahoole
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TASKS, type BenchTask, type Group } from "./bench-tasks.js";
import { log } from "./output.js";

const ROOT = process.cwd();
const ARENA = path.join(ROOT, "duel-tmp");

interface Result {
  contender: string;
  id: string;
  group: Group;
  pass: boolean;
  seconds: number;
  turns: number;
  costUSD: number;
  denied: string[];
}

/** One contender's answer to one task. */
interface Attempt {
  answer: string;
  turns: number;
  costUSD: number;
  /** Tools the harness refused. Any of these invalidates the attempt. */
  denied?: string[];
}

// ---------------------------------------------------------------------------
// Claude Code, headless
// ---------------------------------------------------------------------------

interface ClaudeJson {
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  is_error?: boolean;
  permission_denials?: { tool_name?: string }[];
}

/**
 * `claude -p` in its own directory, with the tools these tasks need granted.
 *
 * Two things this got wrong the first time, both worth keeping written down.
 * `--permission-mode acceptEdits` grants file edits and *not* Bash, so every
 * task that had to run a program stalled on a permission it could never be
 * given headlessly — three failures each for haiku and sonnet that were the
 * harness, not the model. And `--allowedTools` is variadic, so the prompt has
 * to come before it or it is eaten as another tool name.
 *
 * Denials are recorded rather than ignored: a run that was refused a tool is
 * not a run that failed the task, and the report says so.
 */
function runClaude(model: string, prompt: string, cwd: string): Promise<Attempt> {
  return new Promise((resolve) => {
    execFile(
      "claude",
      [
        "-p",
        prompt, // before --allowedTools: that flag is variadic and would eat it
        "--model",
        model,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
      ],
      { cwd, timeout: 300_000, maxBuffer: 1 << 24 },
      (err, stdout) => {
        if (err && !stdout) {
          resolve({ answer: `ERROR: ${err.message}`, turns: 0, costUSD: 0 });
          return;
        }
        try {
          const json = JSON.parse(stdout) as ClaudeJson;
          resolve({
            answer: json.result ?? "",
            turns: json.num_turns ?? 0,
            costUSD: json.total_cost_usd ?? 0,
            denied: (json.permission_denials ?? []).map(
              (d) => d.tool_name ?? "?",
            ),
          });
        } catch {
          // Not JSON: hooks and warnings sometimes precede it on stdout.
          const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
          const json = line ? (JSON.parse(line) as ClaudeJson) : {};
          resolve({
            answer: json.result ?? stdout.slice(0, 500),
            turns: json.num_turns ?? 0,
            costUSD: json.total_cost_usd ?? 0,
          });
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// gahoole
// ---------------------------------------------------------------------------

/**
 * Built lazily: importing the backend launches a browser, which is not worth
 * doing for `npm run duel -- claude`.
 */
async function makeGahoole(): Promise<{
  attempt: (task: BenchTask) => Promise<Attempt>;
  close: () => Promise<void>;
}> {
  const { Lifecycle } = await import("./lifecycle.js");
  const { createAgent, createMemory } = await import("./agent.js");
  const { createBackend, backendKind } = await import("./backends/index.js");
  const { ToolLoop } = await import("./tool-loop.js");
  const { Session } = await import("./session.js");
  const { tools: localTools } = await import("./tools.js");
  const { registerFileGuard } = await import("./hooks/file-guard.js");
  const { runAutonomously } = await import("./autonomous.js");
  const { findProfile, toolsFor } = await import("./profiles.js");

  const lifecycle = new Lifecycle();
  registerFileGuard(lifecycle);

  const memory = createMemory();
  const agent = createAgent(lifecycle, memory);
  const raw = createBackend(backendKind(), agent, "duel", () => "duel");
  const loop = new ToolLoop(raw, { ...localTools }, lifecycle);
  Session.backend = loop;

  // The profile is chosen the way a person would choose it: the thinking one
  // for the thinking tasks, the building one for the rest. Running every task
  // under one profile would measure the profile, not the agent.
  const pythia = findProfile("pythia")!;
  const daedalus = findProfile("daedalus")!;

  return {
    attempt: async (task) => {
      const profile = task.group === "reason" ? pythia : daedalus;
      loop.use(profile, toolsFor(profile, { ...localTools }));
      raw.reset?.();

      const session = await Session.start({
        agent,
        memory,
        lifecycle,
        resourceId: "duel",
      });
      // Round trips, not tool calls: a reply carrying three calls costs one
      // query, and counting calls would hide the whole point of batching.
      const queriesBefore = loop.queries;
      const spinsBefore = loop.spins;
      let answer = "";
      try {
        if (task.group === "auto") {
          await runAutonomously(task.prompt, {
            maxSteps: 5,
            run: async (p) => {
              answer = await session.run(p);
              return answer;
            },
          });
        } else {
          answer = await session.run(task.prompt);
        }
      } catch (e) {
        answer = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      await session.end("exit");
      // gahoole's cost is queries against a rate limit, not dollars.
      const spins = loop.spins - spinsBefore;
      if (spins) log(`     ${spins} repeated round${spins === 1 ? "" : "s"}`);
      return { answer, turns: loop.queries - queriesBefore, costUSD: 0 };
    },
    close: async () => {
      await raw.close?.();
    },
  };
}

// ---------------------------------------------------------------------------

const CONTENDERS = [
  { name: "haiku-4.5", model: "claude-haiku-4-5" },
  { name: "sonnet-5", model: "claude-sonnet-5" },
  { name: "opus-5", model: "claude-opus-5" },
];

async function main(): Promise<void> {
  const only = process.argv[2];
  const group = process.argv[3] as Group | undefined;
  const doClaude = !only || only === "claude";
  const doGahoole = !only || only === "gahoole";
  const tasks = group ? TASKS.filter((t) => t.group === group) : TASKS;

  fs.rmSync(ARENA, { recursive: true, force: true });
  const results: Result[] = [];

  const record = (
    contender: string,
    task: BenchTask,
    attempt: Attempt,
    dir: string,
    started: number,
  ) => {
    const read = (f: string) => {
      try {
        return fs.readFileSync(path.join(dir, f), "utf8");
      } catch {
        return "";
      }
    };
    let pass = false;
    try {
      pass = task.check(attempt.answer, read);
    } catch {
      pass = false;
    }
    const r: Result = {
      contender,
      id: task.id,
      group: task.group,
      pass,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      turns: attempt.turns,
      costUSD: attempt.costUSD,
      denied: attempt.denied ?? [],
    };
    results.push(r);
    console.log(
      `${pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ` +
        `${contender.padEnd(10)} ${task.id.padEnd(18)} ` +
        `${String(r.turns).padStart(2)} turns · ${String(r.seconds).padStart(5)}s` +
        (r.costUSD ? ` · $${r.costUSD.toFixed(3)}` : "") +
        (r.denied.length ? `  \x1b[33mdenied ${[...new Set(r.denied)].join(",")}\x1b[0m` : ""),
    );
    // A failure that never produced an answer is a transport failure, not a
    // wrong one, and the two should never be read as the same number.
    if (!pass) {
      const why = attempt.answer.trim();
      console.log(
        `     \x1b[2m${why ? `${why.replace(/\s+/g, " ").slice(0, 160)}` : "(empty answer)"}\x1b[0m`,
      );
    }
  };

  if (doClaude) {
    for (const c of CONTENDERS) {
      for (const task of tasks) {
        // Its own cwd, holding the bench-tmp the prompt names.
        const home = path.join(ARENA, c.name, task.id.replace("/", "-"));
        const work = path.join(home, "bench-tmp");
        fs.mkdirSync(work, { recursive: true });
        task.setup?.(work);
        const started = Date.now();
        const attempt = await runClaude(c.model, task.prompt, home);
        record(c.name, task, attempt, work, started);
      }
    }
  }

  if (doGahoole) {
    // gahoole resolves tool paths against its own cwd, so its arena is the
    // repository's bench-tmp rather than one under duel-tmp.
    const work = path.join(ROOT, "bench-tmp");
    const g = await makeGahoole();
    try {
      for (const task of tasks) {
        fs.rmSync(work, { recursive: true, force: true });
        fs.mkdirSync(work, { recursive: true });
        task.setup?.(work);
        const started = Date.now();
        const attempt = await g.attempt(task);
        record("gahoole", task, attempt, work, started);
      }
    } finally {
      await g.close();
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  fs.rmSync(ARENA, { recursive: true, force: true });
  report(results);
  process.exit(0);
}

function report(rs: Result[]): void {
  const names = [...new Set(rs.map((r) => r.contender))];
  const groups: Group[] = ["reason", "solve", "auto"];
  const pct = (n: number, d: number) => (d === 0 ? "  —" : `${Math.round((n / d) * 100)}%`);

  console.log(`\n\x1b[1mpass rate\x1b[0m`);
  console.log(`  ${"".padEnd(10)} ${groups.map((g) => g.padStart(8)).join("")}${"total".padStart(9)}`);
  for (const name of names) {
    const mine = rs.filter((r) => r.contender === name);
    const cells = groups.map((g) => {
      const inGroup = mine.filter((r) => r.group === g);
      return `${inGroup.filter((r) => r.pass).length}/${inGroup.length}`.padStart(8);
    });
    const passed = mine.filter((r) => r.pass).length;
    console.log(
      `  ${name.padEnd(10)} ${cells.join("")}${`${passed}/${mine.length}`.padStart(9)}  ${pct(passed, mine.length)}`,
    );
  }

  console.log(`\n\x1b[1mcost of a pass\x1b[0m`);
  for (const name of names) {
    const mine = rs.filter((r) => r.contender === name);
    const secs = mine.reduce((a, r) => a + r.seconds, 0);
    const turns = mine.reduce((a, r) => a + r.turns, 0);
    const usd = mine.reduce((a, r) => a + r.costUSD, 0);
    console.log(
      `  ${name.padEnd(10)} ${`${Math.round(secs)}s`.padStart(6)} total · ` +
        `${(secs / mine.length).toFixed(1)}s per task · ${turns} turns` +
        (usd ? ` · $${usd.toFixed(2)}` : " · no per-token cost"),
    );
  }

  const blocked = rs.filter((r) => r.denied.length);
  if (blocked.length) {
    console.log(
      `\n\x1b[33m${blocked.length} attempts were refused a tool by the harness — ` +
        `those are not model failures\x1b[0m`,
    );
  }

  const failures = rs.filter((r) => !r.pass);
  if (failures.length) {
    console.log(`\n\x1b[1mfailures\x1b[0m`);
    for (const f of failures) console.log(`  ${f.contender.padEnd(10)} ${f.id}`);
  }
}

await main();
