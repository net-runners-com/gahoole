/**
 * Reading an answer out of a page, against a fixture instead of against
 * Google.
 *
 * Everything the backend knows about an answer comes through
 * `readConversation`, and every bug that has come out of it was invisible
 * until an answer of the wrong shape arrived — a rendered `<pre>` that
 * `innerText` skips, list numbers drawn by the `<ol>`, a container that has
 * not started filling. The fixture below is shaped like all of them.
 *
 * A real browser, because the thing under test is `innerText`, which is a
 * layout property no stub reproduces. No network: the page is set directly.
 */
import assert from "node:assert/strict";
import { launchPersistentContext } from "cloakbrowser";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readConversation } from "./backends/extract.js";

const CONTAINER = '[data-subtree="aimc"]';

const page1 = `
<div data-subtree="aimc">
  <p>手順は次のとおりです。</p>
  <ol>
    <li>bench-tmp/fizz.cpp を書く</li>
    <li>g++ でコンパイルする</li>
    <li>実行して確認する</li>
  </ol>
  <ul>
    <li>補足のひとつめ</li>
    <li>補足のふたつめ</li>
  </ul>
  <pre><code>#include &lt;iostream&gt;
int main() { std::cout &lt;&lt; "hi"; }</code></pre>
  <a href="https://example.com">出典リンク</a>
  <button>コピー</button>
  <textarea></textarea>
  <div role="dialog">フィードバックをお寄せください</div>
</div>`;

const page2 = `
<div data-subtree="aimc">
  <p>ひとつめの答え。</p>
</div>
<div data-subtree="aimc">
  <p>ふたつめの答え。</p>
</div>`;

const empty = `<div data-subtree="aimc"></div>`;

const nested = `
<div data-subtree="aimc">
  <ol>
    <li>外側のひとつめ
      <ul><li>内側のもの</li></ul>
    </li>
    <li>外側のふたつめ</li>
  </ol>
</div>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-dom-"));
const ctx = (await launchPersistentContext({
  userDataDir: dir,
  headless: true,
})) as any;

try {
  const page = await ctx.newPage();
  // setContent waits for "load", which a stealth browser's about:blank never
  // fires; writing the body directly is enough for a fixture with no assets.
  const read = async (html: string): Promise<string> => {
    await page.evaluate((h: string) => {
      (globalThis as unknown as { document: any }).document.body.innerHTML = h;
    }, html);
    return (await page.evaluate(readConversation, CONTAINER)) as string;
  };

  // --- the shape a plan arrives in -------------------------------------------
  const t = await read(page1);

  assert.match(t, /^1\. bench-tmp\/fizz\.cpp を書く$/m, "ordered items carry their number");
  assert.match(t, /^2\. g\+\+ でコンパイルする$/m);
  assert.match(t, /^3\. 実行して確認する$/m);
  assert.match(t, /^- 補足のひとつめ$/m, "unordered items carry a bullet");

  // The numbers are what an autonomous run's plan is parsed out of, so check
  // the parser agrees rather than only the text.
  const { parsePlan } = await import("./plan.js");
  assert.equal(parsePlan(t).length, 5, "and the plan parser sees every item");

  // --- code survives ----------------------------------------------------------
  assert.match(t, /#include <iostream>/, "angle brackets are not eaten as markup");
  assert.match(t, /```[\s\S]*#include <iostream>[\s\S]*```/, "and arrive fenced");

  // --- noise does not ---------------------------------------------------------
  for (const gone of ["出典リンク", "コピー", "フィードバック"]) {
    assert.ok(!t.includes(gone), `${gone} is hidden before reading`);
  }

  // --- the page is left as it was found --------------------------------------
  const marks = await page.evaluate(() => {
    const d = (globalThis as unknown as { document: any }).document;
    return [...d.querySelectorAll("li")].map((el: any) => el.textContent);
  });
  assert.ok(
    (marks as string[]).every((m) => !/^\d+\. |^- /.test(m)),
    `markers are removed again after reading: ${JSON.stringify(marks)}`,
  );

  // --- several turns are one conversation, in order ---------------------------
  const two = await read(page2);
  assert.ok(
    two.indexOf("ひとつめの答え") < two.indexOf("ふたつめの答え"),
    "containers are joined in document order",
  );

  // --- an empty container reads as empty, and must ---------------------------
  //
  // This is the one that matters most: #settle used to treat "" as a finished
  // answer, so a page that had not started rendering looked exactly like one
  // that had stopped, and the turn failed with "AI Mode returned nothing".
  assert.equal(await read(empty), "", "nothing rendered yet reads as nothing");

  // And a page with no conversation container at all is nothing, rather than
  // the whole document. Reading the body was the fallback, and what it read
  // was the skip link, the composer holding the question that had just been
  // typed, and the chrome around them — printed above the answer whenever a
  // poll landed before the container existed.
  const noContainer = `
    <a href="#main">メイン コンテンツにスキップ</a>
    <div>AI モードの会話: You are running inside a program that can execute tools</div>
    <textarea>おはよう</textarea>`;
  assert.equal(await read(noContainer), "", "no container, no conversation");

  // --- a nested list does not renumber its parent -----------------------------
  const deep = await read(nested);
  assert.match(deep, /^1\. 外側のひとつめ/m);
  assert.match(deep, /^2\. 外側のふたつめ$/m, "the inner list does not shift the outer one");
  assert.match(deep, /- 内側のもの/, "and the inner one is still marked");

  // --- reading twice gives the same answer ------------------------------------
  const again = await read(page1);
  assert.equal(again, t, "reading is not destructive");

  console.log(
    `ok — dom: ${t.split("\n").length} lines read, list markers restored, code fenced, noise dropped`,
  );
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
