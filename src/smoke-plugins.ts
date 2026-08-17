/**
 * Plugins, against directories built here.
 *
 * The whole subsystem had no test: it was written against one real plugin on
 * this machine and verified by running it. That verifies the happy path and
 * nothing else — not the manifest that is missing, not the symlinked
 * checkout, not the skill whose `allowed-tools` names tools this program does
 * not have.
 *
 * Every fixture below is a real directory in a temporary place, because what
 * is under test is reading the filesystem.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-plugins-"));

/** ~/.gahoole and the repo both feed the search; point them somewhere empty. */
const home = path.join(tmp, "home");
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.GAHOOLE_HOME = path.join(home, ".gahoole");

const settingsPath = path.join(home, ".gahoole", "settings.json");
const configured = path.join(tmp, "configured");
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ plugins: [configured] }));

function skill(root: string, dir: string, frontmatter: string, body: string): void {
  const at = path.join(root, "skills", dir);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

function manifest(root: string, json: unknown): void {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(json));
}

// A plugin in the shape Claude Code writes them.
const alpha = path.join(configured, "alpha");
manifest(alpha, { name: "alpha", description: "the first one" });
skill(
  alpha,
  "build",
  [
    "name: build",
    'description: "doc.toml から XLSX を組み立てる。"',
    "argument-hint: <spec> <format>",
    "allowed-tools: [Read, Bash]",
  ].join("\n"),
  "run ${CLAUDE_PLUGIN_ROOT}/engine/build.py on $ARGUMENTS",
);
// A second skill, with no frontmatter at all.
skill(alpha, "notes", "", "Write down what happened.");

// A plugin with no manifest — a directory of skills is still a plugin.
const beta = path.join(configured, "beta");
skill(beta, "review", "name: review\ndescription: 読んで指摘する。", "Read it, then say what is wrong.");

// Not a plugin: no skills directory.
fs.mkdirSync(path.join(configured, "empty"), { recursive: true });
// Not a plugin: a skills directory with nothing readable in it.
fs.mkdirSync(path.join(configured, "hollow", "skills", "nothing"), { recursive: true });

const { loadPlugins, allSkills, findSkill, skillPrompt, skillsHint, renderPlugins, createSkillTool } =
  await import("./plugins.js");

// --- what is found ----------------------------------------------------------
{
  const plugins = loadPlugins();
  const names = plugins.map((p) => p.name).sort();
  assert.deepEqual(names, ["alpha", "beta"], "two plugins, and neither empty directory");

  const a = plugins.find((p) => p.name === "alpha")!;
  assert.equal(a.description, "the first one", "from the manifest");
  assert.equal(a.skills.length, 2);

  const b = plugins.find((p) => p.name === "beta")!;
  assert.equal(b.description, "", "no manifest is not an error");
  assert.equal(b.name, "beta", "named after its directory");
}

// --- the frontmatter --------------------------------------------------------
{
  const skills = allSkills(loadPlugins());
  const build = skills.find((s) => s.name === "build")!;
  assert.equal(build.description, "doc.toml から XLSX を組み立てる。", "quotes are decoration");
  assert.equal(build.hint, "<spec> <format>");
  // Claude Code's tool names, mapped to this program's.
  assert.deepEqual(build.tools?.sort(), ["read_file", "run_command"]);

  const notes = skills.find((s) => s.name === "notes")!;
  assert.equal(notes.description, "", "no frontmatter is not an error");
  assert.equal(notes.tools, undefined, "and means every tool");
  assert.equal(notes.body, "Write down what happened.");
}

// --- finding one by name ----------------------------------------------------
{
  const plugins = loadPlugins();
  assert.equal(findSkill(plugins, "build")?.name, "build");
  assert.equal(findSkill(plugins, "/build")?.name, "build", "typed as a command");
  assert.equal(findSkill(plugins, "  BUILD ")?.name, "build");
  assert.equal(findSkill(plugins, "nothing"), undefined);
}

// --- what a skill becomes ---------------------------------------------------
{
  const build = findSkill(loadPlugins(), "build")!;
  const prompt = skillPrompt(build, "doc.toml xlsx");
  assert.ok(prompt.includes(`${alpha}/engine/build.py`), "the root is a real path");
  assert.ok(prompt.includes("on doc.toml xlsx"));
  assert.ok(!prompt.includes("$ARGUMENTS"));
  assert.ok(!prompt.includes("CLAUDE_PLUGIN_ROOT"));

  // Both spellings of both, because both are written in the wild.
  const either = skillPrompt(
    { ...build, body: "$CLAUDE_PLUGIN_ROOT and ${ARGUMENTS}" },
    "x",
  );
  assert.equal(either, `${alpha} and x`);
}

