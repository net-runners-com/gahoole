/**
 * The same instruction, run under each profile.
 *
 *   npm run compare                       the default instruction
 *   npm run compare -- "やること"          your own
 *   npm run compare -- "…" pythia argus   only these
 *
 * A profile changes what the model is told and what it may reach for, and the
 * second half is the one that does the work. This puts that claim where it can
 * be read: one instruction, four runs, the answers side by side.
 *
 * The default instruction is chosen to separate them rather than to be easy.
 * It contains a question and an action, so a profile that cannot act has to
 * say so instead of quietly answering half of it.
 */
import fs from "node:fs";
import path from "node:path";
import { Lifecycle } from "./lifecycle.js";
import { createAgent, createMemory } from "./agent.js";
import { createBackend, backendKind } from "./backends/index.js";
import { ToolLoop } from "./tool-loop.js";
import { Session } from "./session.js";
import { tools as localTools } from "./tools.js";
import { registerFileGuard } from "./hooks/file-guard.js";
import { PROFILES, findProfile, toolsFor, type Profile } from "./profiles.js";

const DEFAULT_PROMPT =
  "src ディレクトリに .ts ファイルは何本ある？ 数えて、その数だけを compare-tmp/count.txt に書いて。";

const DIR = path.resolve("compare-tmp");

interface Result {
  profile: Profile;
  answer: string;
  queries: number;
  toolCalls: number;
  tools: string[];
  seconds: number;
  wrote?: string;
}

async function main(): Promise<void> {
  const prompt = process.argv[2] || DEFAULT_PROMPT;
  const only = process.argv.slice(3);
  const chosen = only.length
    ? only.map((n) => findProfile(n)).filter((p): p is Profile => Boolean(p))
    : PROFILES;

  const lifecycle = new Lifecycle();
  registerFileGuard(lifecycle);
  const used: string[] = [];
  lifecycle.on("PostToolUse", (e) => {
    used.push(e.toolName);
  });

  const memory = createMemory();
  const agent = createAgent(lifecycle, memory);
  const raw = createBackend(backendKind(), agent, "compare", () => "compare");
  const loop = new ToolLoop(raw, { ...localTools }, lifecycle);
  Session.backend = loop;

  const results: Result[] = [];
  console.log(`\x1b[1m${prompt}\x1b[0m\n`);

  for (const profile of chosen) {
    // A clean directory each time, so one profile cannot answer using what
    // another one wrote.
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });

    loop.use(profile, toolsFor(profile, { ...localTools }));
    raw.reset?.();
    const session = await Session.start({
      agent,
      memory,
      lifecycle,
      resourceId: "compare",
    });

    used.length = 0;
    const before = loop.queries;
    const started = Date.now();
    let answer = "";
    try {
      answer = await session.run(prompt);
    } catch (e) {
      answer = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    await session.end("exit");

    let wrote: string | undefined;
    try {
      wrote = fs.readFileSync(path.join(DIR, "count.txt"), "utf8").trim();
    } catch {
      wrote = undefined;
    }

    const r: Result = {
      profile,
      answer: answer.trim(),
      queries: loop.queries - before,
      toolCalls: used.length,
      tools: [...new Set(used)],
      seconds: Math.round((Date.now() - started) / 100) / 10,
      wrote,
    };
    results.push(r);

    console.log(
      `\x1b[1m\x1b[36m${profile.name}\x1b[0m \x1b[2m${profile.summary}\x1b[0m\n` +
        `\x1b[2m  ${r.queries} queries · ${r.toolCalls} tool calls` +
        `${r.tools.length ? ` (${r.tools.join(", ")})` : ""} · ${r.seconds}s` +
        `${r.wrote === undefined ? "" : ` · wrote "${r.wrote}"`}\x1b[0m\n`,
    );
    console.log(`${indent(r.answer)}\n`);
  }

  await raw.close?.();
  fs.rmSync(DIR, { recursive: true, force: true });

  console.log("\x1b[1mside by side\x1b[0m");
  console.log(
    `  ${"profile".padEnd(10)} ${"queries".padStart(7)} ${"calls".padStart(6)} ` +
      `${"secs".padStart(6)}  ${"wrote".padEnd(6)} answer`,
  );
  for (const r of results) {
    const first = r.answer.split("\n").find((l) => l.trim())?.trim() ?? "";
    console.log(
      `  ${r.profile.name.padEnd(10)} ${String(r.queries).padStart(7)} ` +
        `${String(r.toolCalls).padStart(6)} ${String(r.seconds).padStart(6)}  ` +
        `${(r.wrote ?? "—").padEnd(6)} ${first.slice(0, 60)}`,
    );
  }
  process.exit(0);
}

const indent = (text: string): string =>
  text
    .split("\n")
    .slice(0, 14)
    .map((l) => `  ${l}`)
    .join("\n");

await main();
