/**
 * The folder trust check. Offline: the store is redirected to a scratch home
 * and the question is answered by a stub, so the decision path runs without a
 * terminal.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "gahoole-trust-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const { ensureTrusted, isTrusted, trust, untrust, trustedPaths } = await import(
  "./trust.js"
);
const { wrap, width } = await import("./tui.js");

const repo = path.join(HOME, "work", "repo");
const nested = path.join(repo, "src", "deep");
fs.mkdirSync(nested, { recursive: true });

try {
  // --- nothing is trusted to begin with ---------------------------------------
  assert.equal(isTrusted(repo), false);
  assert.deepEqual(trustedPaths(), []);

  // --- answering no does not record anything ----------------------------------
  let asked: string[] = [];
  assert.equal(
    await ensureTrusted(repo, {
      ask: async (d) => {
        asked.push(d);
        return false;
      },
    }),
    false,
  );
  assert.deepEqual(asked, [repo], "asked about the folder it was given");
  assert.equal(isTrusted(repo), false, "a no is not remembered as a yes");

  // --- answering yes records it, and it is never asked again ------------------
  asked = [];
  assert.equal(
    await ensureTrusted(repo, {
      ask: async (d) => {
        asked.push(d);
        return true;
      },
    }),
    true,
  );
  assert.equal(asked.length, 1);
  assert.equal(
    await ensureTrusted(repo, {
      ask: async () => {
        throw new Error("asked twice");
      },
    }),
    true,
  );

  // --- subdirectories inherit it ----------------------------------------------
  assert.equal(isTrusted(nested), true, "trusting a repo trusts its subdirectories");
  assert.equal(
    await ensureTrusted(nested, {
      ask: async () => {
        throw new Error("asked inside a trusted repo");
      },
    }),
    true,
  );

  // --- but a sibling is a different folder ------------------------------------
  const other = path.join(HOME, "work", "other");
  fs.mkdirSync(other, { recursive: true });
  assert.equal(isTrusted(other), false);

  // --- the record lives outside every project ---------------------------------
  const store = path.join(HOME, ".gahoole", "trusted.json");
  assert.ok(fs.existsSync(store), "written to the home directory, not the repo");
  assert.ok(
    !fs.existsSync(path.join(repo, ".gahoole")),
    "nothing is written into the folder being judged",
  );
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(store, "utf8"))), [repo]);

  // --- --trust records without asking -----------------------------------------
  assert.equal(
    await ensureTrusted(other, {
      assume: true,
      ask: async () => {
        throw new Error("asked despite --trust");
      },
    }),
    true,
  );
  assert.equal(isTrusted(other), true);

  // --- revoking asks again next time ------------------------------------------
  assert.equal(untrust(other), true);
  assert.equal(isTrusted(other), false);
  assert.equal(untrust(other), false, "revoking twice is not an error, just false");

  // --- no terminal and no answer means no ------------------------------------
  const fresh = path.join(HOME, "work", "third");
  fs.mkdirSync(fresh, { recursive: true });
  const wasTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  assert.equal(
    await ensureTrusted(fresh),
    false,
    "a pipe cannot be asked, so it is refused rather than assumed",
  );
  assert.equal(isTrusted(fresh), false);
  Object.defineProperty(process.stdin, "isTTY", {
    value: wasTTY,
    configurable: true,
  });

  // --- the panel text wraps to the terminal, measured in printed cells --------
  const lines = wrap("gahoole は このフォルダの mcp.json を読み込みます そして 実行します", 24);
  assert.ok(lines.every((l) => width(l) <= 24), "CJK counts as two cells");
  assert.ok(lines.length > 1);

  console.log(
    `ok — trust: ${trustedPaths().length} recorded, inherited by subdirectories, stored outside the project`,
  );
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
process.exit(0);
