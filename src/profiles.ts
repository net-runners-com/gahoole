/**
 * Profiles: the same model, told to work differently.
 *
 * Claude Code switches between Haiku and Opus. There is nothing to switch to
 * here — AI Mode is one model behind a browser — so a profile changes the two
 * things that are actually ours to change: what the model is told, and what it
 * is allowed to reach for.
 *
 * The second half is the part that does the work. A brief that says "do not
 * write files" is a suggestion; a tool set with no `write_file` in it is not.
 * So `reason` genuinely cannot act, and `research` genuinely cannot change
 * anything — which is also what makes them safe to leave running.
 *
 * Do not confuse this with the browser profiles the AI Mode backend rotates
 * through when it hits the rate limit. Those are Chromium user-data
 * directories and nothing here touches them.
 */

export interface Profile {
  name: string;
  /** One line, for the `/profile` list. */
  summary: string;
  /**
   * Sent once, with the tool preamble, when the profile becomes active.
   * Long-form: this is the only place there is room to explain.
   */
  brief: string;
  /**
   * Restated with every question. AI Mode forgets instructions from earlier
   * turns far more readily than it forgets the question in front of it, so
   * whatever must hold for the whole session goes here — in one line, because
   * the preamble wording is fragile and a long restatement crowds the question.
   */
  hint: string;
  /** Which tools this profile may use. */
  tools: "all" | "none" | { deny: string[] };
  /** Tool rounds per turn. Each one is a query against the rate limit. */
  rounds: number;
  /** Default ceiling for an autonomous run under this profile. */
  steps: number;
}

/** Everything that changes a file, runs a program, or deletes something. */
const WRITES = ["write_file", "edit_file", "delete_file", "run_command"];

export const PROFILES: Profile[] = [
  {
    name: "general",
    summary: "balanced — every tool, no particular slant",
    brief: "",
    hint: "",
    tools: "all",
    rounds: 4,
    steps: 100,
  },
  {
    name: "reason",
    summary: "推論 — think it through, no tools at all",
    brief: [
      "For this session, work problems out rather than looking things up.",
      "",
      "Set out the steps in order, each one following from the last, and put the",
      "final answer on its own line at the end. If the answer is a number, give",
      "the number. If the question contains everything needed to answer it, do",
      "not search the web — use what is in front of you.",
      "",
      "If a question cannot be answered from what you were given, say what is",
      "missing rather than guessing at it.",
    ].join("\n"),
    hint: "[Reason it through step by step, then give the answer on its own line. Do not search the web.]",
    tools: "none",
    rounds: 1,
    steps: 3,
  },
  {
    name: "build",
    summary: "実装 — write it, run it, check it ran",
    brief: [
      "For this session, finish things rather than propose them.",
      "",
      "Write the file, then run it, then read what it printed. A change you have",
      "not run is not a change you have checked, and an output you have not read",
      "is not an output you know. If a step fails, read the error and fix it —",
      "that is the work, not an interruption to it.",
      "",
      "Do not stop to ask permission for steps the task already implies, and do",
      "not end a turn with a description of what you are about to do.",
    ].join("\n"),
    hint: "[Do it with tools, then run it and read the output. Do not describe work you have not done.]",
    tools: "all",
    rounds: 8,
    steps: 100,
  },
  {
    name: "research",
    summary: "調査 — read and search only, nothing is changed",
    brief: [
      "For this session, find out and report. You can read, list and search",
      "files, and you cannot change or run anything — that is deliberate, so",
      "read widely without worrying about what you might disturb.",
      "",
      "Look before concluding. When you state something about the code, give the",
      "file and line it came from. When you have looked at part of a question and",
      "not the rest, say which part — an answer that hides its gaps is worse than",
      "one that names them.",
      "",
      "Delegate the wide reading to a subagent when there is a lot of it: it can",
      "read twenty files and report three sentences.",
    ].join("\n"),
    hint: "[Read and search before answering, and cite file:line. Say what you did not check.]",
    tools: { deny: WRITES },
    rounds: 6,
    steps: 40,
  },
];

export const DEFAULT_PROFILE = "general";

export function findProfile(name: string): Profile | undefined {
  const want = name.trim().toLowerCase();
  return PROFILES.find((p) => p.name === want);
}

export const profileNames = (): string[] => PROFILES.map((p) => p.name);

/** The tools a profile leaves on the table, out of everything available. */
export function toolsFor(
  profile: Profile,
  all: Record<string, unknown>,
): Record<string, unknown> {
  if (profile.tools === "none") return {};
  if (profile.tools === "all") return { ...all };
  const denied = new Set(profile.tools.deny);
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => !denied.has(name)),
  );
}

/** `/profile` with no argument, and the `--help` text. */
export function renderProfiles(current: string, color = true): string {
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  return PROFILES.map((p) => {
    const here = p.name === current;
    const tools =
      p.tools === "none"
        ? "no tools"
        : p.tools === "all"
          ? "all tools"
          : `no ${p.tools.deny.join(", ")}`;
    return (
      `  ${here ? "›" : " "} ${here ? bold(p.name.padEnd(9)) : p.name.padEnd(9)}` +
      ` ${p.summary}\n              ${dim(`${tools} · ${p.rounds} tool round${p.rounds === 1 ? "" : "s"} · up to ${p.steps} autonomous steps`)}`
    );
  }).join("\n");
}
