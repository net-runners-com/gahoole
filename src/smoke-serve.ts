/**
 * The HTTP API, driven the way a client would drive it.
 *
 * No browser and no model: the server is built with a stub `run`, so what is
 * under test is the shape of what goes in and comes out, the queueing, and
 * where it binds.
 */
import assert from "node:assert/strict";
import { createServer, listen, promptFrom } from "./serve.js";

// --- the prompt taken out of a conversation ---------------------------------
//
// Clients send their whole history every time and this has a history of its
// own on the other side, so replaying theirs would say everything twice.
assert.equal(
  promptFrom([
    { role: "user", content: "最初の質問" },
    { role: "assistant", content: "最初の答え" },
    { role: "user", content: "二番目の質問" },
  ]),
  "二番目の質問",
  "only the last user message",
);

assert.equal(
  promptFrom([
    { role: "system", content: "出力は日本語で。" },
    { role: "user", content: "こんにちは" },
  ]),
  "出力は日本語で。\n\nこんにちは",
  "a system message rides along, since that is where instructions go",
);

// Content arrives as a string or as typed parts, depending on the client.
assert.equal(
  promptFrom([
    {
      role: "user",
      content: [
        { type: "text", text: "これを" },
        { type: "image_url", image_url: { url: "http://x" } },
        { type: "text", text: "見て" },
      ],
    },
  ]),
  "これを\n見て",
  "parts are flattened and what is not text is dropped",
);

assert.equal(promptFrom([]), "", "nothing to answer");
assert.equal(promptFrom([{ role: "assistant", content: "ひとりごと" }]), "");

// --- a request in, a completion out -----------------------------------------
const asked: string[] = [];
let answer = "はい。";
let slow = 0;

const server = createServer({
  deps: {
    model: "google-ai-mode+tools",
    session: () => ({ id: "session-1" }) as never,
    run: async (p) => {
      asked.push(p);
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (answer === "THROW") throw new Error("the turn failed");
      return answer;
    },
  },
});
const port = await listen(server, 0, "127.0.0.1");
const base = `http://127.0.0.1:${port}`;

const post = async (body: unknown, path = "/v1/chat/completions") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

try {
  {
    const r = await post({
      model: "gahoole",
      messages: [{ role: "user", content: "こんにちは" }],
    });
    assert.equal(r.status, 200);
    const got = (await r.json()) as {
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
      usage: Record<string, number>;
    };
    assert.equal(got.object, "chat.completion");
    assert.equal(got.model, "google-ai-mode+tools", "the model is named as what it is");
    assert.equal(got.choices[0]?.message.content, "はい。");
    assert.equal(got.choices[0]?.message.role, "assistant");
    assert.equal(got.choices[0]?.finish_reason, "stop");
    assert.equal(got.usage.total_tokens, 0, "tokens are not the unit here, and it says so");
    assert.deepEqual(asked, ["こんにちは"]);
  }

  // --- streaming, in the shape clients parse ---------------------------------
  {
    asked.length = 0;
    answer = "流れてきます。";
    const r = await post({
      stream: true,
      messages: [{ role: "user", content: "おしえて" }],
    });
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await r.text();
    const events = body
      .split("\n\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => l.slice(6));
    assert.equal(events.at(-1), "[DONE]", "and it ends the way clients expect");
    const first = JSON.parse(events[0]!) as {
      object: string;
      choices: { delta: { content?: string } }[];
    };
    assert.equal(first.object, "chat.completion.chunk");
    assert.equal(first.choices[0]?.delta.content, "流れてきます。");
    const last = JSON.parse(events.at(-2)!) as {
      choices: { finish_reason: string }[];
    };
    assert.equal(last.choices[0]?.finish_reason, "stop");
  }

  // --- one at a time ---------------------------------------------------------
  //
  // There is a single browser conversation behind this. Two requests at once
  // would interleave into it, so they queue.
  {
    asked.length = 0;
    answer = "ok";
    slow = 120;
    const order: string[] = [];
    await Promise.all(
      ["A", "B", "C"].map(async (name) => {
        await post({ messages: [{ role: "user", content: name }] });
        order.push(name);
      }),
    );
    slow = 0;
    assert.deepEqual(asked, ["A", "B", "C"], "answered in the order they arrived");
    assert.deepEqual(order, ["A", "B", "C"]);
  }

  // --- what a client gets wrong ----------------------------------------------
  {
    const noUser = await post({ messages: [{ role: "system", content: "x" }] });
    assert.equal(noUser.status, 400);
    assert.match(((await noUser.json()) as { error: { message: string } }).error.message, /no user/);

    const notJson = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{{{",
    });
    assert.equal(notJson.status, 400);

    const wrongRoute = await fetch(`${base}/v1/embeddings`, { method: "POST", body: "{}" });
    assert.equal(wrongRoute.status, 404);
  }

  // --- a failed turn is a 500 with the reason, not a hang --------------------
  {
    answer = "THROW";
    const r = await post({ messages: [{ role: "user", content: "だめなやつ" }] });
    assert.equal(r.status, 500);
    assert.match(
      ((await r.json()) as { error: { message: string } }).error.message,
      /the turn failed/,
    );
    answer = "はい。";
  }

  // --- the catalogue, for clients that ask ------------------------------------
  {
    const r = await fetch(`${base}/v1/models`);
    const got = (await r.json()) as { data: { id: string }[] };
    assert.equal(got.data[0]?.id, "google-ai-mode+tools");

    const health = await fetch(`${base}/health`);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  }

  // --- it is on localhost and not on the network ------------------------------
  //
  // This serves something that writes files and runs commands. Reaching the
  // wider network has to be a decision someone made, not a default.
  {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(
      (address as { address: string }).address,
      "127.0.0.1",
      "bound to loopback",
    );
  }

  console.log("ok — serve: completions, streaming, queueing, errors, loopback only");
} finally {
  server.close();
}
process.exit(0);
