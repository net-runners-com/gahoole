/**
 * How far does rotation actually get?
 *
 * The backend answers a rate limit by opening a fresh browser profile, on the
 * measured finding that the limit is keyed on the session cookie rather than
 * the IP. What was never measured is the thing that decides whether long runs
 * are possible at all: how many queries each profile is good for, and whether
 * the second and third profiles get the same allowance as the first or a
 * smaller one.
 *
 *   npm run ratelimit              until three profiles are exhausted
 *   npm run ratelimit -- 5 200     five profiles, 200 queries each at most
 *
 * This deliberately spends the rate limit — that is the measurement. Expect it
 * to take as long as the limit takes to reach, and to leave the profiles it
 * used unusable for a while afterwards. Results are written to
 * `data/ratelimit.json` so a later run can be compared rather than remembered.
 */
import fs from "node:fs";
import path from "node:path";
import { AiModeBackend, AiModeRateLimitError } from "./backends/aimode.js";
import { inProject } from "./paths.js";

const OUT = inProject("ratelimit.json");

interface ProfileRun {
  profile: number;
  queries: number;
  seconds: number;
  /** Milliseconds between the first query and the one that was refused. */
  spanMs: number;
  endedBy: "limit" | "budget" | "error";
  note?: string;
}

/** Short, dull, and different every time so nothing can be served from cache. */
const question = (n: number) => `${n} に 1 を足すと？ 数字だけ答えて。`;

async function main(): Promise<void> {
  const profiles = Number(process.argv[2] ?? 3);
  const perProfile = Number(process.argv[3] ?? 200);
  const runs: ProfileRun[] = [];

  for (let p = 0; p < profiles; p++) {
    // A backend of its own per profile, with rotation switched off — rotation
    // is what is being measured, so it must not happen behind the measurement.
    const backend = new AiModeBackend({
      headed: false,
      profile: p,
      maxRotations: 0,
    });

    let queries = 0;
    const started = Date.now();
    let firstAt = 0;
    let ended: ProfileRun["endedBy"] = "budget";
    let note: string | undefined;

    try {
      for (; queries < perProfile; queries++) {
        const answer = await backend.ask(question(queries + 1));
        if (queries === 0) firstAt = Date.now();
        if (queries % 10 === 0) {
          process.stdout.write(
            `\r  profile ${p}: ${queries + 1} queries, ${Math.round((Date.now() - started) / 1000)}s`,
          );
        }
        void answer;
      }
    } catch (e) {
      if (e instanceof AiModeRateLimitError) {
        ended = "limit";
      } else {
        ended = "error";
        note = e instanceof Error ? e.message.slice(0, 120) : String(e);
      }
    }

    await backend.close().catch(() => {});
    const run: ProfileRun = {
      profile: p,
      queries,
      seconds: Math.round((Date.now() - started) / 1000),
      spanMs: firstAt ? Date.now() - firstAt : 0,
      endedBy: ended,
      note,
    };
    runs.push(run);
    process.stdout.write(
      `\r  profile ${p}: \x1b[1m${run.queries}\x1b[0m queries in ${run.seconds}s — ${run.endedBy}` +
        `${note ? ` (${note})` : ""}\n`,
    );

    // A profile that died of something other than the limit says nothing about
    // the limit, and the next one will probably die the same way.
    if (ended === "error") break;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    `${JSON.stringify({ at: new Date().toISOString(), runs }, null, 2)}\n`,
  );

  const limited = runs.filter((r) => r.endedBy === "limit");
  console.log("\n\x1b[1mwhat rotation buys\x1b[0m");
  if (limited.length === 0) {
    console.log("  no profile reached the limit — the budget was the binding constraint");
  } else {
    const total = limited.reduce((a, r) => a + r.queries, 0);
    console.log(
      `  ${limited.map((r) => r.queries).join(" + ")} = ${total} queries across ` +
        `${limited.length} profile${limited.length === 1 ? "" : "s"}`,
    );
    const first = limited[0]!.queries;
    const later = limited.slice(1);
    if (later.length) {
      const avg = Math.round(later.reduce((a, r) => a + r.queries, 0) / later.length);
      console.log(
        `  first profile ${first}, later ones ${avg} on average — ` +
          (avg >= first * 0.8
            ? "rotation buys a full allowance each time"
            : "later profiles are refused sooner, so rotation is not free"),
      );
    }
  }
  console.log(`\n  written to ${path.relative(process.cwd(), OUT)}`);
  process.exit(0);
}

await main();
