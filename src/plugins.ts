import fs from "node:fs";
import path from "node:path";
import { inHome, inRepo, settings } from "./paths.js";

/**
 * Plugins, in the layout Claude Code already uses.
 *
 *   <plugin>/.claude-plugin/plugin.json   name, description, author
 *   <plugin>/skills/<name>/SKILL.md       frontmatter, then the instructions
 *
 * The point of reading someone else's format rather than inventing one is
 * that the plugins already exist. A directory that works in Claude Code works
 * here without being touched, and one written for here works there.
 *
 * A skill is instructions, not code. Invoking one sends its body as the
 * question, with `$ARGUMENTS` filled in and `${CLAUDE_PLUGIN_ROOT}` pointing
 * at the plugin — so a skill that says "run ${CLAUDE_PLUGIN_ROOT}/engine/x.py"
 * resolves to a real path the tools can reach.
 *
 * `allowed-tools` names Claude Code's tools, which are not this program's.
 * They are mapped rather than ignored: a skill that asked for Read and Bash
 * gets read_file and run_command, and nothing else. Honouring the *intent* of
 * a narrower tool set matters more than honouring the spelling.
 */

export interface Skill {
  name: string;
  description: string;
  /** What the argument is for, shown in `/plugins`. */
  hint?: string;
  /** Tool names this program understands, or undefined for all of them. */
  tools?: string[];
  /** The instructions, with $ARGUMENTS and ${CLAUDE_PLUGIN_ROOT} still in. */
  body: string;
  plugin: string;
  root: string;
}

export interface Plugin {
  name: string;
  description: string;
  root: string;
  skills: Skill[];
}

/**
 * Claude Code's tool names, mapped to this program's.
 *
 * Where there is no equivalent the entry is omitted rather than guessed at:
 * a skill asking for WebFetch does not get run_command as a substitute.
 */
const TOOL_NAMES: Record<string, string[]> = {
  Read: ["read_file"],
  Write: ["write_file"],
  Edit: ["edit_file", "write_file"],
  Bash: ["run_command"],
  Glob: ["list_files"],
  Grep: ["search_files"],
  LS: ["list_files"],
  Task: ["spawn_agent"],
};

/** Directories searched, nearest first. */
function sources(): string[] {
  const configured = (settings() as { plugins?: string[] }).plugins ?? [];
  return [
    ...configured.map((p) => path.resolve(p.replace(/^~(?=\/)/, process.env.HOME ?? "~"))),
    inRepo("plugins"),
    inHome("plugins"),
  ];
}

function readFrontmatter(text: string): {
  fields: Record<string, string>;
  body: string;
} {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    // Quotes are decoration in this format, not delimiters.
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  return { fields, body: text.slice(m[0].length).trim() };
}

/** `[Bash, Read]` or `Bash, Read` — both are written in the wild. */
function toolList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const names = raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return undefined;
  const mapped = new Set<string>();
  for (const n of names) for (const t of TOOL_NAMES[n] ?? []) mapped.add(t);
  return [...mapped];
}

/**
 * Directory entries, following symlinks.
 *
 * `isDirectory()` is false for a symlink that points at one, and a symlink is
 * how a plugin under development gets installed — linking the checkout beats
 * copying it every time it changes.
 */
function dirsIn(where: string): string[] {
  try {
    return fs
      .readdirSync(where, { withFileTypes: true })
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(where, e.name)).isDirectory();
        } catch {
          return false; // a link pointing at nothing
        }
      })
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readPlugin(root: string): Plugin | undefined {
  let manifest: { name?: string; description?: string } = {};
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8"),
    ) as typeof manifest;
  } catch {
    // A directory of skills with no manifest is still a plugin; name it after
    // the directory rather than refusing it.
  }
  const name = manifest.name ?? path.basename(root);

  const skillsDir = path.join(root, "skills");
  const entries = dirsIn(skillsDir);
  if (entries.length === 0) return undefined;

  const skills: Skill[] = [];
  for (const dir of entries) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(skillsDir, dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const { fields, body } = readFrontmatter(text);
    if (!body) continue;
    skills.push({
      name: fields.name ?? dir,
      description: fields.description ?? "",
      hint: fields["argument-hint"],
      tools: toolList(fields["allowed-tools"]),
      body,
      plugin: name,
      root,
    });
  }
  if (skills.length === 0) return undefined;
  return { name, description: manifest.description ?? "", root, skills };
}

export function loadPlugins(): Plugin[] {
  const found: Plugin[] = [];
  const seen = new Set<string>();

  for (const source of sources()) {
    // A source is either a plugin itself, or a directory of them.
    const direct = readPlugin(source);
    const roots = direct
      ? [source]
      : dirsIn(source).map((name) => path.join(source, name));

    for (const root of roots) {
      if (seen.has(root)) continue;
      const plugin = direct && root === source ? direct : readPlugin(root);
      if (!plugin) continue;
      seen.add(root);
      found.push(plugin);
    }
  }
  return found;
}

export const allSkills = (plugins: Plugin[]): Skill[] =>
  plugins.flatMap((p) => p.skills);

