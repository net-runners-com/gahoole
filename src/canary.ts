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
 * It costs two queries — one through the URL and one through the composer,
 * because those are different paths and the composer is the one a real
 * session lives on. Hourly is about 2% of the rate limit.
 */
import {
  AiModeBackend,
  COMPOSER,
  CONVERSATION,
  SEND,
  whichMatched,
} from "./backends/aimode.js";

/** Not exported from the backend; only the canary needs to name it. */
const ADD_FILES_FIRST = 'button[aria-label="ファイルとツールを追加"]';

/** What each list starts with, so a fallback stands out from a match. */
const FIRST_CHOICE: Record<string, string> = {
  composer: COMPOSER[0]!,
  send: SEND[0]!,
  conversation: CONVERSATION[0]!,
  "add files": ADD_FILES_FIRST,
};

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

    // A second question, because the first does not touch the composer: a
    // short prompt goes out as a URL, and the selectors that would break a
    // real session are the ones used to type and to send.
    await check("composer", "the composer and the send button still work", async () => {
      const again = await backend.ask("3 + 3 は？ 数字だけ答えて。");
      if (!/\b6\b|６/.test(again)) {
        throw new Error(`asked for 3+3 and got: ${again.slice(0, 80).replace(/\s+/g, " ")}`);
      }
      return "typed and sent";
    });

    await check("not-rate-limited", "this profile is not currently refused", async () => {
      if (/エラーが発生したため|回答が生成されませんでした|error occurred/i.test(answer)) {
        throw new Error("rate limited — rotate the profile or wait");
      }
      return "answering normally";
    });
  }

  // Everything, including the ones a working session never touches.
  if (launched) await backend.checkSelectors().catch(() => undefined);

  // Which selector carried it. The interesting state is not "it works" but
  // "it works because the second choice matched" — a fallback quietly holding
  // the page up is the warning that the first one is gone.
  const used = whichMatched();
  for (const [what, selector] of Object.entries(used)) {
    const first = FIRST_CHOICE[what];
    checks.push({
      name: `selector:${what}`,
      what: "the first choice still matches",
      ok: selector === first,
      detail: selector === first ? selector : `fell back to ${selector}`,
      ms: 0,
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
