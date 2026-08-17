/**
 * The pieces every other file leans on and nothing had a test for: which
 * backend gets built, what a turn knows about itself, how a failure is
 * classified, what the audit log records, and how sessions are named and
 * found again.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-core-"));
process.env.GAHOOLE_HOME = HOME;
process.chdir(HOME);

const { Lifecycle, ToolDeniedError } = await import("./lifecycle.js");
const { turnStore, currentTurn } = await import("./turn-context.js");
const { backendKind, createBackend, AiModeRateLimitError } = await import(
  "./backends/index.js"
);
const { looksLikeCrash } = await import("./backends/aimode.js");
const { approvalMode } = await import("./hooks/approval.js");
const { registerJsonlLog, registerWriteGuard, registerMcpPolicy } = await import(
  "./hooks/logging.js"
);
const { classifyFailure, shouldHandoff } = await import("./handoff.js");
const { formatSessions, AmbiguousSessionError } = await import("./sessions.js");
const { needsAction } = await import("./tool-loop.js");
const { extractAttachments } = await import("./attachments.js");
const { summarizeThread } = await import("./summarize.js");
const { Session } = await import("./session.js");

const env = { ...process.env };
const restore = () => {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  Object.assign(process.env, env);
};

try {
  // =========================================================================
  // which backend gets built
  // =========================================================================
  {
    delete process.env.GAHOOLE_BACKEND;
    assert.equal(backendKind(), "ai-mode", "the default needs no key and no setting");
    process.env.GAHOOLE_BACKEND = "api";
    assert.equal(backendKind(), "api");
    process.env.GAHOOLE_BACKEND = "stub";
    assert.equal(backendKind(), "stub");
    process.env.GAHOOLE_BACKEND = "nonsense";
    assert.equal(backendKind(), "ai-mode", "an unknown name falls back rather than failing");

    // The stub answers from a script, which is what makes the CLI testable.
    process.env.GAHOOLE_STUB = JSON.stringify(["one", "two"]);
    const stub = createBackend("stub", {} as never, "r", () => "s");
    assert.equal(await stub.ask("?"), "one");
    assert.equal(await stub.ask("?"), "two");
    assert.equal(await stub.ask("?"), "two", "the last reply repeats");
    stub.reset?.();
    assert.equal(await stub.ask("?"), "one", "reset starts the script again");
    assert.equal((await stub.fork?.())?.name, "stub", "a fork is the same script");

    // The one failure worth being able to script.
    process.env.GAHOOLE_STUB = JSON.stringify(["__RATE_LIMIT__"]);
    const limited = createBackend("stub", {} as never, "r", () => "s");
    await assert.rejects(() => limited.ask("?"), AiModeRateLimitError);

    // Nonsense in the variable is not a crash at startup.
    process.env.GAHOOLE_STUB = "{{{";
    assert.equal(typeof (await createBackend("stub", {} as never, "r", () => "s").ask("?")), "string");
    delete process.env.GAHOOLE_STUB;
  }

  // =========================================================================
  // a dead browser is not a refused answer
  // =========================================================================
  for (const message of [
    "Target closed",
    "Target crashed",
    "Protocol error (Runtime.callFunctionOn): Session closed",
    "browser has been closed",
    "WebSocket is not open",
  ]) {
    assert.ok(looksLikeCrash(new Error(message)), message);
  }
  for (const message of [
    "locator.click: Timeout 5000ms exceeded",
    "AI Mode returned nothing",
    "no such file",
  ]) {
    assert.ok(
      !looksLikeCrash(new Error(message)),
      `${message} is not a crash — relaunching would hide it`,
    );
  }

  // A declined query is its own thing too: the profile is fine and the next
  // question works, so it is neither a rate limit nor a crash. Left
  // undetected it was handed back as the answer — a loop asking for a file's
  // contents got "この検索に対しては回答することができなかったようです" three times while
  // the file stayed empty.
  {
    const { AiModeRefusedError } = await import("./backends/aimode.js");
    const refused = new AiModeRefusedError();
    assert.equal(refused.name, "AiModeRefusedError");
    assert.ok(!looksLikeCrash(refused));
    assert.ok(!(refused instanceof AiModeRateLimitError));
  }

  // An empty page is its own thing: not a refusal, not a dead browser, and
  // measured at roughly one query in forty when hammering — the same profile
  // answers normally straight afterwards, so it is worth asking again for.
  {
    const { EmptyAnswerError } = await import("./backends/aimode.js");
    const empty = new EmptyAnswerError();
    assert.equal(empty.name, "EmptyAnswerError");
    assert.ok(!looksLikeCrash(empty), "and not treated as a crash");
    assert.ok(!(empty instanceof AiModeRateLimitError), "nor as a refusal");
  }

  // =========================================================================
  // a turn knows itself, and only inside itself
  // =========================================================================
  {
    assert.equal(currentTurn(), undefined, "outside a turn there is nothing to attribute to");
    const ctx = { sessionId: "s", turnId: "t", toolCalls: 0, pending: new Map() };
    const seen = await turnStore.run(ctx, async () => {
      assert.equal(currentTurn()?.turnId, "t");
      return currentTurn();
    });
    assert.equal(seen?.sessionId, "s");
    assert.equal(currentTurn(), undefined, "and it does not leak out again");

    // Nested turns do not see each other's.
    await turnStore.run(ctx, async () => {
      const inner = { ...ctx, turnId: "inner", pending: new Map() };
      await turnStore.run(inner, async () => {
        assert.equal(currentTurn()?.turnId, "inner");
      });
      assert.equal(currentTurn()?.turnId, "t", "the outer turn is restored");
    });
  }

  // =========================================================================
  // PreToolUse is the only hook that can change the outcome
  // =========================================================================
  {
    const l = new Lifecycle();
    const order: string[] = [];
    l.on("PreToolUse", () => {
      order.push("first");
    });
    l.on("PreToolUse", () => {
      order.push("throws");
      throw new Error("observer hooks are allowed to fail");
    });
    l.on("PreToolUse", () => {
      order.push("deny");
      return { deny: "not this one" };
    });
    l.on("PreToolUse", () => {
      order.push("after a denial");
      return { deny: "nor this" };
    });

    const decision = await l.emitPreToolUse({
      sessionId: "s",
      turnId: "t",
      toolCallId: "c",
      toolName: "write_file",
      input: {},
    });
    assert.equal(decision?.deny, "not this one", "the first denial is the one that counts");
    assert.deepEqual(
      order,
      ["first", "throws", "deny"],
      "a thrown hook is skipped, and nothing runs after a denial",
    );

    // An observer that throws never breaks a turn.
    const observers = new Lifecycle();
    observers.on("Stop", () => {
      throw new Error("still allowed to fail");
    });
    await observers.emit("Stop", {
      sessionId: "s",
      turnId: "t",
      text: "",
      toolCalls: 0,
      ms: 0,
    });

    {
      const denied = new ToolDeniedError("write_file", "because");
      assert.match(denied.message, /write_file/);
      assert.match(denied.message, /because/);
      assert.equal(denied.name, "ToolDeniedError");
    }
  }

  // =========================================================================
  // the audit log, and the guard that is not the file guard
  // =========================================================================
  {
    const l = new Lifecycle();
    registerJsonlLog(l);
    await l.emit("SessionStart", { sessionId: "s1", resourceId: "r" });
    await l.emit("Stop", {
      sessionId: "s1",
      turnId: "t1",
      text: "done",
      toolCalls: 1,
      ms: 12,
    });
    const log = path.join(HOME, "projects", fs.readdirSync(path.join(HOME, "projects"))[0]!, "events.jsonl");
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").map((l2) => JSON.parse(l2) as Record<string, unknown>);
    assert.equal(lines.length, 2, "one line per event");
    assert.equal(lines[0]?.event, "SessionStart");
    assert.ok(lines[0]?.t, "stamped, so the log is a timeline");
    assert.equal(lines[1]?.toolCalls, 1);

    // The write guard is about size, not about paths.
    const w = new Lifecycle();
    registerWriteGuard(w);
    const big = await w.emitPreToolUse({
      sessionId: "s", turnId: "t", toolCallId: "c",
      toolName: "write_note", input: { body: "x".repeat(30_000) },
    });
    assert.match(big?.deny ?? "", /20000|too/i);
    assert.equal(
      await w.emitPreToolUse({
        sessionId: "s", turnId: "t", toolCallId: "c",
        toolName: "write_note", input: { body: "short" },
      }),
      undefined,
    );
  }

  // =========================================================================
  // MCP policy: a rule matches a server or one of its tools, and deny wins
  // =========================================================================
  {
    const l = new Lifecycle();
    process.env.MCP_DENY = "fs_write_file,danger";
    process.env.MCP_ALLOW = "";
    registerMcpPolicy(l, ["fs", "danger"]);
    const ask = (toolName: string) =>
      l.emitPreToolUse({ sessionId: "s", turnId: "t", toolCallId: "c", toolName, input: {} });

    assert.ok((await ask("fs_write_file"))?.deny, "a named tool");
    assert.ok((await ask("danger_anything"))?.deny, "a whole server, including tools added later");
    assert.equal(await ask("fs_read_file"), undefined, "and nothing else");
    assert.equal(await ask("write_file"), undefined, "local tools are not MCP tools");
    delete process.env.MCP_DENY;
    delete process.env.MCP_ALLOW;
  }

  // =========================================================================
  // what counts as worth handing off
  // =========================================================================
  {
    const rate = classifyFailure(new AiModeRateLimitError());
    assert.equal(rate.kind, "rate_limit");
    assert.ok(shouldHandoff(rate.kind));

    for (const [error, kind] of [
      [Object.assign(new Error("429"), { status: 429 }), "rate_limit"],
      [Object.assign(new Error("overloaded"), { status: 529 }), "overloaded"],
      [new Error("context length exceeded"), "context"],
      [new Error("prompt is too long"), "context"],
    ] as const) {
      assert.equal(classifyFailure(error).kind, kind, error.message);
    }

    // Not everything is worth saving a conversation over. A browser that
    // failed to launch is a broken machine, not an interrupted session — and
    // "launchPersistentContext" contains the word "context", which is how
    // this was once filed as an overflow.
    const other = classifyFailure(new Error("launchPersistentContext failed"));
    assert.notEqual(other.kind, "context", "the launcher is not a context overflow");
    assert.ok(!shouldHandoff(other.kind));

    const withRetry = classifyFailure(
      Object.assign(new Error("429"), { status: 429, headers: { "retry-after": "30" } }),
    );
    assert.equal(withRetry.retryAfterMs, 30_000, "retry-after is read in seconds");
  }

  // =========================================================================
  // sessions are named so they can be told apart
  // =========================================================================
  {
    const rows = [
      {
        id: "0123456789abcdef0123456789abcdef",
        title: "越谷市について",
        createdAt: new Date("2026-08-16T09:00:00Z"),
        updatedAt: new Date("2026-08-16T09:30:00Z"),
        messages: 12,
      },
      {
        id: "fedcba9876543210fedcba9876543210",
        title: undefined,
        createdAt: new Date("2026-08-16T10:00:00Z"),
        updatedAt: new Date("2026-08-16T10:00:00Z"),
        messages: 0,
      },
    ];
    const out = formatSessions(rows as never, rows[0]!.id);
    assert.match(out, /01234567/, "the prefix you would type");
    assert.match(out, /越谷市について/);
    assert.ok(!out.includes("0123456789abcdef0123456789abcdef"), "not the whole id");
    assert.match(out, /›|\*|current/i, "the one you are in is marked");
    assert.equal(formatSessions([] as never, undefined).trim().length > 0, true, "empty says so");

    assert.match(new AmbiguousSessionError("ab", ["abc", "abd"]).message, /abc/);
  }

  // =========================================================================
  // does this prompt need something done?
  // =========================================================================
  {
    for (const yes of [
      "ファイルを作って",
      "テストを実行して",
      "バグを修正して",
      "write a file",
      "run the tests",
      "fix the bug",
    ]) {
      assert.ok(needsAction(yes), yes);
    }
    for (const no of ["おはよう", "2 + 2 は？", "what is the capital of Japan"]) {
      assert.ok(!needsAction(no), `${no} is a question, and a false positive costs a query`);
    }
  }

  // =========================================================================
  // attachments come out of the prompt, and the prompt comes back clean
  // =========================================================================
  {
    const img = path.join(HOME, "shot.png");
    fs.writeFileSync(img, "not really a png");
    const got = extractAttachments(`これを見て ${img} どう？`);
    assert.deepEqual(got.paths, [img]);
    assert.ok(!got.prompt.includes(img), "the path is taken out of the question");
    assert.match(got.prompt, /これを見て/);

    const none = extractAttachments("ただの質問");
    assert.deepEqual(none.paths, []);
    assert.equal(none.prompt, "ただの質問");

    // A path that is not there, and a file that is not an image.
    assert.deepEqual(extractAttachments(`${HOME}/missing.png`).paths, []);
    fs.writeFileSync(path.join(HOME, "notes.txt"), "x");
    assert.deepEqual(extractAttachments(`${HOME}/notes.txt`).paths, []);
  }

  // =========================================================================
  // summarizing works through whichever backend is in play
  // =========================================================================
  {
    process.env.GAHOOLE_BACKEND = "stub";
    process.env.GAHOOLE_STUB = JSON.stringify(["OBS find something was learned here"]);
    // Summaries prefer a local model when one is running, and on a machine
    // where Ollama is up this test would quietly measure that instead of what
    // it means to. A test that depends on what happens to be installed is not
    // a test.
    process.env.GAHOOLE_LOCAL_SUMMARY = "0";
    Session.backend = createBackend("stub", {} as never, "r", () => "s");

    const empty = await summarizeThread(
      { recall: async () => ({ messages: [] }) } as never,
      "t",
      "r",
      "summarize",
    );
    assert.equal(empty, "", "nothing to summarize costs no query");

    const said = await summarizeThread(
      {
        recall: async () => ({
          messages: [
            { role: "user", content: { parts: [{ type: "text", text: "越谷市の人口は？" }] } },
            { role: "assistant", content: { parts: [{ type: "text", text: "約34万人です。" }] } },
          ],
        }),
      } as never,
      "t",
      "r",
      "summarize this",
    );
    assert.match(said, /OBS find/, "and the backend's answer comes back");
    Session.backend = undefined as never;
    delete process.env.GAHOOLE_STUB;
    delete process.env.GAHOOLE_LOCAL_SUMMARY;
  }

  // =========================================================================
  // approval mode: the environment, then what was configured, then ask
  // =========================================================================
  {
    delete process.env.GAHOOLE_APPROVE;
    assert.equal(approvalMode(), "ask", "asking is the default");
    assert.equal(approvalMode("allow"), "allow", "settings.json is honoured");
    assert.equal(approvalMode("nonsense"), "ask", "and a typo is not an escalation");
    process.env.GAHOOLE_APPROVE = "deny";
    assert.equal(approvalMode("allow"), "deny", "the environment wins over the file");
    delete process.env.GAHOOLE_APPROVE;
  }

    // =========================================================================
  // output: one line, one owner
  // =========================================================================
  {
    const { log, logError, bindLineOwner } = await import("./output.js");
    const { registerConsoleTrace } = await import("./hooks/logging.js");

    // A spinner owns the line it is drawing on; anything printed while it runs
    // has to make it stand aside first, or the two interleave mid-line.
    let cleared = 0;
    let redrawn = 0;
    bindLineOwner({
      clear() {
        cleared++;
      },
      redraw() {
        redrawn++;
      },
    });

    const out: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => out.push(a.join(" "));
    try {
      log("a line");
      logError("a problem");
      assert.equal(cleared, 2, "the line owner stands aside for each");
      assert.equal(redrawn, 2, "and is put back afterwards");

      const l = new Lifecycle();
      registerConsoleTrace(l);
      await l.emit("SessionStart", { sessionId: "abcdefgh1234", resourceId: "r" });
      // PreToolUse is emitted through its own entry point, because it is the
      // one hook whose return value matters.
      await l.emitPreToolUse({
        sessionId: "s", turnId: "t", toolCallId: "c",
        toolName: "read_file", input: { path: "a.txt" },
      });
      await l.emit("PostToolUse", {
        sessionId: "s", turnId: "t", toolCallId: "c",
        toolName: "read_file", output: { content: "x" }, ms: 4,
      });
    } finally {
      console.log = realLog;
      console.error = realErr;
      bindLineOwner(undefined as never);
    }

    const printed = out.join("\n");
    assert.match(printed, /a line/);
    assert.match(printed, /a problem/);
    assert.match(printed, /read_file/, "a tool call is traced by name");
    assert.match(printed, /abcdefgh/, "and a session by its prefix");
  }

console.log(
    "ok — core: backends, turn context, hook precedence, audit log, mcp policy, failures, sessions",
  );
} finally {
  restore();
  process.chdir(os.tmpdir());
  fs.rmSync(HOME, { recursive: true, force: true });
}
process.exit(0);