// --- the line that rides on every question ----------------------------------
{
  const hint = skillsHint(loadPlugins());
  assert.ok(hint.includes("build"));
  assert.ok(hint.includes("review"));
  // Phrased as an option: an instruction that forbids the path you are on and
  // names no other produced turns with tool calls and no words at all.
  assert.ok(/Otherwise answer as you normally would/.test(hint));
  assert.equal(skillsHint([]), "", "and nothing at all when none are installed");
}

// --- choosing one from a question -------------------------------------------
{
  const { createTool } = await import("@mastra/core/tools");
  const { z } = await import("zod");
  const plugins = loadPlugins();

  const chosen: { name: string; args: string }[] = [];
  const tool = createSkillTool(plugins, createTool, z, (s, args) =>
    chosen.push({ name: s.name, args }),
  )!;
  assert.ok(tool, "there are skills, so there is a tool");
  assert.ok(/build/.test(tool.description), "and it says what they are for");

  const exec = tool.execute as unknown as (i: {
    name: string;
    args?: unknown;
  }) => Promise<{ skill: string }>;
  assert.equal((await exec({ name: "build", args: "doc.toml" })).skill, "build");
  assert.deepEqual(chosen, [{ name: "build", args: "doc.toml" }]);

  // Models pass an object about as often as a string, and the schema has to
  // allow it: `execute` is not reached when validation fails, so the branch
  // that handled an object was unreachable and the skill was never selected.
  await exec({ name: "build", args: { spec: "doc.toml" } });
  assert.equal(chosen[1]?.args, '{"spec":"doc.toml"}');
  await exec({ name: "build" });
  assert.equal(chosen[2]?.args, "");

  // The instructions are not returned — choosing and carrying out are
  // different jobs, and returning them made the turn read them as reference.
  const said = await exec({ name: "build", args: "x" });
  assert.ok(!JSON.stringify(said).includes("build.py"));

  await assert.rejects(() => exec({ name: "nope" }), /no skill called nope/);
  assert.equal(createSkillTool([], createTool, z), undefined, "and no skills, no tool");
}

// --- shown to a person -------------------------------------------------------
{
  const plain = renderPlugins(loadPlugins(), false);
  assert.ok(plain.includes("/build <spec> <format>"));
  assert.ok(plain.includes(alpha), "where it came from, for when it is the wrong one");
  assert.ok(!plain.includes("\x1b["), "no colour when it was not asked for");
  assert.ok(renderPlugins(loadPlugins(), true).includes("\x1b["));
  assert.match(renderPlugins([], false), /no plugins/);
}

// --- a symlinked checkout ----------------------------------------------------
//
// How a plugin under development is installed: linking the checkout beats
// copying it every time it changes. `isDirectory()` is false for a symlink
// that points at one, so this was invisible.
{
  const real = path.join(tmp, "elsewhere", "gamma");
  manifest(real, { name: "gamma" });
  skill(real, "poke", "name: poke\ndescription: つつく。", "Poke it.");
  fs.symlinkSync(real, path.join(configured, "gamma"));
  // And one pointing at nothing, which must not throw.
  fs.symlinkSync(path.join(tmp, "gone"), path.join(configured, "dangling"));

  const names = loadPlugins().map((p) => p.name).sort();
  assert.deepEqual(names, ["alpha", "beta", "gamma"]);
}

// --- a source that is itself a plugin ----------------------------------------
//
// Pointing settings.json at a checkout rather than at a directory of them is
// the obvious thing to do, and it is what the doc-skill plugin needed.
{
  fs.writeFileSync(settingsPath, JSON.stringify({ plugins: [alpha] }));
  const plugins = loadPlugins();
  assert.deepEqual(plugins.map((p) => p.name), ["alpha"]);
  assert.equal(plugins[0]?.skills.length, 2);
  fs.writeFileSync(settingsPath, JSON.stringify({ plugins: [configured] }));
}

// --- no plugins at all -------------------------------------------------------
{
  fs.writeFileSync(settingsPath, JSON.stringify({}));
  assert.deepEqual(loadPlugins(), [], "the ordinary case, and not an error");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("ok — plugins: manifests, frontmatter, tool mapping, symlinks, skill tool");
process.exit(0);
