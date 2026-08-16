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
}
process.exit(0);
