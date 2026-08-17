/**
 * Which exports no test ever names.
 *
 * Not coverage — a line can be run by a test that was not looking at it, and
 * an export nothing names is an export nobody has an opinion about. This finds
 * those, and fails when the number grows.
 *
 * The allowlist below is the honest part: each name on it is a thing that is
 * exported and untested, with the reason. Adding to it is allowed and visible;
 * a new export that is neither tested nor listed fails the build.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const files = fs
  .readdirSync(here, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(here, f));

const isTest = (f: string): boolean => path.basename(f).startsWith("smoke-");

/**
 * Things with behaviour: functions, values, classes.
 *
 * Not `interface` or `type` — a type is checked by the compiler everywhere it
 * is used, and listing them here would bury the exports that can actually be
 * wrong at runtime under a hundred names that cannot.
 */
const DECL =
  /^export\s+(?:async\s+)?(?:function|const|let|class|enum)\s+([A-Za-z_$][\w$]*)/gm;

interface Exported {
  name: string;
  file: string;
}

const exported: Exported[] = [];
for (const file of files) {
  if (isTest(file)) continue;
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(DECL)) {
    exported.push({ name: m[1]!, file: path.relative(here, file) });
  }
}

// Not this file. ALLOWED's keys are export names, so counting them as
// mentions made every allowlisted export look tested — and the allowlist look
// stale — at the same time.
const self = fileURLToPath(import.meta.url);

const tests = files
  .filter((f) => isTest(f) && f !== self)
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n");

/** Exported, untested, and why. */
const ALLOWED: Record<string, string> = {
  // Single-slot setters for things a browser run reports: a rate limit, a
  // relaunch, a partial answer, an empty one. There is no getter, so nothing
  // is observable without driving a browser.
  onAiModeRateLimit: "only observable during a browser run",
  onAiModeRelaunch: "only observable during a browser run",
  onAiModePartial: "only observable during a browser run",
  onAiModeEmpty: "only observable during a browser run",
};

const named = (name: string): boolean =>
  new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(tests);

const untested = exported.filter((e) => !named(e.name) && !(e.name in ALLOWED));

// An allowlist that outlives its reason is worse than none: it says a thing is
// untested when a test has since been written for it, or when it stopped being
// an export at all.
const stale = Object.keys(ALLOWED).filter((n) => {
  const still = exported.some((e) => e.name === n);
  return !still || named(n);
});
if (stale.length > 0) {
  console.error(
    `ALLOWED lists ${stale.join(", ")}, which a test now names or which is no ` +
      `longer exported — remove them.`,
  );
}
assert.equal(stale.length, 0, "the allowlist has no entries that are covered after all");

if (untested.length > 0) {
  console.error(
    `${untested.length} export${untested.length === 1 ? "" : "s"} no test names:\n` +
      untested.map((e) => `  ${e.file.padEnd(24)} ${e.name}`).join("\n") +
      `\n\nName it in a smoke test, or add it to ALLOWED in ${path.basename(
        fileURLToPath(import.meta.url),
      )} with the reason.`,
  );
}

assert.equal(untested.length, 0, "every export is named by a test, or listed with a reason");

const excused = exported.filter((e) => e.name in ALLOWED).length;
console.log(
  `ok — exports: ${exported.length - excused} of ${exported.length} named by a test, ` +
    `${excused} listed with a reason`,
);
