/**
 * The pure parts: the text protocol, and the plan the autonomous loop reads.
 *
 * These are the functions everything else trusts, and they are cheap to run
 * exhaustively — no browser, no model, no disk. Where a case here looks
 * oddly specific it is because it went wrong in a measured run.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CALL_PREFIX,
  RESULT_PREFIX,
  buildPreamble,
  buildReminder,
  describeTool,
  formatResult,
  formatResults,
  parseBody,
  parseCalls,
  parseMalformed,
  stripCalls,
} from "./tool-protocol.js";
import {
  parsePlan,
  readOutcome,
  readStepVerdicts,
  renderPlan,
  remaining,
  saysAllDone,
} from "./plan.js";

const call = (json: string) => `${CALL_PREFIX} ${json}`;
const content = (c: { input: unknown }) => (c.input as { content?: string }).content;

// ===========================================================================
// parseCalls
// ===========================================================================

// The ordinary case, and the markdown the page wraps it in.
for (const decorated of [
  call('{"tool":"read_file","input":{"path":"a.txt"}}'),
  `**${CALL_PREFIX}** {"tool":"read_file","input":{"path":"a.txt"}}`,
  `> ${CALL_PREFIX} \`{"tool":"read_file","input":{"path":"a.txt"}}\``,
  `   ${CALL_PREFIX}   {"tool":"read_file","input":{"path":"a.txt"}}   `,
]) {
  const [c] = parseCalls(decorated);
  assert.equal(c?.tool, "read_file", `parsed through markdown: ${decorated}`);
  assert.deepEqual(c?.input, { path: "a.txt" });
}

// Nested braces: the JSON is one line, so the match runs to the last brace.
{
  const [c] = parseCalls(call('{"tool":"t","input":{"a":{"b":1},"c":2}}'));
  assert.deepEqual(c?.input, { a: { b: 1 }, c: 2 });
}

// Missing input is an empty input, not a parse failure.
{
  const [c] = parseCalls(call('{"tool":"list_files"}'));
  assert.deepEqual(c?.input, {});
}

// Several calls, each with the block above it. This is what makes batching
// possible, and batching is what took a write-then-run from two round trips
// to one.
{
  const calls = parseCalls(
    [
      "まず書きます。",
      call('{"tool":"write_file","input":{"path":"a.cpp"}}'),
      "```cpp",
      "#include <iostream>",
      "```",
      "つぎに実行します。",
      call('{"tool":"run_command","input":{"command":"g++","args":["a.cpp"]}}'),
    ].join("\n"),
  );
  assert.equal(calls.length, 2);
  assert.equal(content(calls[0]!), "#include <iostream>");
  assert.equal(content(calls[1]!), undefined, "a block does not leak forward");
}

// Three calls, two blocks: the block belongs to the call it follows, and a
// call with no block of its own gets none.
{
  const calls = parseCalls(
    [
      call('{"tool":"write_file","input":{"path":"a"}}'),
      "```",
      "AAA",
      "```",
      call('{"tool":"run_command","input":{"command":"ls"}}'),
      call('{"tool":"write_file","input":{"path":"b"}}'),
      "```",
      "BBB",
      "```",
    ].join("\n"),
  );
  assert.equal(calls.length, 3);
  assert.equal(content(calls[0]!), "AAA");
  assert.equal(content(calls[1]!), undefined);
  assert.equal(content(calls[2]!), "BBB");
}

// With one call the block may come first — models write the code before the
// marker about as often as after it.
{
  const calls = parseCalls(
    ["```js", "console.log(1)", "```", call('{"tool":"write_file","input":{"path":"a.js"}}')].join("\n"),
  );
  assert.equal(content(calls[0]!), "console.log(1)");
}

// An explicit content field is never overwritten by a block.
{
  const calls = parseCalls(
    [call('{"tool":"write_file","input":{"path":"a","content":"given"}}'), "```", "block", "```"].join("\n"),
  );
  assert.equal(content(calls[0]!), "given");
}

// The marker-pair form, for when no fence survived.
{
  assert.equal(parseBody("TOOL_BODY:\nhello\nTOOL_END"), "hello");
  const calls = parseCalls(
    [call('{"tool":"write_file","input":{"path":"a"}}'), "TOOL_BODY:", "hello", "TOOL_END"].join("\n"),
  );
  assert.equal(content(calls[0]!), "hello");
}

// Prose that merely mentions the marker is not a call.
assert.deepEqual(parseCalls("I could use TOOL_CALL: to read the file."), []);
assert.deepEqual(parseCalls("no markers here at all"), []);

// Broken JSON is reported rather than swallowed — a silently dropped call is
// how a turn ends having done nothing while the reply says otherwise.
{
  const bad = call('{"tool":"write_file","input":{"content":"he said "hi""}}');
  assert.deepEqual(parseCalls(bad), []);
  assert.equal(parseMalformed(bad).length, 1);
  assert.ok(parseMalformed(bad)[0]?.reason);
}
assert.equal(parseMalformed(call('{"input":{}}')).length, 1, "no tool field is malformed");
assert.equal(parseMalformed(call('{"tool":"t","input":{}}')).length, 0);

// stripCalls leaves the prose and takes the markers, including their line.
assert.equal(
  stripCalls(`Here you go.\n${call('{"tool":"t","input":{}}')}\nDone.`),
  "Here you go.\nDone.",
);

// ===========================================================================
// formatResults
// ===========================================================================

// A single result, small enough to pass through untouched.
{
  const [r] = formatResults([{ tool: "t", outcome: { output: { ok: true } } }]);
  assert.ok(r?.startsWith(`${RESULT_PREFIX} `));
  assert.deepEqual(JSON.parse(r!.slice(RESULT_PREFIX.length + 1)), {
    tool: "t",
    output: { ok: true },
  });
}

// An error is reported as an error, with its message rather than "[object Object]".
{
  const [r] = formatResults([
    { tool: "t", outcome: { error: new Error("no such file") } },
  ]);
  assert.match(r!, /no such file/);
}

// Empty strings carry nothing and cost as much to send as anything else.
// Zero and false do carry something and must survive.
{
  const [r] = formatResults([
    { tool: "run_command", outcome: { output: { code: 0, stdout: "hi", stderr: "", ok: false } } },
  ]);
  const parsed = JSON.parse(r!.slice(RESULT_PREFIX.length + 1)) as {
    output: Record<string, unknown>;
  };
  assert.deepEqual(parsed.output, { code: 0, stdout: "hi", ok: false });
}

// Non-objects pass through unharmed.
for (const output of [null, "plain", 42, ["a", "b"]]) {
  const [r] = formatResults([{ tool: "t", outcome: { output } }]);
  assert.ok(r!.length > 0, `${JSON.stringify(output)} survives`);
}

// The budget is for the message, not for each result — they travel together
// in one composer message, and the composer drops whatever does not fit.
{
  const big = (n: number) => ({
    tool: "read_file",
    outcome: { output: { content: "x".repeat(n) } },
  });
  for (const shape of [
    [big(50_000)],
    [big(50_000), big(50_000)],
    [big(50_000), big(50_000), big(50_000)],
    [{ tool: "t", outcome: { output: { code: 0 } } }, big(50_000)],
    Array.from({ length: 9 }, () => big(9_000)),
  ]) {
    const out = formatResults(shape);
    const total = out.join("\n").length;
    assert.ok(total <= 7_100, `${shape.length} results fit together (${total})`);
    assert.equal(out.length, shape.length, "and none is dropped entirely");
  }
}

// A small result beside a huge one keeps all of itself: the budget is handed
// out smallest-first and the remainder goes to whoever needs it.
{
  const out = formatResults([
    { tool: "t", outcome: { output: { code: 0 } } },
    { tool: "read_file", outcome: { output: { content: "x".repeat(50_000) } } },
  ]);
  assert.ok(!out[0]!.includes("[middle cut]"), "the small one is untouched");
  assert.ok(out[1]!.length > 6_000, "and the large one gets nearly all the budget");
}

// Two equal claims are cut equally.
{
  const out = formatResults([
    { tool: "read_file", outcome: { output: { content: "a".repeat(50_000) } } },
    { tool: "read_file", outcome: { output: { content: "b".repeat(50_000) } } },
  ]);
  assert.ok(Math.abs(out[0]!.length - out[1]!.length) <= 2);
}

// What is cut is the middle. A compiler says what went wrong at the end, and
// head-only truncation reliably threw away the one line worth reading.
{
  const [r] = formatResults([
    {
      tool: "run_command",
      outcome: { output: { stdout: `START${"-".repeat(50_000)}FINISH` } },
    },
  ]);
  assert.match(r!, /START/, "the head survives");
  assert.match(r!, /FINISH/, "and so does the tail");
  assert.match(r!, /\[middle cut\]/, "and the cut is announced");
}

// Degenerate budgets do not throw or run away.
assert.deepEqual(formatResults([]), []);
{
  const out = formatResults(
    [{ tool: "read_file", outcome: { output: { content: "x".repeat(500) } } }],
    30,
  );
  assert.ok(out[0]!.length <= 30 + RESULT_PREFIX.length + 2, `tiny budget honoured: ${out[0]!.length}`);
}

// formatResult is the one-result case of the same thing.
assert.equal(
  formatResult("t", { output: { a: 1 } }),
  formatResults([{ tool: "t", outcome: { output: { a: 1 } } }])[0],
);

// ===========================================================================
// preamble and reminder
// ===========================================================================
{
  const specs = [
    { name: "read_file", description: "Read a file. And more.", params: ["path"] },
    { name: "write_file", description: "Write it.", params: ["path", "content"] },
  ];
  const pre = buildPreamble(specs);
  assert.ok(pre.includes("read_file(path) Read a file."), "name, params, first clause");
  assert.ok(!pre.includes("And more."), "and not the rest of the description");
  assert.ok(pre.includes(CALL_PREFIX));
  assert.ok(/several/.test(pre), "batching is offered, which is what makes it cheap");

  const rem = buildReminder(specs);
  assert.ok(rem.includes("read_file(path)") && rem.includes("write_file(path,content)"));
  assert.ok(rem.length < pre.length, "the reminder rides on every question, so it is shorter");

  assert.equal(buildPreamble([]), "", "no tools, nothing to explain");
  assert.equal(buildReminder([]), "");
}

// describeTool reads the schema rather than being told twice.
{
  const spec = describeTool("t", {
    description: "Does a thing.",
    inputSchema: { shape: { a: {}, b: {} } },
  });
  assert.equal(spec.name, "t");
  assert.deepEqual(spec.params, ["a", "b"]);
}

// ===========================================================================
// plan
// ===========================================================================

// Every shape a list arrives in.
{
  const tasks = parsePlan(
    [
      "手順は次のとおりです。",
      "1. ファイルを書く",
      "2) コンパイルする",
      "- 実行して確認する",
      "* 結果を報告する",
      "**5. 太字になった見出し**",
    ].join("\n"),
  );
  assert.equal(tasks.length, 5);
  assert.equal(tasks[0]?.title, "ファイルを書く");
  assert.equal(tasks[1]?.title, "コンパイルする");
  assert.equal(tasks[4]?.title, "太字になった見出し", "markdown emphasis is stripped");
  assert.deepEqual(
    tasks.map((t) => t.id),
    [1, 2, 3, 4, 5],
    "renumbered in order, whatever the model wrote",
  );
}

// Prose is not a plan, and neither is a list of one-word items.
assert.deepEqual(parsePlan("I will write the file and then run it."), []);
assert.deepEqual(parsePlan("- a\n- b\n- c"), [], "too short to be steps");

// A runaway list is capped.
assert.equal(parsePlan(Array.from({ length: 40 }, (_, i) => `${i}. step number ${i}`).join("\n")).length, 12);

// Verdicts, in both languages, and the explicit flag that keeps a bare plan
// from being read as a finished step.
{
  assert.deepEqual(readOutcome("wrote it. DONE"), { status: "done", added: [], explicit: true });
  assert.equal(readOutcome("SKIP — already there").status, "skipped");
  assert.equal(readOutcome("FAILED no compiler").status, "failed");
  assert.equal(readOutcome("1. one thing\n2. two thing").explicit, false, "a bare plan reports nothing");
  assert.equal(readOutcome("1. one thing").status, "done", "but silence still moves the run");

  assert.equal(readOutcome("書き込みました。完了").status, "done", "完了 is a verdict");
  assert.equal(readOutcome("作業が完了しました").explicit, true, "even mid-sentence");
  assert.equal(readOutcome("コンパイルに失敗しました").status, "failed");
  assert.equal(readOutcome("これは不要です").status, "skipped");

  // ...and the words that contain a verdict while meaning its opposite. These
  // are the ones that used to be safe only by accident: \b never matched any
  // of them, so none of them was read either way.
  assert.equal(readOutcome("まだ未完了です").explicit, false, "未完了 is not 完了");
  assert.equal(readOutcome("完了していません").explicit, false);
  assert.equal(readOutcome("完了しませんでした").explicit, false);
  assert.equal(readOutcome("失敗していません").status, "done", "not a failure");
  assert.equal(readOutcome("処理が完了しました").status, "done");
  assert.equal(readOutcome("コンパイルは失敗した").status, "failed");
}

// Work a step discovered joins the list.
{
  const o = readOutcome("DONE\nNEXT: back up the original first\n追加: そして確認する");
  assert.deepEqual(o.added, ["back up the original first", "そして確認する"]);
}

// Several steps reported in one reply, because one turn is asked for as many
// as it can manage.
{
  const v = readStepVerdicts("STEP 1 DONE\nSTEP 2 SKIP\nSTEP 3 FAILED no compiler\nSTEP4 完了");
  assert.deepEqual(v, [
    { id: 1, status: "done" },
    { id: 2, status: "skipped" },
    { id: 3, status: "failed" },
    { id: 4, status: "done" },
  ]);
  assert.deepEqual(readStepVerdicts("nothing to report"), []);
}

// The goal's own DONE ends a run; a step's does not. Getting this backwards
// costs in both directions — it stopped early, or it kept asking for work
// that was finished.
{
  assert.equal(saysAllDone("did the lot. DONE"), true);
  assert.equal(saysAllDone("STEP 1 DONE"), false, "a step's verdict is not the goal's");
  assert.equal(saysAllDone("STEP 1 DONE\nSTEP 2 DONE"), false);
  assert.equal(saysAllDone("STEP 1 DONE\nDONE"), true);
  assert.equal(saysAllDone("まだ途中です"), false);
  assert.equal(saysAllDone("すべて完了しました"), true, "完了 ends it too");
  assert.equal(saysAllDone("STEP 2 完了"), false);
  assert.equal(saysAllDone("まだ完了していません"), false, "the negation is read too");
  assert.equal(saysAllDone("未完了の項目があります"), false);
}

// Rendering, and what is left to do.
{
  const tasks = parsePlan("1. write the file\n2. run the program\n3. check the output");
  tasks[0]!.status = "done";
  tasks[1]!.status = "failed";
  tasks[1]!.note = "no compiler";
  assert.equal(remaining(tasks).length, 1);
  const plain = renderPlan(tasks, false);
  assert.ok(plain.includes("✓ 1. write the file"));
  assert.ok(plain.includes("✗ 2. run the program — no compiler"));
  assert.ok(!plain.includes("\x1b["), "colour is opt-in");
  assert.ok(renderPlan(tasks, true).includes("\x1b["));
}

// ===========================================================================
// observations — what a session leaves behind
// ===========================================================================
{
  const { parseObservations, ObservationStore, seedFrom, renderObservations, TYPES } =
    await import("./observations.js");

  // The lines a model is asked for, with the markdown it wraps them in.
  const parsed = parseObservations(
    [
      "こちらが記録です。",
      "OBS decide  browser profiles rotate rather than waiting out the limit",
      "**OBS fix    #settle treated an empty page as a finished one**",
      "- OBS find   the rate limit is keyed on the cookie, not the IP",
      "OBS task   measure what rotation actually buys",
      "OBS nonsense this type does not exist",
      "OBS find   x",
      "just prose about OBS things",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.map((o) => o.type),
    ["decide", "fix", "find", "task"],
    "known types only, markdown stripped, prose ignored",
  );
  assert.equal(parsed[1]?.title, "#settle treated an empty page as a finished one");
  assert.ok(!parsed.some((o) => o.title === "x"), "a title too short to stand alone is dropped");

  // Every type the prompt offers is a type the parser accepts.
  for (const t of TYPES) {
    assert.equal(parseObservations(`OBS ${t} something worth remembering`).length, 1, t);
  }

  // Stored, deduplicated, searched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-obs-"));
  process.env.GAHOOLE_MEMORY_DIR = dir;
  {
    const { ObservationStore: Store } = await import(`./observations.js?${dir}`);
    const store = new Store("smoke") as InstanceType<typeof ObservationStore>;
    const first = store.add("s1", parsed);
    assert.equal(first.length, 4);
    assert.equal(store.add("s2", parsed).length, 0, "the same note is not recorded twice");
    assert.equal(store.all().length, 4);

    assert.equal(store.search("cookie").length, 1, "searched by word");
    assert.equal(store.search("find").length, 1, "or by type");
    assert.equal(store.search("").length, 4);
    assert.equal(store.recent(2).length, 2);

    const ids = new Set(store.all().map((o) => o.id));
    assert.equal(ids.size, 4, "ids are distinct");

    const seed = seedFrom(store.recent(20));
    assert.match(seed, /\[decide\]/);
    assert.match(seed, /cookie, not the IP/);
    assert.equal(seedFrom([]), "", "nothing recorded, nothing to say");

    const shown = renderObservations(store.recent(20), false);
    assert.ok(!shown.includes("\x1b["), "colour is opt-in here too");
    assert.match(renderObservations([], false), /nothing recorded/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GAHOOLE_MEMORY_DIR;
}

// ===========================================================================
// invariants that hold between modules
// ===========================================================================
{
  const { COMPOSER_MAX } = await import("./backends/aimode.js");
  const { TYPES, OBSERVE_PROMPT, OBS_PREFIX, parseObservations } = await import(
    "./observations.js"
  );

  // A message of results has to fit the composer with room for the sentence
  // that follows it. The composer silently drops the rest, and what is at the
  // end is the instruction — so this is the invariant that keeps the model
  // from being handed output with nothing asked of it.
  const worst = formatResults(
    Array.from({ length: 6 }, () => ({
      tool: "read_file",
      outcome: { output: { content: "x".repeat(50_000) } },
    })),
  ).join("\n");
  assert.ok(
    worst.length + 200 < COMPOSER_MAX,
    `results leave room for the instruction (${worst.length} of ${COMPOSER_MAX})`,
  );

  // Every type the model is offered is a type the parser accepts, and every
  // type the parser accepts is one the model is offered. Either half missing
  // means notes are asked for and then dropped, silently.
  for (const t of TYPES) {
    assert.ok(
      OBSERVE_PROMPT.includes(`${OBS_PREFIX} ${t}`),
      `the prompt offers ${t}`,
    );
  }
  const offered = [...OBSERVE_PROMPT.matchAll(new RegExp(`^${OBS_PREFIX} (\\w+)`, "gm"))].map(
    (m) => m[1]!,
  );
  for (const t of offered) {
    assert.ok(TYPES.includes(t as never), `the parser accepts ${t}`);
  }
  // And the prompt's own examples parse, which is the cheapest way to know
  // the shape it describes is the shape it asks for.
  assert.equal(parseObservations(OBSERVE_PROMPT).length, TYPES.length);
}

// ===========================================================================
// the benchmark's own checks
// ===========================================================================
//
// Twice now a task has been marked failed because the check was stricter than
// the prompt: sorted numbers written with commas, and a fix written without
// spaces around the plus. A check that rejects a correct answer measures the
// person who wrote it.
{
  const { TASKS } = await import("./bench-tasks.js");
  const files = new Map<string, string>();
  const read = (f: string) => files.get(f) ?? "";
  const find = (id: string) => {
    const t = TASKS.find((x) => x.id === id);
    assert.ok(t, id);
    return t;
  };

  assert.ok(TASKS.every((t) => t.prompt.length > 10 && t.steps >= 1));
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length, "ids are distinct");

  // Reasoning: the number, however it is written around.
  assert.ok(find("reason/ages").check("12", read));
  assert.ok(find("reason/ages").check("ボブは12歳です。", read));
  assert.ok(!find("reason/ages").check("ボブは11歳です。", read));

  // A correct answer in any reasonable shape.
  files.set("sorted.txt", "1\n3\n5\n9\n");
  assert.ok(find("auto/pipeline").check("", read), "one per line");
  files.set("sorted.txt", "1, 3, 5, 9");
  assert.ok(find("auto/pipeline").check("", read), "commas, which the prompt never forbade");
  files.set("sorted.txt", "[1,3,5,9]");
  assert.ok(find("auto/pipeline").check("", read), "or a printed array");
  files.set("sorted.txt", "9\n5\n3\n1");
  assert.ok(!find("auto/pipeline").check("", read), "but not unsorted");

  files.set("add.js", "function add(a, b) { return a + b; }");
  assert.ok(find("solve/fix").check("", read));
  files.set("add.js", "function add(a,b){return a+b}");
  assert.ok(find("solve/fix").check("", read), "spacing is the author's business");
  files.set("add.js", "function add(a, b) { return a - b; }");
  assert.ok(!find("solve/fix").check("", read), "but the bug is still the bug");

  files.set("greet.txt", "hello gahoole\n");
  assert.ok(find("solve/write").check("", read), "trailing newline is not a failure");
  files.set("greet.txt", "Hello Gahoole");
  assert.ok(!find("solve/write").check("", read), '"exactly" was asked for');

  files.set("count.txt", " 3 \n");
  assert.ok(find("auto/inspect").check("", read));
  files.set("count.txt", "three");
  assert.ok(!find("auto/inspect").check("", read));
}

// ===========================================================================
// streaming: a line is shown once, and only once it is finished
// ===========================================================================
{
  const { LineStream, remainder } = await import("./stream.js");
  const s = new LineStream();

  // The page hands over the whole answer so far, repeatedly. The last line is
  // still being written, so it is held until a newline shows up behind it.
  assert.deepEqual(s.feed("こんに"), [], "a line in progress is not printed");
  assert.deepEqual(s.feed("こんにちは"), []);
  assert.deepEqual(s.feed("こんにちは。\n今日は"), ["こんにちは。"], "now it is finished");
  assert.deepEqual(s.feed("こんにちは。\n今日は晴れ"), [], "and not printed twice");
  assert.deepEqual(s.feed("こんにちは。\n今日は晴れです。\n"), ["今日は晴れです。"]);
  assert.equal(s.started, true);

  // Whatever is left when it stops growing.
  assert.deepEqual(s.finish("こんにちは。\n今日は晴れです。\nでは。"), ["では。"]);
  assert.deepEqual(s.finish("こんにちは。\n今日は晴れです。\nでは。"), [], "and only once");

  // Marker lines are dropped: the call is rendered properly a moment later,
  // and the raw JSON scrolling past means nothing to a person.
  {
    const t = new LineStream();
    const out = t.feed(
      [
        "書き込みます。",
        `${CALL_PREFIX} {"tool":"write_file","input":{"path":"a"}}`,
        "```",
        "hello",
        "```",
        "",
      ].join("\n"),
    );
    assert.deepEqual(out, ["書き込みます。", "```", "hello", "```"]);
  }

  // A reply that shrank is a new reply — the backend diffs against what it has
  // already seen, so the text restarts rather than continuing.
  {
    const t = new LineStream();
    t.feed("ひとつめの答えです。\nふたつめの行。\n");
    assert.deepEqual(t.feed("短い。\n"), ["短い。"], "the count restarts rather than skipping");
  }

  // A new reply inside the same turn: the tool loop asks more than once.
  {
    const t = new LineStream();
    t.feed("読みました。\n");
    t.next();
    assert.deepEqual(t.feed("書きました。\n"), ["書きました。"]);
    t.reset();
    assert.equal(t.started, false);
  }

  // What is left to print is what was not shown, whether or not the final
  // answer agrees with what was streamed.
  assert.equal(remainder("a\nb\nc", ["a", "b"]), "c");
  assert.equal(remainder("a\nb", ["a", "b"]), "", "nothing left is nothing printed");
  assert.equal(remainder("a\nb", []), "a\nb", "and nothing streamed leaves it all");
  assert.equal(
    remainder("最初の返信。\n\n最後の答え。", ["最初の返信。"]),
    "最後の答え。",
    "the gap left behind is closed up",
  );
}

console.log("ok — protocol: calls, bodies, budgets, plans, verdicts");
process.exit(0);