export function findSkill(plugins: Plugin[], name: string): Skill | undefined {
  const want = name.trim().toLowerCase().replace(/^\//, "");
  return allSkills(plugins).find((s) => s.name.toLowerCase() === want);
}

/**
 * The prompt a skill becomes.
 *
 * The body is the instructions verbatim — a skill is written to be read by a
 * model, so rewording it here would be second-guessing its author.
 */
export function skillPrompt(skill: Skill, args: string): string {
  return skill.body
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", skill.root)
    .replaceAll("$CLAUDE_PLUGIN_ROOT", skill.root)
    .replaceAll("$ARGUMENTS", args)
    .replaceAll("${ARGUMENTS}", args);
}

/**
 * A tool that hands the model a skill's instructions.
 *
 * Asked "what plugins can you use", the model listed its tools — it had no
 * way to know skills existed, because a skill was only reachable by the
 * person typing its name. This makes them reachable from a question.
 *
 * The result is the instructions themselves, so the model reads them and
 * carries them out in the same turn with the tools it already has. That is
 * what a skill is: something to follow, not something to call.
 */
export function createSkillTool(
  plugins: Plugin[],
  createTool: typeof import("@mastra/core/tools").createTool,
  z: typeof import("zod").z,
  /** Told which skill was chosen, so the caller can run it to completion. */
  onSelect?: (skill: Skill, args: string) => void,
) {
  const skills = allSkills(plugins);
  if (skills.length === 0) return undefined;

  // Short on purpose.
  //
  // It was three hundred characters of skill descriptions, on the theory that
  // the model needed to know what each one was for. It did not help — what
  // made it reach for a skill was the line in the reminder — and it did harm:
  // with the long description in the tool list, turns came back with tool
  // calls and no words at all, and the same question with no plugins loaded
  // answered normally. The preamble has a budget nobody wrote down, and this
  // was spending it.
  const names = skills.map((s) => s.name).join(", ");

  return createTool({
    id: "use_skill",
    description: `Load and follow an installed skill: ${names}.`,
    inputSchema: z.object({
      name: z.string().describe("Which skill"),
      args: z.string().optional().describe("What the skill should work on"),
    }),
    outputSchema: z.object({ skill: z.string(), note: z.string() }),
    execute: async (input: { name: string; args?: unknown }) => {
      const skill = findSkill(plugins, input.name);
      if (!skill) {
        throw new Error(
          `no skill called ${input.name}. There is: ${skills.map((s) => s.name).join(", ")}`,
        );
      }
      // Models pass an object here about as often as a string, and refusing
      // one of the two shapes costs a round to no purpose.
      const args =
        typeof input.args === "string"
          ? input.args
          : input.args
            ? JSON.stringify(input.args)
            : "";
      // The instructions are not returned here.
      //
      // They were, and the turn read them as reference material rather than
      // as a task: measured runs stopped after two calls, then six, then
      // thirteen, having written the spec and never built anything. Choosing
      // a skill and carrying one out are different jobs, so they are done by
      // different things — this call is the choice, and the caller runs the
      // steps afterwards with the loop that exists for work that has to
      // finish.
      onSelect?.(skill, args);
      return {
        skill: skill.name,
        note:
          `Selected. Its steps will be carried out next — stop here rather ` +
          `than starting them yourself.`,
      };
    },
  });
}

/**
 * The line that rides on every question when skills are installed.
 *
 * The tool description was not enough. Asked twice for a spreadsheet from a
 * CSV, with `use_skill` in the preamble and the skills named and described,
 * the model wrote its own pandas both times — "Excel にして" has a strong
 * prior and one line in a two-thousand-character preamble does not beat it.
 * The reminder is restated with every question and is a fifth the length, so
 * a line here carries far more weight.
 */
export function skillsHint(plugins: Plugin[]): string {
  const skills = allSkills(plugins);
  if (skills.length === 0) return "";
  const names = skills.map((s) => s.name).join(", ");
  // Phrased as an option, not a prohibition.
  //
  // It read "do not write your own program to do it", and a model that had
  // already started reading the file was being told its next step was wrong
  // without being given one it could take instead. Measured: with the plugins
  // loaded the turn came back with tool calls and no words at all; with the
  // same question and no plugins, it answered normally. An instruction that
  // forbids the path you are on and names no other produces silence.
  return (
    `[Skills available: ${names}. If one of them already does what is being asked, ` +
    `use_skill is the shorter way. Otherwise answer as you normally would.]`
  );
}

export function renderPlugins(plugins: Plugin[], color = true): string {
  if (plugins.length === 0) {
    return "  (no plugins — put one in ~/.gahoole/plugins/, or name it in settings.json)";
  }
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const out: string[] = [];
  for (const p of plugins) {
    out.push(`  ${bold(p.name)} ${dim(p.root)}`);
    for (const s of p.skills) {
      out.push(`    /${s.name}${s.hint ? ` ${dim(s.hint)}` : ""}`);
      if (s.description) out.push(`      ${dim(s.description.slice(0, 100))}`);
    }
  }
  return out.join("\n");
}
