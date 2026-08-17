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
 * So `pythia` genuinely cannot act, and `argus` genuinely cannot change
 * anything — which is also what makes them safe to leave running.
 *
 * The names are not decoration; each one is the constraint.
 *
 *   athena    wisdom, and the owl this program is named after. The balanced
 *             default, good at both counsel and craft.
 *   pythia    the oracle at Delphi. She answers and does nothing else — which
 *             is exactly a profile with no tools.
 *   daedalus  the craftsman who built the labyrinth and the wings. He made
 *             things and found out the hard way which of them flew.
 *   argus     Panoptes, the hundred-eyed watchman. All eyes, no hands: he sees
 *             everything and changes nothing, which is read-only.
 *
 * The old plain names (general, reason, build, research) still resolve, so
 * neither muscle memory nor a script has to be retrained.
 *
 * Do not confuse any of this with the browser profiles the AI Mode backend
 * rotates through when it hits the rate limit. Those are Chromium user-data
 * directories and nothing here touches them.
 */

export interface Profile {
  name: string;
  /** What it used to be called, and what it plainly is. Both still work. */
  aliases: string[];
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
  /**
   * Nothing is carried in: no notes from earlier sessions, no GAHOOLE.md, no
   * handoff, and not this conversation either. Switching to a sealed profile
   * opens a new session, because context cannot be taken back out of one.
   */
  sealed?: boolean;
}

/** Everything that changes a file, runs a program, or deletes something. */
const WRITES = ["write_file", "edit_file", "delete_file", "run_command"];

export const PROFILES: Profile[] = [
  {
    name: "athena",
    aliases: ["general", "default"],
    summary: "均衡 — wisdom and the owl; every tool, no particular slant",
    brief: "",
    hint: "",
    tools: "all",
    rounds: 4,
    steps: 100,
  },
  {
    name: "pythia",
    aliases: ["reason", "oracle"],
    summary: "推論 — the oracle speaks and does nothing else; no tools at all",
    brief: [
      "For this session you have no tools at all. You cannot read a file, run a",
      "program, or start an interpreter. Nothing you describe doing will happen.",
      "",
      // Said plainly because the omission was measured: asked to count files
      // and write the number down, this profile announced it would "use a
      // Python interpreter to count them" and then stopped. It had no tools
      // and had never been told so — a profile with an empty tool set gets no
      // tool preamble, so the only place its situation can be stated is here.
      "So: work problems out rather than looking things up. Set out the steps in",
      "order, each one following from the last, and put the final answer on its",
      "own line at the end. If the answer is a number, give the number. Do not",
      "search the web — use what is in front of you.",
      "",
      "If part of what is asked needs a tool, say which part and that you cannot",
      "do it, and answer the rest. Never describe using something you do not",
      "have.",
    ].join("\n"),
    hint: "[No tools this session — reason it out and answer. If something needs a tool, say so plainly instead of describing it. Do not search the web.]",
    tools: "none",
    rounds: 1,
    steps: 3,
  },
  {
    name: "daedalus",
    aliases: ["build", "make"],
    summary: "実装 — the craftsman; write it, run it, read what it printed",
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
    name: "themis",
    aliases: ["review", "judge"],
    summary: "審査 — a stranger to this project; reads the work, not the story",
    brief: [
      "You are reviewing work you have never seen before, for someone who has",
      "not told you anything about it. Nothing has been carried in: no notes",
      "from earlier sessions, no project instructions, no history. That is",
      "deliberate. What you are worth here is exactly that you do not already",
      "believe what everyone involved believes.",
      "",
      "So judge the thing in front of you and not the account of it. Read the",
      "code, the tests and the documents; where they disagree, the code is what",
      "is true and the disagreement is itself a finding. A comment claiming a",
      "measurement, a README describing a feature, a test named for something",
      "it does not check — go and look.",
      "",
      "Say what is wrong before what is good, be specific enough that someone",
      "can act on it — file and line — and separate what you verified from what",
      "you suspect. If you did not check something that matters, say which.",
      "Do not soften a finding to be agreeable, and do not invent one to seem",
      "thorough.",
    ].join("\n"),
    hint: "[You are a stranger to this project. Judge what is in the files, cite file:line, and say what you did not check.]",
    tools: { deny: WRITES },
    rounds: 8,
    steps: 40,
    sealed: true,
  },
  {
    name: "argus",
    aliases: ["research", "read"],
    summary: "調査 — a hundred eyes and no hands; reads, never changes",
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

export const DEFAULT_PROFILE = "athena";

export function findProfile(name: string): Profile | undefined {
  const want = name.trim().toLowerCase();
  return PROFILES.find((p) => p.name === want || p.aliases.includes(want));
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
