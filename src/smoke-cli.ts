/**
 * The CLI, driven end to end.
 *
 * `cli.ts` is the largest file in the project and had no test at all, because
 * testing it meant a browser, a key and a person at a keyboard. It needs none
 * of those now: `GAHOOLE_BACKEND=stub` answers from a script, so a run is a
 * subprocess with lines on its stdin and text on its stdout.
 *
 * Each case runs in its own directory with its own home, so nothing here can
 * see the developer's sessions, trust record or database.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.ts");
// node --import tsx, rather than the tsx bin.
//
// On Windows that bin is a .cmd shim, and since the fix for CVE-2024-27980
// Node refuses to spawn one without a shell: every test in this file came
// back with an empty stdout, then with EINVAL. Loading tsx into this Node is
// the same thing without a shim, on every platform.
//
// Resolved to an absolute URL, because `--import tsx` is resolved from the
// working directory and every test here sets that to a temporary project.
const NODE = process.execPath;
const LOADER = ["--import", import.meta.resolve("tsx")];

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The one directory under this run's home that holds its state. Found rather
 * than computed: the slug comes from the *resolved* working directory, and on
 * macOS a temporary directory is a symlink, so building the name here would
 * disagree with the program about where it put things.
 */
function storeFor(home: string): string {
  const projects = path.join(home, ".gahoole", "projects");
  const [only] = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
  assert.ok(only, `one project directory under ${projects}`);
  return path.join(projects, only!);
}

/** One CLI process: `input` is typed at the prompt, one line per element. */
function run(
  input: string[],
  opts: {
    args?: string[];
    replies?: string[];
    /** `undefined` removes the variable rather than setting it. */
    env?: Record<string, string | undefined>;
    /** Reuse a home from a previous run, so state carries between processes. */
    home?: string;
    keep?: boolean;
  } = {},
): Promise<Run> {
  const home = opts.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(work, { recursive: true });

  return new Promise((resolve) => {
    const child = execFile(
      NODE,
      [...LOADER, CLI, "--no-banner", "--trust", ...(opts.args ?? [])],
      {
        cwd: work,
        timeout: 90_000,
        maxBuffer: 1 << 24,
        // An override of `undefined` removes the variable, which is the only
        // way to test what happens when one is not set at all.
        env: Object.fromEntries(
          Object.entries({
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            NO_COLOR: "1",
            GAHOOLE_BACKEND: "stub",
            GAHOOLE_STUB: JSON.stringify(opts.replies ?? ["ok."]),
            GAHOOLE_USER: "smoke",
            GAHOOLE_HOME: path.join(home, ".gahoole"),
            MCP_CONFIG: path.join(home, "no-such-mcp.json"),
            ...opts.env,
          }).filter(([, v]) => v !== undefined),
        ),
      },
      (err, stdout, stderr) => {
        if (!opts.keep) fs.rmSync(home, { recursive: true, force: true });
        resolve({
          stdout,
          stderr,
          code: (err as { code?: number } | null)?.code ?? 0,
        });
      },
    );
    child.stdin?.end(`${input.join("\n")}\n`);
  });
}

// --- it answers a question and leaves ---------------------------------------
{
  const r = await run(["こんにちは", "/exit"], { replies: ["はい、聞こえています。"] });
  assert.match(r.stdout, /聞こえています/, `the answer is printed:\n${r.stdout}`);
  assert.equal(r.code, 0);
}

// --- /help and the commands it advertises actually exist --------------------
{
  const r = await run(["/help", "/exit"]);
  const advertised = [...r.stdout.matchAll(/^\s*(\/[a-z]+)/gm)].map((m) => m[1]!);
  assert.ok(advertised.length >= 10, `help lists the commands: ${advertised.join(" ")}`);

  // Every one of them runs without crashing the process. A command that only
  // exists in the help text is worse than one that is not documented.
  const r2 = await run([...new Set(advertised.filter((c) => c !== "/exit"))], {});
  assert.equal(r2.code, 0, `no command kills the process:\n${r2.stdout}\n${r2.stderr}`);
  assert.ok(
    !/unknown command/i.test(r2.stdout),
    `and none is unknown:\n${r2.stdout}`,
  );
}

// --- /profile switches, and says what it switched to ------------------------
{
  const r = await run(["/profile", "/profile argus", "/profile", "/exit"]);
  assert.match(r.stdout, /athena/, "the list names every profile");
  assert.match(r.stdout, /pythia/);
  assert.match(r.stdout, /daedalus/);
  assert.match(r.stdout, /argus/);
  assert.match(r.stdout, /a hundred eyes/, "switching reports what it switched to");
  // The marker moves with it.
  const last = r.stdout.slice(r.stdout.lastIndexOf("athena"));
  assert.match(last, /›\s*argus/, `the current profile is marked:\n${last}`);
}

