/**
 * The local backend, against a stub Ollama.
 *
 * No model is downloaded and none is run: what is under test is the client —
 * the shape of the request, what it does with the reply, and how it behaves
 * when there is nothing listening. That last one matters most, because the
 * common case on any given machine is that there is not.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createOllama, ollamaModel, ollamaReady } from "./backends/ollama.js";

interface Seen {
  model?: string;
  messages?: { role: string; content: string }[];
  stream?: boolean;
}

let seen: Seen = {};
let reply = "まとめました。";
let status = 200;
let tags: string[] = ["qwen3:4b", "embeddinggemma:latest"];

const server = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: tags.map((name) => ({ name })) }));
    return;
  }
  let raw = "";
  req.on("data", (c: Buffer) => (raw += c));
  req.on("end", () => {
    seen = JSON.parse(raw || "{}") as Seen;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      status === 200
        ? JSON.stringify({ message: { role: "assistant", content: reply } })
        : JSON.stringify({ error: "model not found" }),
    );
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const host = `http://127.0.0.1:${port}`;

try {
  // --- is anything there? ------------------------------------------------------
  {
    const ok = await ollamaReady({ host, model: "qwen3:4b" });
    assert.equal(ok.ok, true, ok.why);
    assert.match(ok.why, /qwen3:4b/);

    // A model that is not pulled is named, with what to type.
    const missing = await ollamaReady({ host, model: "nothing-here:1b" });
    assert.equal(missing.ok, false);
    assert.match(missing.why, /ollama pull nothing-here:1b/);

    // `qwen3` means `qwen3:latest`, which is how Ollama names things.
    tags = ["qwen3:latest"];
    assert.equal((await ollamaReady({ host, model: "qwen3" })).ok, true);
    tags = ["qwen3:4b"];

    // Nothing listening at all is the common case, and it is not an error to
    // be thrown at anyone — it is a "no".
    const gone = await ollamaReady({ host: "http://127.0.0.1:1", model: "x" });
    assert.equal(gone.ok, false);
    assert.match(gone.why, /nothing on/);
  }

  // --- asking -------------------------------------------------------------------
  {
    const local = createOllama({ host, model: "qwen3:4b" });
    assert.equal(local.name, "ollama:qwen3:4b");

    const answer = await local.ask("この会話をまとめて");
    assert.equal(answer, "まとめました。");
    assert.equal(seen.model, "qwen3:4b");
    assert.equal(seen.stream, false, "one answer, not a stream");
    assert.deepEqual(seen.messages, [{ role: "user", content: "この会話をまとめて" }]);

    // It keeps its own conversation, so a follow-up needs no history threaded
    // through it.
    await local.ask("もう少し短く");
    assert.equal(seen.messages?.length, 3, "user, assistant, user");
    assert.equal(seen.messages?.[1]?.role, "assistant");

    local.reset?.();
    await local.ask("最初から");
    assert.equal(seen.messages?.length, 1, "and reset starts again");
  }

  // --- what small reasoning models put in front of the answer --------------------
  {
    reply = "<think>ユーザーは要約を求めている。三行で。</think>\n\nOBS find 何かが分かった";
    const local = createOllama({ host, model: "qwen3:4b" });
    const answer = await local.ask("まとめて");
    assert.equal(answer, "OBS find 何かが分かった", "the narration is theirs, not the answer's");
    assert.ok(!answer.includes("<think>"));
  }

  // --- a failure says which model and what it said --------------------------------
  {
    status = 404;
    const local = createOllama({ host, model: "gone:1b" });
    await assert.rejects(() => local.ask("?"), /gone:1b answered 404/);
    status = 200;
    reply = "ok";
  }

  // --- the defaults are named, so they can be pulled without reading the source ---
  assert.match(ollamaModel(), /^\S+:\S+$/);
  {
    const { ollamaHost } = await import("./backends/ollama.js");
    assert.match(ollamaHost(), /^http:\/\/127\.0\.0\.1:\d+$/, "local, and not a guess at a LAN");
    process.env.GAHOOLE_OLLAMA_HOST = "http://elsewhere:1";
    assert.equal(ollamaHost(), "http://elsewhere:1");
    delete process.env.GAHOOLE_OLLAMA_HOST;
  }

  // --- routing a request to a skill --------------------------------------------
//
// Asking the main model to notice a skill reached for one once in four tries,
// and five rewordings of the prompt did not move it. Choosing between a
// handful of one-line descriptions is a classification, not a judgement.
{
  const { chooseSkill, routingPrompt } = await import("./route.js");
  const skills = [
    {
      name: "doc-new",
      description: "データから Excel・Markdown・HTML のレポートを作る。表も作れる。",
      body: "",
      plugin: "doc-skill",
      root: "/tmp/doc-skill",
    },
    {
      name: "doc-build",
      description: "doc.toml から出力を組み立てる。",
      body: "",
      plugin: "doc-skill",
      root: "/tmp/doc-skill",
    },
  ] as never as import("./plugins.js").Skill[];

  // The names and what they are for, and a way to say neither.
  const asked = routingPrompt(skills);
  assert.match(asked, /doc-new/);
  assert.match(asked, /doc-build/);
  assert.match(asked, /none/);

  // The router constrains the reply with a schema, so the stub answers in the
  // shape a constrained model does.
  reply = JSON.stringify({ skill: "doc-new" });
  const hit = await chooseSkill("sales.csv を Excel にして", skills, {
    host,
    model: "qwen3:4b",
  });
  assert.equal(hit.skill?.name, "doc-new");
  assert.equal(seen.messages?.[1]?.content, "sales.csv を Excel にして");

  reply = JSON.stringify({ skill: "doc-build" });
  assert.equal(
    (await chooseSkill("doc.toml から作って", skills, { host, model: "qwen3:4b" })).skill?.name,
    "doc-build",
  );

  // Fails open in every direction, because "no skill" is what happened before
  // this existed and is never the wrong answer.
  reply = JSON.stringify({ skill: "none" });
  const miss = await chooseSkill("おはよう", skills, { host, model: "qwen3:4b" });
  assert.equal(miss.skill, undefined);
  assert.match(miss.why ?? "", /none/);

  // A model that ignored the schema chose nothing, which is the safe answer.
  reply = "そんなスキルはありません";
  assert.equal(
    (await chooseSkill("何か", skills, { host, model: "qwen3:4b" })).skill,
    undefined,
    "an answer that is not one of the names is not a choice",
  );

  reply = JSON.stringify({ skill: "doc-new" });
  assert.equal(
    (await chooseSkill("x", skills, { host: "http://127.0.0.1:1" })).skill,
    undefined,
    "nothing listening is not a choice either",
  );
  assert.equal(
    (await chooseSkill("x", [], { host })).skill,
    undefined,
    "and neither is having no skills",
  );

  process.env.GAHOOLE_ROUTE = "0";
  const off = await chooseSkill("sales.csv を Excel にして", skills, { host });
  assert.equal(off.skill, undefined);
  assert.match(off.why ?? "", /routing off/);
  delete process.env.GAHOOLE_ROUTE;
}

console.log("ok — ollama: readiness, chat, its own history, think tags, failures");
} finally {
  server.close();
}
process.exit(0);
