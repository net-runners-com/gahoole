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

  // --- the default is named, so it can be pulled without reading the source -------
  assert.match(ollamaModel(), /^\S+:\S+$/);

  console.log("ok — ollama: readiness, chat, its own history, think tags, failures");
} finally {
  server.close();
}
process.exit(0);
