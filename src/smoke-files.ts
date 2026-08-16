/**
 * File tools, guard and approval. Offline: the tools run against a scratch
 * directory and the approval prompt is answered by a stub, so the whole
 * decision path is exercised without a terminal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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
  assert.equal(fs.readFileSync(path.join(SCRATCH, "a.txt"), "utf8"), "one\ntwo\n");

  const r = await run("read_file", { path: at("a.txt") });
  assert.equal(r.content, "one\ntwo\n");
  assert.equal(r.lines, 3);

  const ranged = await run("read_file", { path: at("a.txt"), offset: 2, limit: 1 });
  assert.equal(ranged.content, "two");

  await run("edit_file", { path: at("a.txt"), old: "two", new: "three" });
  assert.equal(fs.readFileSync(path.join(SCRATCH, "a.txt"), "utf8"), "one\nthree\n");

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

  // --- delete moves to the trash rather than unlinking ------------------------
  await run("write_file", { path: at("gone.txt"), content: "bye" });
  const del = await run("delete_file", { path: at("gone.txt") });
  assert.ok(!fs.existsSync(path.join(SCRATCH, "gone.txt")), "gone from where it was");
  assert.ok(
    fs.existsSync(path.join(ROOT, del.trashed)),
    `and recoverable at ${del.trashed}`,
  );
  assert.equal(fs.readFileSync(path.join(ROOT, del.trashed), "utf8"), "bye");
  trash.push(path.join(ROOT, del.trashed));

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

  console.log(
    `ok — file tools: ${Object.keys(tools).length} tools, ${MUTATING.size} gated, guard and approval enforced`,
  );
} finally {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  for (const t of trash) fs.rmSync(path.dirname(path.dirname(t)), { recursive: true, force: true });
}
process.exit(0);
