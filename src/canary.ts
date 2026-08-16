/**
 * Is the page still the page we think it is?
 *
 * Everything here rests on selectors nobody promised us: a composer found by
 * `textarea:visible`, a send button found by its aria-label, a conversation
 * found by `data-subtree="aimc"`. Google can change any of them on any day,
 * and when it does every session fails at once with an error that describes a
 * symptom rather than the cause.
 *
 * This checks each one separately and says which broke. Run it on a schedule
 * and the answer arrives before a person hits it:
 *
 *   npm run canary            human-readable, exit 1 on failure
 *   npm run canary -- --json  one JSON object, for a cron job to alert on
 *
 * It costs a single query, so running it every hour is roughly 1% of the rate
 * limit.
 */
import { AiModeBackend } from "./backends/aimode.js";

interface Check {
  name: string;
  what: string;
  ok: boolean;
  detail?: string;
  ms: number;
}

const checks: Check[] = [];

async function check(name: string, what: string, fn: () => Promise<string | undefined>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    checks.push({ name, what, ok: true, detail, ms: Date.now() - started });
    return true;
  } catch (e) {
    checks.push({
      name,
      what,
      ok: false,
      detail: e instanceof Error ? e.message.split("\n")[0] : String(e),
      ms: Date.now() - started,
    });
    return false;
  }
}

// The question matters: short enough to send as a URL, dull enough that no
// safety filter will decline it, and with an answer that cannot drift.
const QUESTION = "2 + 2 は？ 数字だけ答えて。";

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const backend = new AiModeBackend({ headed: process.env.GAHOOLE_HEADED === "1" });

  let answer = "";
  const launched = await check("launch", "the browser starts and the profile is usable", async () => {
    // `ask` covers launch, navigation, the composer, the send button and the
    // read — the checks below take that one query apart rather than spending
    // more of them.
    answer = await backend.ask(QUESTION);
    return `${answer.length} chars back`;
  });

  if (launched) {
    await check("answer", "an answer comes back at all", async () => {
      if (!answer.trim()) throw new Error("empty answer — the container never filled");
      return `${answer.slice(0, 60).replace(/\s+/g, " ")}…`;
    });

    await check("content", "the answer is the answer to the question", async () => {
      if (!/\b4\b|４/.test(answer)) {
        throw new Error(`asked for 2+2 and got: ${answer.slice(0, 120).replace(/\s+/g, " ")}`);
      }
      return "2 + 2 = 4";
    });

    await check("not-rate-limited", "this profile is not currently refused", async () => {
      if (/エラーが発生したため|回答が生成されませんでした|error occurred/i.test(answer)) {
        throw new Error("rate limited — rotate the profile or wait");
      }
      return "answering normally";
    });
  }

  await backend.close().catch(() => {});

  const failed = checks.filter((c) => !c.ok);
  if (json) {
    console.log(
      JSON.stringify({
        ok: failed.length === 0,
        at: new Date().toISOString(),
        checks,
      }),
    );
  } else {
    for (const c of checks) {
      const mark = c.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(
        `${mark} ${c.name.padEnd(17)} ${String(c.ms).padStart(6)}ms  ${c.detail ?? c.what}`,
      );
    }
    console.log(
      failed.length === 0
        ? "\n\x1b[32mthe page is still the page\x1b[0m"
        : `\n\x1b[31m${failed.length} check${failed.length === 1 ? "" : "s"} failed — ` +
            `${failed.map((f) => f.name).join(", ")}\x1b[0m`,
    );
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
