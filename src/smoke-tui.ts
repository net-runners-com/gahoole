/**
 * Terminal drawing: printed width, truncation, boxes, and the banner.
 *
 * All of it is arithmetic on strings, and all of it is wrong in the same way
 * if the arithmetic is wrong — a border one cell out, a panel that wraps, a
 * spinner line that scrolls. The panel is full of Japanese in practice, so
 * every case here has a CJK twin.
 */
import assert from "node:assert/strict";
import os from "node:os";
import {
  center,
  pad,
  renderBox,
  stripAnsi,
  truncate,
  width,
  wrap,
} from "./tui.js";
import { banner, readVersion, renderBanner, statusLine } from "./banner.js";

// --- width ------------------------------------------------------------------
assert.equal(width(""), 0);
assert.equal(width("abc"), 3);
assert.equal(width("こんにちは"), 10, "CJK is two cells each");
assert.equal(width("あa"), 3, "mixed");
assert.equal(width("１２３"), 6, "fullwidth digits");
assert.equal(width("한글"), 4, "Hangul");
assert.equal(width("🦉"), 2, "emoji");
assert.equal(width("\x1b[31mred\x1b[0m"), 3, "colour costs nothing");
assert.equal(width("\x1b[1m\x1b[38;5;179mあ\x1b[0m"), 2);
assert.equal(stripAnsi("\x1b[2mdim\x1b[0m"), "dim");

// --- truncate ---------------------------------------------------------------
assert.equal(truncate("abcdef", 10), "abcdef", "short enough is untouched");
for (const [text, max] of [
  ["abcdefghij", 5],
  ["あいうえおかきくけこ", 7],
  ["aあiうe", 4],
  ["\x1b[31mあいうえお\x1b[0m", 6],
] as const) {
  const cut = truncate(text, max);
  assert.ok(width(cut) <= max, `${JSON.stringify(cut)} fits ${max} (${width(cut)})`);
  assert.ok(cut.endsWith("…"), "and says it was cut");
}
// A wide character is never split in half.
assert.ok(!truncate("あいうえお", 5).includes("�"));

// --- pad --------------------------------------------------------------------
assert.equal(width(pad("あ", 6)), 6, "padded by printed width, not length");
assert.equal(width(pad("ab", 6)), 6);
assert.equal(pad("toolong", 3), "toolong", "never truncates");

// --- wrap -------------------------------------------------------------------
{
  const lines = wrap("the quick brown fox jumps over the lazy dog", 12);
  assert.ok(lines.every((l) => width(l) <= 12), lines.join(" | "));
  assert.equal(lines.join(" "), "the quick brown fox jumps over the lazy dog", "nothing lost");

  const jp = wrap("gahoole は このフォルダの mcp.json を読み込みます", 20);
  assert.ok(jp.every((l) => width(l) <= 20), jp.join(" | "));

  // A word longer than the width is left over-long rather than cut: half a
  // path or a URL is worse than a line that sticks out.
  const long = wrap("/Users/someone/a/very/long/path/indeed", 10);
  assert.equal(long.length, 1);
  assert.equal(wrap("", 10).length, 0);
}

// --- renderBox --------------------------------------------------------------
for (const columns of [40, 62, 80, 100, 200]) {
  const box = renderBox({
    title: "gahoole v0.1.0",
    left: ["Welcome back", "", "日本語の行", "\x1b[2mdimmed\x1b[0m"],
    right: ["Getting started", "/help lists the session commands"],
    columns,
    accent: "",
  });
  const lines = box.split("\n");
  const widths = new Set(lines.map((l) => width(l)));
  assert.equal(
    widths.size,
    1,
    `every line of a ${columns}-column box is the same width: ${[...widths].join(",")}`,
  );
  assert.ok([...widths][0]! <= columns, `and none is wider than the terminal`);
  assert.ok(lines[0]!.includes("gahoole v0.1.0"), "the title sits in the top rule");
}

// One column when there is no room to split, and still square.
{
  const narrow = renderBox({ title: "t", left: ["a", "bb"], right: [], columns: 30, accent: "" });
  const widths = new Set(narrow.split("\n").map((l) => width(l)));
  assert.equal(widths.size, 1);
}

// --- center -----------------------------------------------------------------
assert.equal(width(center("ab", 10)) >= 2, true);
assert.equal(center("abcdefghijk", 4), "abcdefghijk", "no room, no padding");

// --- banner -----------------------------------------------------------------
{
  const info = {
    version: "0.1.0",
    model: "google-ai-mode",
    cwd: `${os.homedir()}/work/project`,
    sessionId: "0123456789abcdef",
    tools: 8,
    mcpServers: 1,
    profile: "athena",
    user: "someone",
  };

  // Under 40 columns there is no art, only a name — a banner that wraps is
  // worse than no banner.
  const tiny = renderBanner(info, { columns: 30, color: false });
  assert.ok(!tiny.includes("█"), "no block art in a narrow terminal");
  assert.match(tiny, /gahoole/);

  for (const columns of [40, 62, 80, 96, 120]) {
    const out = renderBanner(info, { columns, color: false });
    const widest = Math.max(...out.split("\n").map((l) => width(l)));
    assert.ok(widest <= columns, `${columns}-column banner does not wrap (${widest})`);
    assert.match(out, /8 tools/);
    assert.match(out, /athena/, "the profile is named");
    assert.match(out, /~\/work\/project/, "the home directory is shortened");
    assert.ok(!out.includes(os.homedir()), "and not printed in full");
    assert.match(out, /01234567/, "the session is identified");
  }

  // The full wordmark only when there is room for it.
  assert.ok(renderBanner(info, { columns: 120, color: false }).includes("██"));
  assert.ok(!renderBanner(info, { columns: 62, color: false }).includes("███████"));

  // Colour is opt-in, and adds nothing to the printed width.
  const plain = renderBanner(info, { columns: 80, color: false });
  const painted = renderBanner(info, { columns: 80, color: true });
  assert.ok(!plain.includes("\x1b["));
  assert.ok(painted.includes("\x1b["));
  assert.equal(width(painted.split("\n")[3] ?? ""), width(plain.split("\n")[3] ?? ""));

  // The status line names what the next question will go to.
  const line = statusLine(info, false);
  assert.match(line, /google-ai-mode/);
  assert.match(line, /athena/);
  assert.match(line, /8 tools/);
  assert.match(line, /session 01234567/);
  assert.ok(!statusLine(info, false).includes("\x1b["));

  // No tools is said, not left blank.
  assert.match(statusLine({ ...info, tools: 0 }, false), /no tools/);
}

// A version, and a real one.
assert.match(readVersion(), /^\d+\.\d+\.\d+/);

// Piped output gets nothing at all, so a redirect stays clean.
{
  const wasTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  assert.equal(
    banner({
      version: "0.1.0",
      model: "m",
      cwd: "/tmp",
      sessionId: "abc",
      tools: 0,
      mcpServers: 0,
    }),
    "",
  );
  Object.defineProperty(process.stdout, "isTTY", { value: wasTTY, configurable: true });
}

console.log("ok — tui: widths, truncation, wrapping, boxes square at 5 widths, banner");
process.exit(0);
