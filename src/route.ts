import { ollamaHost, ollamaModel, ollamaReady } from "./backends/ollama.js";
import type { Skill } from "./plugins.js";

/**
 * Which skill fits this request, decided here rather than hoped for.
 *
 * Asking the main model to notice a skill did not work. Measured over four
 * runs of the same question — "sales.csv を地域別に集計してExcelにして", with a
 * skill installed that does exactly that — it reached for `use_skill` once and
 * wrote its own pandas the other three times. Five rewordings of the prompt
 * changed nothing, which is the point at which the prompt is not the problem.
 *
 * Choosing between a handful of one-line descriptions is a classification, not
 * a judgement, and a three-billion-parameter model on this machine does it in
 * four tenths of a second for no queries at all. The main model then gets a
 * question it is good at: carrying the skill out.
 *
 * It fails open in every direction. No Ollama, no model, a timeout, an answer
 * that is not one of the names — all of them mean "no skill", which is exactly
 * what happened before this existed.
 *
 * What it is measured to be good at, and what it is not. Deciding whether any
 * skill applies at all is reliable: nine requests, four that match and five
 * that plainly do not, 9/9. Deciding *which* of two sibling commands is not —
 * asked to make a spreadsheet from a CSV it chose doc-build, whose whole
 * premise is an existing spec file, over doc-new, which writes one.
 *
 * Two things were tried against that and neither worked: asking twice with the
 * list in both orders (it was not position bias — the same wrong answer came
 * back both ways) and putting each skill's argument-hint in the prompt (the
 * word "Excel" in doc-build's description outweighs it).
 *
 * So the work is split where the measurement puts it. This decides *whether*
 * a plugin applies, which it is good at. When the plugin it lands on has more
 * than one command, *which* one is left to the model that is about to do the
 * work — narrowed to that plugin's commands, which is a far easier question
 * than the one it fails today, and costs no extra query.
 */

/** Long enough for a local answer, short enough not to be felt. */
const BUDGET_MS = 4000;

const NONE = "none";

export function routingPrompt(skills: Skill[]): string {
  // The whole description, not a first clause.
  //
  // The preamble is where a description has to be short, and that constraint
  // does not apply here — this prompt goes to a model on this machine. Cutting
  // to the first sentence lost the words the choice turns on: doc-new's opens
  // "doc.toml を新規に書き起こす", and asked to make a spreadsheet the router
  // quite correctly said none, because nothing in front of it mentioned one.
  const lines = skills.map(
    (s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").trim().slice(0, 300)}`,
  );
  // Biased towards none, deliberately.
  //
  // A wrong "none" costs nothing — it is what happened before any of this
  // existed. A wrong skill derails an ordinary question into a procedure, so
  // the two errors are not worth the same and the prompt says so. Measured
  // over nine requests, four that match and five that plainly do not: 9/9.
  return [
    "依頼に合うスキルを選ぶ。",
    ...lines,
    `- ${NONE}: 上のどれにも当てはまらない`,
    "",
    `スキルの説明に書かれている作業そのものを求めていなければ ${NONE}。少しでも迷えば ${NONE}。`,
  ].join("\n");
}

export interface RouteResult {
  /** The one to run, when a plugin applies and has only one command. */
  skill?: Skill;
  /**
   * The commands of the plugin that applies, when it has several.
   *
   * Not dispatched: named in the question instead, so the model that is about
   * to do the work chooses between two things it can already see the point of.
   */
  narrowed?: Skill[];
  /** Why there is no skill, when there is not — for the caller to show. */
  why?: string;
  ms: number;
}

export async function chooseSkill(
  request: string,
  incoming: Skill[],
  opts: { host?: string; model?: string } = {},
): Promise<RouteResult> {
  const at = Date.now();
  // Only skills that declare an argument.
  //
  // A skill with an `argument-hint` is a command — something to run on
  // something. One without is reference: doc-skill's `doc` is its spec
  // document, and routing to it sent three thousand characters of TOML
  // grammar as a question, which the page never answered at all. Twice, on
  // two profiles, at 224 seconds each.
  const runnable = incoming.filter((s) => s.hint);
  const skills = runnable.length > 0 ? runnable : incoming;
  if (skills.length === 0) return { why: "no skills installed", ms: 0 };
  if (process.env.GAHOOLE_ROUTE === "0") return { why: "routing off", ms: 0 };

  const ready = await ollamaReady(opts);
  if (!ready.ok) return { why: ready.why, ms: Date.now() - at };

  try {
    const res = await fetch(`${opts.host ?? ollamaHost()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? ollamaModel(),
        stream: false,
        // Nothing to be creative about, and a long answer is a wrong one.
        options: { temperature: 0 },
        // The answer is constrained rather than requested.
        //
        // Asked politely for one name, this model replied
        // "excel / sales.csv / region / report" — a list of keywords, and no
        // choice at all. A schema with the names as an enum cannot produce
        // that, and the reply is a name or it is nothing.
        format: {
          type: "object",
          properties: {
            skill: { type: "string", enum: [...skills.map((s) => s.name), NONE] },
          },
          required: ["skill"],
        },
        messages: [
          { role: "system", content: routingPrompt(skills) },
          { role: "user", content: request.slice(0, 600) },
        ],
      }),
      signal: AbortSignal.timeout(BUDGET_MS),
    });
    if (!res.ok) return { why: `router answered ${res.status}`, ms: Date.now() - at };

    const body = (await res.json()) as { message?: { content?: string } };
    const said = (body.message?.content ?? "").trim();
    let chosen = "";
    try {
      chosen = String((JSON.parse(said) as { skill?: unknown }).skill ?? "");
    } catch {
      // A model that ignored the schema is a model that chose nothing.
      return { why: said.slice(0, 40) || "no answer", ms: Date.now() - at };
    }

    const picked = skills.find((s) => s.name === chosen);
    if (!picked) return { why: chosen || NONE, ms: Date.now() - at };

    // Which plugin, not which command.
    const siblings = skills.filter((s) => s.plugin === picked.plugin);
    if (siblings.length === 1) return { skill: picked, ms: Date.now() - at };
    return { narrowed: siblings, ms: Date.now() - at };
  } catch (e) {
    return {
      why: e instanceof Error ? e.message.slice(0, 60) : String(e),
      ms: Date.now() - at,
    };
  }
}

/**
 * The line that goes on a question when a plugin applies but not which command.
 *
 * Narrower than the standing hint, which names every skill installed. This one
 * names two or three, with what each is for, at the moment one of them is
 * almost certainly right — which is the question the model is good at and the
 * local one is not.
 */
export function narrowedHint(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const gist = (s: Skill): string => {
    const first = (s.description.split(/[。.]\s|。/)[0] ?? "").trim();
    return first.length > 60 ? `${first.slice(0, 60)}…` : first;
  };
  const listed = skills.map((s) => `${s.name}（${gist(s)}）`).join("、");
  // Phrased so it can be declined, like the standing hint and for the same
  // reason. The local model is right about the plugin most of the time and not
  // always — measured 10 of 11, the miss being "run this repository's tests" —
  // and a line that leaves no way out turns its one mistake into the model's.
  return (
    `[${skills[0]!.plugin} が該当しそうです: ${listed}。` +
    `どれかが実際に合っていれば use_skill で選び、違えば普通に答えてください。]`
  );
}
