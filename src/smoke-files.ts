/**
 * File tools, guard and approval. Offline: the tools run against a scratch
 * directory and the approval prompt is answered by a stub, so the whole
 * decision path is exercised without a terminal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Lifecycle } from "./lifecycle.js";
import { registerFileGuard } from "./hooks/file-guard.js";
import { registerApproval } from "./hooks/approval.js";
import { tools, MUTATING } from "./tools.js";

const ROOT = process.cwd();
const SCRATCH = path.join(ROOT, "tmp-smoke-files");
fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });
const at = (p: string) => path.join("tmp-smoke-files", p);
const trash: string[] = [];

const run = (name: keyof typeof tools, input: unknown) =>
  (tools[name] as { execute: (i: unknown, c?: unknown) => Promise<any> }).execute(
    input,
    {},
  );

try {
  // --- write, read, edit -----------------------------------------------------
  const w = await run("write_file", { path: at("a.txt"), content: "one\ntwo\n" });
  assert.equal(w.created, true);
  // The size in the result comes from the filesystem, not from the input: a
  // write that reports success for a file that is not there teaches the model
  // it succeeded, and it says so to the user.
  assert.equal(w.verified, true);
  assert.equal(w.bytes, fs.statSync(path.join(SCRATCH, "a.txt")).size);
  assert.equal(fs.readFileSync(path.join(SCRATCH, "a.txt"), "utf8"), "one\ntwo\n");

  const r = await run("read_file", { path: at("a.txt") });
  assert.equal(r.content, "one\ntwo\n");
  assert.equal(r.lines, 3);

  const ranged = await run("read_file", { path: at("a.txt"), offset: 2, limit: 1 });
  assert.equal(ranged.content, "two");

  const e = await run("edit_file", { path: at("a.txt"), old: "two", new: "three" });
  assert.equal(fs.readFileSync(path.join(SCRATCH, "a.txt"), "utf8"), "one\nthree\n");
  assert.equal(e.verified, true, "the new text was read back out of the file");

  // An edit has to be unambiguous, and say so when it is not.
  await run("write_file", { path: at("dup.txt"), content: "x\nx\n" });
  await assert.rejects(
    () => run("edit_file", { path: at("dup.txt"), old: "x", new: "y" }),
    /appears 2 times/,
  );
  await assert.rejects(
    () => run("edit_file", { path: at("a.txt"), old: "nope", new: "y" }),
    /no match/,
  );

  // Nested writes create their parents.
  await run("write_file", { path: at("deep/b.txt"), content: "hi" });
  assert.ok(fs.existsSync(path.join(SCRATCH, "deep/b.txt")));

  // The pattern matches the file name, and the walk is recursive by default.
  const listed = await run("list_files", { dir: "tmp-smoke-files", pattern: "*.txt" });
  assert.deepEqual(
    listed.files.sort(),
    [at("a.txt"), at("dup.txt"), at("deep/b.txt")].sort(),
  );

  // depth 0 stays in the directory it was given.
  const shallow = await run("list_files", {
    dir: "tmp-smoke-files",
    pattern: "*.txt",
    depth: 0,
  });
  assert.deepEqual(shallow.files.sort(), [at("a.txt"), at("dup.txt")].sort());

  // --- search reads contents, not names ---------------------------------------
  await run("write_file", {
    path: at("search/hay.ts"),
    content: "const needle = 1;\nconst other = 2;\nNEEDLE_UPPER\n",
  });
  await run("write_file", { path: at("search/hay.md"), content: "needle in prose\n" });

  const found = await run("search_files", { pattern: "needle", dir: "tmp-smoke-files" });
  assert.equal(found.files, 2, "both files matched");
  assert.deepEqual(
    found.matches.map((m: { line: number }) => m.line).sort(),
    [1, 1, 3],
    "case-insensitive, and the line numbers are 1-based",
  );
  assert.ok(
    found.matches.every((m: { text: string }) => !m.text.startsWith(" ")),
    "match text is trimmed",
  );

  // glob narrows by file name, regex changes how the pattern is read.
  const scoped = await run("search_files", {
    pattern: "needle",
    dir: "tmp-smoke-files",
    glob: "*.md",
  });
  assert.equal(scoped.files, 1);

  const plain = await run("search_files", { pattern: "const.other", dir: "tmp-smoke-files" });
  assert.equal(plain.matches.length, 0, "a dot is a dot unless regex is set");
  const asRegex = await run("search_files", {
    pattern: "const.other",
    dir: "tmp-smoke-files",
    regex: true,
  });
  assert.equal(asRegex.matches.length, 1);

  // Contents of a secret are never quoted back, even though searching is
  // read-only and ungated.
  fs.writeFileSync(path.join(SCRATCH, "search/credentials.json"), '{"needle":"secret"}');
  const guarded = await run("search_files", { pattern: "needle", dir: "tmp-smoke-files" });
  assert.ok(
    guarded.matches.every((m: { file: string }) => !m.file.includes("credentials")),
    "credentials.json is skipped",
  );

  // --- delete moves to the trash rather than unlinking ------------------------
  await run("write_file", { path: at("gone.txt"), content: "bye" });
  const del = await run("delete_file", { path: at("gone.txt") });
  assert.ok(!fs.existsSync(path.join(SCRATCH, "gone.txt")), "gone from where it was");
  // The trash lives under the home directory, so its path is shown as one —
  // shortened rather than as a chain of `..` back out of the project.
  assert.ok(
    del.trashed.startsWith("~/") || path.isAbsolute(del.trashed),
    `a readable path, not a climb: ${del.trashed}`,
  );
  assert.ok(!del.trashed.includes(".."), "no ..");
  const trashed = del.trashed.replace(/^~/, os.homedir());
  assert.ok(fs.existsSync(trashed), `and recoverable at ${del.trashed}`);
  assert.equal(fs.readFileSync(trashed, "utf8"), "bye");
  // Both halves checked: gone from where it was, and there to restore.
  // "Deleted" is worth nothing if the file is still there, and "recoverable"
  // is worth less than nothing if it is not.
  assert.equal(del.verified, true);
  trash.push(trashed);

  await assert.rejects(() => run("delete_file", { path: at("nope.txt") }), /no such file/);
  await assert.rejects(
    () => run("delete_file", { path: "tmp-smoke-files" }),
    /is a directory/,
  );
  await assert.rejects(() => run("delete_file", { path: "." }), /project root/);

  // --- run_command ------------------------------------------------------------
  const echo = await run("run_command", { command: "echo", args: ["hi"] });
  assert.equal(echo.stdout.trim(), "hi");
  assert.equal(echo.code, 0);

  // A failing command is a result to report, not an error to throw — a failing
  // test is exactly what the model needs to see.
  const fail = await run("run_command", {
    command: "node",
    args: ["-e", "process.exit(3)"],
  });
  assert.equal(fail.code, 3);

  await assert.rejects(
    () => run("run_command", { command: "curl", args: ["evil.example"] }),
    /not allowed/,
  );
  // A program the agent just built has no place in an allowlist, so anything
  // under the root may be run — but only under the root.
  await assert.rejects(
    () => run("run_command", { command: "../outside" }),
    /escapes the project root/,
  );
  // A model writes a command line, not an argv. Measured running a plugin
  // skill: five calls in a row arrived as one string and all five were
  // refused, which is a protocol that does not work rather than a model that
  // cannot follow one.
  const line = await run("run_command", { command: "echo hello world" });
  assert.equal(line.stdout.trim(), "hello world");

  const quoted = await run("run_command", { command: 'echo "one arg" two' });
  assert.equal(quoted.stdout.trim(), "one arg two", "quotes group, then go away");

  // ...including when it arrives as the fenced block rather than as JSON.
  const body = await run("run_command", { content: "echo from-a-body" });
  assert.equal(body.stdout.trim(), "from-a-body");

  await assert.rejects(() => run("run_command", {}), /needs a command/);

  // An interactive program with no arguments must not sit waiting to be typed
  // at. A model wrote `-args` where it meant `args`, which launched a bare
  // python3, and the interpreter held the turn for the full sixty-second
  // timeout. Closing stdin turns that into an immediate exit.
  {
    const started = Date.now();
    const bare = await run("run_command", { command: "python3" });
    assert.ok(
      Date.now() - started < 10_000,
      `a bare interpreter exits at once (${Date.now() - started}ms)`,
    );
    assert.equal(typeof bare.code, "number");
  }

  // Splitting a line is not having a shell: a metacharacter is still an
  // argument, so this prints rather than deletes.
  const asWritten = await run("run_command", { command: "echo a; rm -rf /" });
  assert.equal(asWritten.stdout.trim(), "a; rm -rf /");

  // There is no shell, so metacharacters are arguments, not syntax.
  const literal = await run("run_command", {
    command: "echo",
    args: ["a; rm -rf /"],
  });
  assert.equal(literal.stdout.trim(), "a; rm -rf /");

  // --- the tools refuse to leave the root -----------------------------------
  await assert.rejects(
    () => run("read_file", { path: "../../etc/passwd" }),
    /escapes the project root/,
  );
  await assert.rejects(
    () => run("write_file", { path: "/tmp/escape.txt", content: "x" }),
    /escapes the project root/,
  );

  // --- and the guard refuses first, with a reason -----------------------------
  const guard = new Lifecycle();
  registerFileGuard(guard);
  const check = (toolName: string, input: unknown) =>
    guard.emitPreToolUse({
      sessionId: "s",
      turnId: "t",
      toolCallId: "c",
      toolName,
      input,
    });

  assert.match((await check("read_file", { path: "../secrets" }))?.deny ?? "", /outside/);
  // The project root is a normal thing to list or search, and not a thing to
  // write to or delete.
  assert.equal(await check("list_files", { dir: "." }), undefined);
  assert.equal(await check("search_files", { dir: "." }), undefined);
  assert.match((await check("delete_file", { path: "." }))?.deny ?? "", /project root/);
  assert.match((await check("read_file", { path: ".env" }))?.deny ?? "", /credentials/);
  assert.match((await check("read_file", { path: ".git/config" }))?.deny ?? "", /credentials/);
  assert.match((await check("write_file", { path: "node_modules/x.js", content: "" }))?.deny ?? "", /generated/);
  assert.match((await check("write_file", { path: "src/x.ts", content: "x".repeat(600_000) }))?.deny ?? "", /too much/);
  // Some files are not worth trashing even recoverably.
  assert.match((await check("delete_file", { path: "package.json" }))?.deny ?? "", /not something to delete/);
  assert.match((await check("delete_file", { path: "src/tools.ts" }))?.deny ?? "", /not something to delete/);
  assert.equal(await check("delete_file", { path: "src/other.ts" }), undefined);
  // Reading .env is refused too — a model that reads it can repeat it.
  assert.ok(await check("read_file", { path: ".env" }), "reads are guarded as well");
  // Ordinary source is untouched.
  assert.equal(await check("write_file", { path: "src/x.ts", content: "x" }), undefined);
  assert.equal(await check("write_note", { name: "n", body: "b" }), undefined);

  // --- approval --------------------------------------------------------------
  const answers: string[] = [];
  const approving = new Lifecycle();
  let reply = "n";
  registerApproval(approving, async (q) => {
    answers.push(q);
    return reply;
  }, { mode: "ask" });

  const askFor = (toolName: string) =>
    approving.emitPreToolUse({
      sessionId: "s",
      turnId: "t",
      toolCallId: "c",
      toolName,
      input: { path: "src/x.ts", content: "x" },
    });

  assert.equal(await askFor("read_file"), undefined, "reads are never asked about");
  assert.ok(MUTATING.has("delete_file"), "deleting is gated by approval");
  assert.ok(MUTATING.has("run_command"), "so is running a command");
  assert.equal(answers.length, 0);

  assert.match((await askFor("write_file"))?.deny ?? "", /declined/);
  assert.ok(answers[0]?.includes("write src/x.ts"), "the prompt says what would happen");

  reply = "y";
  assert.equal(await askFor("write_file"), undefined, "y allows it");

  reply = "a";
  assert.equal(await askFor("write_file"), undefined);
  const asked = answers.length;
  reply = "n";
  assert.equal(await askFor("write_file"), undefined, "'always' is remembered");
  assert.equal(answers.length, asked, "and not asked again");

  // "A" turns the asking off for the rest of the session; lowercase "a" only
  // covers the one tool, so the wide switch takes a distinct keystroke.
  {
    const wide = new Lifecycle();
    let asked = 0;
    const control = registerApproval(
      wide,
      async () => {
        asked++;
        return "A";
      },
      { mode: "ask" },
    );
    const call = (toolName: string) =>
      wide.emitPreToolUse({
        sessionId: "s", turnId: "t", toolCallId: "c",
        toolName, input: { path: "a", content: "b" },
      });

    assert.equal(await call("write_file"), undefined);
    assert.equal(control.mode, "allow", "the session is now allow");
    assert.equal(await call("delete_file"), undefined, "and other tools too");
    assert.equal(asked, 1, "asked once, never again");

    // And it can be turned back on mid-session.
    control.set("ask");
    assert.equal(control.mode, "ask");
    assert.equal(control.always.size, 0, "per-tool grants are cleared with it");
  }

  // deny mode never asks at all.
  const denying = new Lifecycle();
  registerApproval(denying, async () => "y", { mode: "deny" });
  assert.match(
    (await denying.emitPreToolUse({
      sessionId: "s", turnId: "t", toolCallId: "c",
      toolName: "write_file", input: { path: "a", content: "b" },
    }))?.deny ?? "",
    /disabled/,
  );

  // --- a write that cannot be confirmed is not a success ----------------------
//
// The check is on the filesystem rather than on the call, so it catches the
// case the model cannot: the write returned, and the file is not what it says.
{
  const realWrite = fs.promises.writeFile;
  (fs.promises as { writeFile: unknown }).writeFile = (async () => {
    // Wrote nothing at all.
  }) as typeof fs.promises.writeFile;
  try {
    await assert.rejects(
      () => run("write_file", { path: at("ghost.txt"), content: "hello" }),
      /not there/,
      "a write that left no file is reported as a failure",
    );
  } finally {
    (fs.promises as { writeFile: unknown }).writeFile = realWrite;
  }
}

console.log(
    `ok — file tools: ${Object.keys(tools).length} tools, ${MUTATING.size} gated, guard and approval enforced`,
  );
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  for (const t of trash) fs.rmSync(path.dirname(path.dirname(t)), { recursive: true, force: true });
}
process.exit(0);
