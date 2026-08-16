import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where gahoole keeps things, in the shape Claude Code uses.
 *
 *   ~/.gahoole/
 *     trusted.json                    folders you have said yes to
 *     settings.json                   defaults everywhere
 *     projects/<slug>/                one directory per project you work in
 *       gahoole.db                    messages, threads, traces
 *       events.jsonl                  the lifecycle audit log
 *       memory/                       what earlier sessions established
 *       handoff/                      a conversation cut short, waiting
 *       notes/                        the agent's own scratch space
 *       trash/                        deleted files, recoverable
 *       browser-profile-N/            Chromium user data, one per rotation
 *
 *   <project>/.gahoole/settings.json  committed settings, if the repo wants any
 *   <project>/GAHOOLE.md              instructions for this project
 *
 * The state lives under the home directory, not beside the code. A repository
 * is something you clone, share and gitignore; a browser profile and a
 * database of your conversations are none of those things, and putting them in
 * the working tree means every project you touch grows a directory you then
 * have to remember to ignore. The slug is the project's absolute path with the
 * separators flattened, which is how `~/.claude/projects` does it and means
 * two checkouts of the same repository keep their own histories.
 *
 * What stays in the repository is what belongs to the repository: GAHOOLE.md,
 * and settings someone chose to commit.
 *
 * `data/`, and briefly `<project>/.gahoole/`, are where the state used to live.
 * A directory full of somebody's sessions is not something to abandon in
 * place, so `migrate()` moves it across on first run and says so.
 */

export const HOME_DIR = process.env.GAHOOLE_HOME
  ? path.resolve(process.env.GAHOOLE_HOME)
  : path.join(os.homedir(), ".gahoole");

export const inHome = (...parts: string[]): string => path.join(HOME_DIR, ...parts);

/**
 * A directory name for a working directory.
 *
 * The absolute path with its separators flattened, the way
 * `~/.claude/projects` does it: unambiguous, reversible by eye, and different
 * for two checkouts of the same repository — which is the point, since they
 * are different work.
 */
export function slugFor(dir: string): string {
  return path.resolve(dir).replace(/[/\\.:]/g, "-");
}

/** Overridable so tests, and anyone with an opinion, can put it elsewhere. */
export const projectDir = (): string =>
  process.env.GAHOOLE_DIR
    ? path.resolve(process.env.GAHOOLE_DIR)
    : inHome("projects", slugFor(process.cwd()));

export const inProject = (...parts: string[]): string =>
  path.join(projectDir(), ...parts);

/** Settings a repository chose to commit, and where GAHOOLE.md may also live. */
export const inRepo = (...parts: string[]): string =>
  path.resolve(".gahoole", ...parts);

/**
 * Where the state used to live, in the order it lived there. Resolved when
 * asked rather than when this module loads: everything else here reads
 * `process.cwd()` at call time, and one constant that does not is a constant
 * that is right until something changes directory.
 */
const legacy = (): string[] => [path.resolve("data"), path.resolve(".gahoole")];

/**
 * Move a `data/` directory from before the rename, once.
 *
 * Everything, not a chosen subset: a half-migrated state where the database
 * moved and the browser profile did not is worse than either whole one.
 * Returns what it did so the caller can say so — a directory quietly moving
 * underneath someone is how trust in a tool goes.
 */
export function migrate(): string | undefined {
  const to = projectDir();
  if (fs.existsSync(to)) return undefined;

  const from = legacy().find(
    (d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f !== "settings.json"),
  );
  if (!from) return undefined;

  const name = path.basename(from);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return `moved ${name}/ into ${HOME_DIR}/projects/`;
  } catch (e) {
    // A rename across devices fails, and the home directory is often on a
    // different one. Copying is the fallback; leaving the original where it
    // is beats a half-moved state.
    try {
      fs.cpSync(from, to, { recursive: true });
      return `copied ${name}/ into ${HOME_DIR}/projects/ — the original is still there`;
    } catch {
      return `could not move ${name}/: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

export interface Settings {
  /** Profile to start in; --profile still wins. */
  profile?: string;
  /** ask | allow | deny; --allow still wins. */
  approve?: string;
  /** Extra executables run_command may reach. */
  commands?: string[];
  /** Turns an autonomous run may spend. */
  maxSteps?: number;
}

function readJson(file: string): Settings {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Settings) : {};
  } catch {
    return {};
  }
}

/**
 * Global settings, then this project's on top. The project wins because it is
 * the more specific statement, which is the same rule Claude Code follows and
 * the one people already expect.
 */
export function settings(): Settings {
  return {
    ...readJson(inHome("settings.json")),
    ...readJson(inRepo("settings.json")),
  };
}

/** `GAHOOLE.md`, if this project has one. */
export function projectInstructions(): string {
  for (const name of ["GAHOOLE.md", ".gahoole/GAHOOLE.md"]) {
    const f = path.resolve(name);
    try {
      const text = fs.readFileSync(f, "utf8").trim();
      if (text) return text;
    } catch {
      // Not there, which is the ordinary case.
    }
  }
  return "";
}