{
  const r = await run(["/profile nonesuch", "/exit"]);
  assert.match(r.stdout, /unknown profile/);
  assert.equal(r.code, 0, "an unknown profile is not fatal");
}

// --- --profile picks one at startup, and a bad one refuses to start ---------
{
  const r = await run(["/profile", "/exit"], { args: ["--profile", "pythia"] });
  assert.match(r.stdout.slice(r.stdout.indexOf("athena")), /›\s*pythia/);
}
{
  const r = await run(["/exit"], { args: ["--profile", "nonesuch"] });
  assert.notEqual(r.code, 0, "an unknown profile at startup is fatal");
  assert.match(r.stderr, /unknown profile/);
}

// --- the tool loop runs a real tool from a scripted reply -------------------
{
  const r = await run(["ファイルを作って", "/exit"], {
    args: ["--allow"],
    replies: [
      ['TOOL_CALL: {"tool":"write_file","input":{"path":"made.txt"}}', "```", "hello", "```"].join(
        "\n",
      ),
      "書き込みました。",
    ],
  });
  assert.match(r.stdout, /write_file/, `the call is shown:\n${r.stdout}`);
  assert.match(r.stdout, /書き込みました/, "and the answer after it");
}

// --- approval: piped input is refused, --allow is not -----------------------
//
// There is nobody at a pipe to ask, so the answer is no. This used to register
// no approval hook at all when there was no terminal, which meant piping input
// into gahoole ran every write, delete and command ungated — the opposite of
// the intent, and silently so.
{
  const call = 'TOOL_CALL: {"tool":"write_file","input":{"path":"a.txt","content":"x"}}';
  const refused = await run(["やって", "/exit"], { replies: [call, "やめました。"] });
  assert.ok(
    !/write_file ok/.test(refused.stdout),
    `nothing is written without someone to ask:\n${refused.stdout}`,
  );

  const allowed = await run(["やって", "/exit"], {
    args: ["--allow"],
    replies: [call, "やりました。"],
  });
  assert.match(allowed.stdout, /write_file ok/, `--allow runs it:\n${allowed.stdout}`);

  // And an explicit environment setting is honoured too, since someone who
  // set it meant it.
  const viaEnv = await run(["やって", "/exit"], {
    replies: [call, "やりました。"],
    env: { GAHOOLE_APPROVE: "allow" },
  });
  assert.match(viaEnv.stdout, /write_file ok/);
}

// --- /approve changes it mid-session ----------------------------------------
{
  const r = await run(["/approve", "/approve allow", "/approve", "/exit"]);
  assert.match(r.stdout, /ask/);
  assert.match(r.stdout, /writes, deletes and commands run without asking/);
}

// --- sessions: /clear starts a new one, /id names it ------------------------
{
  const r = await run(["/id", "/clear", "/id", "/exit"]);
  const ids = [...r.stdout.matchAll(/^[0-9a-f-]{36}$/gm)].map((m) => m[0]);
  assert.equal(ids.length, 2, `two ids printed:\n${r.stdout}`);
  assert.notEqual(ids[0], ids[1], "/clear opens a different session");
}

// --- trust: an untrusted folder with no terminal refuses to run -------------
//
// The refusal is the whole point — there is nobody to ask, and assuming yes
// would mean acting on a folder nobody vouched for.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(work, { recursive: true });
  const r = await new Promise<Run>((resolve) => {
    const child = execFile(
      NODE,
      [...LOADER, CLI, "--no-banner"],
      {
        cwd: work,
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          NO_COLOR: "1",
          GAHOOLE_BACKEND: "stub",
          MCP_CONFIG: path.join(home, "none.json"),
        },
      },
      (err, stdout, stderr) =>
        resolve({ stdout, stderr, code: (err as { code?: number } | null)?.code ?? 0 }),
    );
    child.stdin?.end("/exit\n");
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.match(r.stdout, /no terminal to ask/);
  assert.notEqual(r.code, 0, "and it does not run anyway");
}

// --- --help and --version answer without starting anything ------------------
{
  const r = await run([], { args: ["--help"] });
  assert.match(r.stdout, /usage/);
  assert.match(r.stdout, /--profile/);
  assert.equal(r.code, 0);

  const v = await run([], { args: ["--version"] });
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/, `a version number: ${v.stdout}`);
}

