/**
 * Where things are kept, and what is read from where.
 *
 * Every one of these decides whether a person's sessions can be found again,
 * so they are worth checking directly rather than through the CLI: the slug,
 * the precedence between global and committed settings, and the one-shot move
 * out of the directory this used to use.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-paths-"));
process.env.GAHOOLE_HOME = HOME;

// After the environment is set: paths.ts resolves the home once, at import.
const paths = await import("./paths.js");
const { HOME_DIR, inHome, inProject, inRepo, migrate, projectDir, slugFor, settings, projectInstructions } =
  paths;

const enter = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  return fs.realpathSync(dir);
};

try {
  // --- the home ---------------------------------------------------------------
  assert.equal(HOME_DIR, HOME, "GAHOOLE_HOME wins");
  assert.equal(inHome("trusted.json"), path.join(HOME, "trusted.json"));

  // --- the slug ---------------------------------------------------------------
  //
  // A directory name for a working directory: unambiguous, reversible by eye,
  // and different for two checkouts of the same repository, which is the point
  // — they are different work.
  //
  // Spelled out per platform rather than built from path.resolve, which would
  // be the function again rather than a test of it. An absolute POSIX path is
  // not absolute on Windows — path.resolve puts the drive in front of it, and
  // asserting the POSIX answer there was testing the operating system.
  if (path.sep === "/") {
    assert.equal(slugFor("/Users/x/work/proj"), "-Users-x-work-proj");
    assert.equal(
      slugFor("/Users/x/.superset/projects/googleai"),
      "-Users-x--superset-projects-googleai",
      "a dotted directory becomes a second dash, as ~/.claude/projects does it",
    );
  } else {
    assert.equal(slugFor("C:\\Users\\x\\work\\proj"), "C--Users-x-work-proj");
    assert.equal(
      slugFor("C:\\Users\\x\\.superset\\googleai"),
      "C--Users-x--superset-googleai",
      "the drive letter's colon goes the same way as a separator",
    );
    assert.notEqual(
      slugFor("C:\\work\\proj"),
      slugFor("D:\\work\\proj"),
      "and two drives are two places",
    );
  }
  const here = path.resolve("proj");
  const there = path.resolve("..", "elsewhere", "proj");
  assert.notEqual(slugFor(here), slugFor(there), "two checkouts stay apart");
  assert.equal(slugFor("relative"), slugFor(path.resolve("relative")), "always absolute");
  for (const ch of ["/", "\\", ":", "."]) {
    assert.ok(!slugFor(here).includes(ch), `and never a path itself (${ch})`);
  }

  // --- one directory per project ---------------------------------------------
  {
    const a = enter(path.join(HOME, "work", "alpha"));
    const first = projectDir();
    assert.equal(first, path.join(HOME, "projects", slugFor(a)));
    assert.equal(inProject("gahoole.db"), path.join(first, "gahoole.db"));

    const b = enter(path.join(HOME, "work", "beta"));
    assert.notEqual(projectDir(), first, "a different project, a different directory");

    // The repository's own directory is beside the code, and is only for what
    // the repository chose to commit.
    assert.equal(inRepo("settings.json"), path.resolve(".gahoole", "settings.json"));
    assert.ok(inRepo("x").startsWith(fs.realpathSync(b)), "which is the working tree");
  }

  // --- settings: global, then what the repository committed -------------------
  {
    const dir = enter(path.join(HOME, "work", "settings-test"));
    void dir;
    fs.writeFileSync(
      inHome("settings.json"),
      JSON.stringify({ profile: "pythia", approve: "deny", maxSteps: 5 }),
    );
    assert.deepEqual(settings(), { profile: "pythia", approve: "deny", maxSteps: 5 });

    fs.mkdirSync(".gahoole", { recursive: true });
    fs.writeFileSync(inRepo("settings.json"), JSON.stringify({ profile: "argus" }));
    assert.deepEqual(
      settings(),
      { profile: "argus", approve: "deny", maxSteps: 5 },
      "the project overrides one key and inherits the rest",
    );

    // Broken JSON is not a reason to refuse to start.
    fs.writeFileSync(inRepo("settings.json"), "{ not json");
    assert.equal(settings().profile, "pythia", "an unreadable file falls back");
    fs.rmSync(".gahoole", { recursive: true, force: true });
    fs.rmSync(inHome("settings.json"));
    assert.deepEqual(settings(), {}, "no settings anywhere is not an error");
  }

  // --- GAHOOLE.md -------------------------------------------------------------
  {
    enter(path.join(HOME, "work", "instructions"));
    assert.equal(projectInstructions(), "", "not there is the ordinary case");

    fs.writeFileSync("GAHOOLE.md", "  出力は必ず日本語で。  \n");
    assert.equal(projectInstructions(), "出力は必ず日本語で。", "read and trimmed");

    fs.writeFileSync("GAHOOLE.md", "   \n\n  ");
    assert.equal(projectInstructions(), "", "whitespace is nothing");

    fs.rmSync("GAHOOLE.md");
    fs.mkdirSync(".gahoole", { recursive: true });
    fs.writeFileSync(path.join(".gahoole", "GAHOOLE.md"), "inside the folder");
    assert.equal(projectInstructions(), "inside the folder", "either place works");
  }

  // --- the move out of data/ --------------------------------------------------
  {
    const work = enter(path.join(HOME, "work", "legacy"));
    void work;
    fs.mkdirSync(path.join("data", "notes"), { recursive: true });
    fs.writeFileSync(path.join("data", "notes", "old.md"), "from before");
    fs.writeFileSync(path.join("data", "gahoole.db"), "pretend");

    const said = migrate();
    assert.match(said ?? "", /moved data\/ into/, `it says what it did: ${said}`);
    assert.ok(!fs.existsSync("data"), "the old directory is gone");
    assert.equal(
      fs.readFileSync(path.join(projectDir(), "notes", "old.md"), "utf8"),
      "from before",
      "with everything in it, not a chosen subset",
    );
    assert.ok(fs.existsSync(path.join(projectDir(), "gahoole.db")));

    assert.equal(migrate(), undefined, "and it does not happen twice");
  }

  // --- nothing to move --------------------------------------------------------
  {
    enter(path.join(HOME, "work", "fresh"));
    assert.equal(migrate(), undefined, "a project with no data/ is left alone");

    // A .gahoole holding only committed settings is not state to move — moving
    // it would take the repository's settings out of the repository.
    fs.mkdirSync(".gahoole", { recursive: true });
    fs.writeFileSync(inRepo("settings.json"), "{}");
    assert.equal(migrate(), undefined, "committed settings stay where they are");
    assert.ok(fs.existsSync(inRepo("settings.json")));
  }

  // --- where the conversation is kept ------------------------------------------
//
// One file per project, under ~/.gahoole, not in the project. A repo should
// not gain an untracked database because a session was run in it.
{
  const { DB_URL, MODEL } = await import("./agent.js");
  assert.ok(DB_URL.startsWith("file:"), "a file, not a server");
  assert.ok(!DB_URL.includes(`file:${process.cwd()}/`), "and not in the project");
  assert.match(MODEL, /^[a-z]+\//, "provider-qualified, the way the router wants it");
}

console.log("ok — paths: slug, one directory per project, settings precedence, migration");
} finally {
  process.chdir(os.tmpdir());
  fs.rmSync(HOME, { recursive: true, force: true });
}
process.exit(0);