// --- a rate limit is survived, not just reported ---------------------------
//
// This is the only failure the program has a whole recovery path for, and it
// could not be exercised without waiting for a real one. The stub raises it on
// cue, so the path can be walked: the turn fails, the conversation is written
// to the handoff, and the next process picks it up rather than starting blank.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  try {
    const hit = await run(["越谷市の人口は？", "そのうち何割が15歳未満？", "/exit"], {
      home,
      keep: true,
      replies: ["約34万人です。", "__RATE_LIMIT__"],
    });
    assert.match(hit.stderr + hit.stdout, /rate.?limit/i, `the limit is reported:\n${hit.stderr}`);

    const saved = path.join(storeFor(home), "handoff", "smoke.json");
    assert.ok(fs.existsSync(saved), "the conversation is written to disk");
    const carried = fs.readFileSync(saved, "utf8");
    assert.match(carried, /越谷市/, "including what was being talked about");

    // A new process, same folder: it should open holding what the last one
    // was doing, and say so rather than starting blank.
    const next = await run(["/exit"], {
      home,
      keep: true,
      replies: ["続きです。"],
    });
    assert.match(next.stdout, /carried over/, `the next session picks it up:\n${next.stdout}`);
    assert.ok(
      !fs.existsSync(saved) ||
        !fs.readFileSync(saved, "utf8").includes("越谷市"),
      "and takes it, so it is not carried twice",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- the state lives under the home directory, not beside the code ---------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(path.join(work, "data", "notes"), { recursive: true });
  fs.writeFileSync(path.join(work, "data", "notes", "old.md"), "from before");

  try {
    const r = await run(["こんにちは", "/exit"], { home, keep: true });
    assert.match(r.stdout, /moved data\/ into/, `it says what it moved:\n${r.stdout}`);
    const store = storeFor(home);
    assert.ok(!fs.existsSync(path.join(work, "data")), "the old directory is gone");
    assert.equal(
      fs.readFileSync(path.join(store, "notes", "old.md"), "utf8"),
      "from before",
      "with everything that was in it",
    );
    for (const expected of ["gahoole.db", "events.jsonl"]) {
      assert.ok(fs.existsSync(path.join(store, expected)), `${expected} is written there`);
    }
    // And the working tree is left alone.
    assert.ok(
      !fs.existsSync(path.join(work, ".gahoole")),
      "nothing is created in the project",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- settings.json sets the defaults, and a flag still beats it ------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(path.join(work, ".gahoole"), { recursive: true });
  fs.writeFileSync(
    path.join(work, ".gahoole", "settings.json"),
    JSON.stringify({ profile: "argus" }),
  );
  try {
    const fromFile = await run(["/profile", "/exit"], { home, keep: true });
    assert.match(
      fromFile.stdout.slice(fromFile.stdout.indexOf("athena")),
      /›\s*argus/,
      "the project's settings choose the profile",
    );
    const fromFlag = await run(["/profile", "/exit"], {
      home,
      keep: true,
      args: ["--profile", "pythia"],
    });
    assert.match(
      fromFlag.stdout.slice(fromFlag.stdout.indexOf("athena")),
      /›\s*pythia/,
      "and a flag typed just now beats it",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- GAHOOLE.md is read the way CLAUDE.md is -------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, "GAHOOLE.md"),
    "# このプロジェクトについて\n\n出力は必ず日本語で。",
  );
  try {
    const r = await run(["/exit"], { home, keep: true });
    assert.match(r.stdout, /GAHOOLE\.md · 3 lines/, `it is read and counted:\n${r.stdout}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- the reviewer starts with nothing ---------------------------------------
//
// Its worth is that it does not already believe what everyone involved
// believes, which is only true if nothing was carried in. Checked at startup
// and on the switch, because context cannot be taken back out of a session.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-cli-"));
  const work = path.join(home, "project");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "GAHOOLE.md"), "このプロジェクトについて\n\n出力は日本語で。");

  try {
    // Ordinarily the instructions are read and announced.
    const normal = await run(["/exit"], { home, keep: true });
    assert.match(
      normal.stdout,
      /GAHOOLE\.md · \d+ lines/,
      `read by default:\n${normal.stdout}`,
    );

    // Started as the reviewer, they are not.
    const sealed = await run(["/exit"], {
      home,
      keep: true,
      args: ["--profile", "themis"],
    });
    assert.ok(
      !/GAHOOLE\.md · \d+ lines/.test(sealed.stdout),
      `and not by themis:\n${sealed.stdout}`,
    );
    assert.match(sealed.stdout, /nothing carried in/, "and it says so");

    // Switching to it mid-session opens a new one, since the old one already
    // has the context in it.
    const switched = await run(["/id", "/profile themis", "/id", "/exit"], {
      home,
      keep: true,
    });
    const ids = [...switched.stdout.matchAll(/^[0-9a-f-]{36}$/gm)].map((m) => m[0]);
    assert.equal(ids.length, 2, `two ids printed:\n${switched.stdout}`);
    assert.notEqual(ids[0], ids[1], "a different session");
    assert.match(switched.stdout, /nothing carried in/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- where --serve listens ------------------------------------------------
//
// The flag after --serve is not necessarily a port. `gahoole --serve --host
// 0.0.0.0` read "--host" as one and handed listen() a NaN.
{
  const { serveConfig } = await import("./serve.js");
  const bare: NodeJS.ProcessEnv = {};

  assert.equal(serveConfig([], bare).serving, false);
  assert.equal(serveConfig(["--serve"], bare).serving, true);
  assert.equal(serveConfig(["--serve"], bare).port, 8765, "a default worth having");
  assert.equal(serveConfig(["--serve", "9000"], bare).port, 9000);
  assert.equal(serveConfig(["--serve", "0"], bare).port, 0, "0 means pick one");

  // The bug: the next flag is not a port.
  assert.equal(serveConfig(["--serve", "--host", "0.0.0.0"], bare).port, 8765);
  assert.equal(serveConfig(["--serve", "--host", "0.0.0.0"], bare).host, "0.0.0.0");
  assert.equal(serveConfig(["--serve", "--allow"], bare).port, 8765);

  // Localhost unless asked otherwise, in both directions.
  assert.equal(serveConfig(["--serve"], bare).host, "127.0.0.1");
  assert.equal(serveConfig(["--serve", "--host"], bare).host, "127.0.0.1", "no address given");
  assert.equal(serveConfig(["--serve", "--host", "--allow"], bare).host, "127.0.0.1");

  // The environment fills in, and the command line wins.
  assert.equal(serveConfig(["--serve"], { GAHOOLE_PORT: "7000" }).port, 7000);
  assert.equal(serveConfig(["--serve", "9000"], { GAHOOLE_PORT: "7000" }).port, 9000);
  assert.equal(serveConfig(["--serve"], { GAHOOLE_PORT: "nonsense" }).port, 8765);
  assert.equal(serveConfig(["--serve"], { GAHOOLE_HOST: "0.0.0.0" }).host, "0.0.0.0");
}

// --- Esc, while a turn is running ------------------------------------------
{
  const { escWatcher, beginTurn, cancelled } = await import("./interrupt.js");

  const raw: boolean[] = [];
  let handler: ((b: Buffer) => void) | undefined;
  let stopped = 0;
  const fake = {
    isTTY: true,
    setRawMode: (on: boolean) => raw.push(on),
    on: (_: "data", fn: (b: Buffer) => void) => (handler = fn),
    off: (_: "data", fn: (b: Buffer) => void) => {
      if (handler === fn) handler = undefined;
    },
  };
  const watch = escWatcher(fake, { onCancel: () => stopped++ });

  beginTurn();
  watch(true);
  assert.deepEqual(raw, [true], "raw mode, to see a single key");
  assert.ok(handler, "and something watching for it");

  // Ordinary typing is not an interrupt.
  handler?.(Buffer.from("a"));
  assert.equal(cancelled(), false);
  // Nor is an arrow key, which starts with the same byte and is longer.
  handler?.(Buffer.from("\x1b[A"));
  assert.equal(cancelled(), false, "an arrow key is not Esc");

  handler?.(Buffer.from("\x1b"));
  assert.equal(cancelled(), true);
  assert.equal(stopped, 1, "and the spinner is told");

  // Raw mode is always given back.
  watch(false);
  assert.deepEqual(raw, [true, false]);
  assert.equal(handler, undefined, "and stdin is let go of");

  // Asking twice for the same state does nothing, which is what keeps the
  // pause/resume around approval from leaving the terminal in raw mode.
  watch(false);
  watch(true);
  watch(true);
  assert.deepEqual(raw, [true, false, true]);
  watch(false);

  // Without a terminal there is no key to watch for.
  const headless = { ...fake, isTTY: false };
  const off = escWatcher(headless);
  off(true);
  assert.deepEqual(raw, [true, false, true, false], "nothing more happened");

  // And a run that is being driven from above is not interruptible by hand.
  const disabled = escWatcher(fake, { enabled: () => false });
  disabled(true);
  assert.equal(raw.length, 4);

  beginTurn();
  assert.equal(cancelled(), false, "the next turn starts clean");
}

// --- NO_COLOR ----------------------------------------------------------------
//
// The banner, the trust prompt and the spinner all honoured it; the progress
// lines the CLI writes itself did not, so `NO_COLOR=1 gahoole` still wrapped
// every one of them in escape codes — visible the moment the output went
// anywhere but a terminal.
{
  const plain = await run(["こんにちは", "/exit"], { replies: ["はい。"] });
  assert.ok(!plain.stdout.includes("\x1b["), `no escapes with NO_COLOR:\n${plain.stdout}`);

  // And with it unset there are some, so the check above is not vacuous.
  const colored = await run(["こんにちは", "/exit"], {
    replies: ["はい。"],
    env: { NO_COLOR: undefined },
  });
  assert.ok(colored.stdout.includes("\x1b["), "and colour when it is not asked to stop");
}

console.log("ok — cli: answers, commands, profiles, approval, sessions, trust, --serve, Esc, NO_COLOR");
process.exit(0);
