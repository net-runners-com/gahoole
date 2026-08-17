/**
 * Profiles. Offline: a stub backend records every prompt it is handed, so
 * what the model would actually receive under each profile is asserted rather
 * than assumed.
 */
import assert from "node:assert/strict";
import { Lifecycle } from "./lifecycle.js";
import { ToolLoop } from "./tool-loop.js";
import { tools as localTools } from "./tools.js";
import {
  DEFAULT_PROFILE,
  findProfile,
  PROFILES,
  profileNames,
  renderProfiles,
  toolsFor,
} from "./profiles.js";

class Stub {
  readonly seen: string[] = [];
  name = "stub";
  reply = "nothing to do here.";
  async ask(prompt: string): Promise<string> {
    this.seen.push(prompt);
    return this.reply;
  }
}

const lifecycle = new Lifecycle();
const p = (name: string) => {
  const found = findProfile(name);
  assert.ok(found, `${name} exists`);
  return found;
};

// --- the catalogue ----------------------------------------------------------
assert.ok(findProfile(DEFAULT_PROFILE), "the default profile is one of them");
assert.deepEqual(profileNames(), ["athena", "pythia", "daedalus", "themis", "argus"]);
// The plain names still resolve, so a script written before the rename works.
for (const [plain, mythic] of [
  ["general", "athena"],
  ["reason", "pythia"],
  ["build", "daedalus"],
  ["research", "argus"],
  ["review", "themis"],
]) {
  assert.equal(findProfile(plain!)?.name, mythic, `${plain} still finds ${mythic}`);
}
assert.equal(findProfile("nonesuch"), undefined);
for (const profile of PROFILES) {
  assert.ok(profile.summary, `${profile.name} says what it is for`);
  assert.ok(profile.rounds >= 1 && profile.steps >= 1, `${profile.name} has budgets`);
  if (profile.name !== DEFAULT_PROFILE) {
    assert.ok(profile.brief && profile.hint, `${profile.name} carries a brief`);
  }
}
assert.match(renderProfiles("daedalus", false), /› daedalus/, "the current one is marked");

// --- tool sets are real, not advisory ---------------------------------------
const all = { ...localTools } as Record<string, unknown>;
assert.deepEqual(Object.keys(toolsFor(p("pythia"), all)), [], "pythia cannot act");
assert.deepEqual(
  Object.keys(toolsFor(p("daedalus"), all)).sort(),
  Object.keys(all).sort(),
  "daedalus gets everything",
);

const argus = toolsFor(p("argus"), all);
for (const denied of ["write_file", "edit_file", "delete_file", "run_command"]) {
  assert.ok(!(denied in argus), `argus cannot ${denied}`);
}
for (const kept of ["read_file", "list_files", "search_files"]) {
  assert.ok(kept in argus, `argus can still ${kept}`);
}

// --- what each profile actually sends ---------------------------------------
{
  // pythia: no tool preamble at all, but the brief still arrives — the whole
  // difference of a no-tool profile lives in the prose.
  const stub = new Stub();
  const loop = new ToolLoop(stub, all, lifecycle);
  loop.use(p("pythia"), toolsFor(p("pythia"), all));
  await loop.ask("2+2は？");
  const first = stub.seen[0]!;
  assert.ok(first.includes("no tools at all"), "the brief is sent");
  assert.ok(first.includes("2+2は？"), "along with the question");
  assert.ok(!first.includes("TOOL_CALL:"), "and no tool protocol");

  // The long brief is sent once; the one-line hint rides on every question.
  await loop.ask("3+3は？");
  const second = stub.seen[1]!;
  assert.ok(!second.includes("no tools at all"), "the brief is not repeated");
  assert.ok(second.includes("No tools this session"), "the hint is");
}

{
  // daedalus: preamble, reminder and hint, and only the tools it is allowed.
  const stub = new Stub();
  const loop = new ToolLoop(stub, all, lifecycle);
  loop.use(p("daedalus"), toolsFor(p("daedalus"), all));
  await loop.ask("hello");
  const sent = stub.seen[0]!;
  assert.ok(sent.includes("TOOL_CALL:"), "the protocol is explained");
  assert.ok(sent.includes("finish things rather than propose"), "so is the brief");
  assert.ok(sent.includes("write_file"), "and write_file is on the list");
}

{
  // argus: the denied tools are absent from the list the model is shown,
  // which is the point — it is not told not to write, it is not offered it.
  const stub = new Stub();
  const loop = new ToolLoop(stub, all, lifecycle);
  loop.use(p("argus"), toolsFor(p("argus"), all));
  await loop.ask("what is in src?");
  const sent = stub.seen[0]!;
  assert.ok(sent.includes("search_files"), "reading tools are offered");
  assert.ok(!/\bwrite_file\(/.test(sent), "writing tools are not");
  assert.ok(!/\bdelete_file\(/.test(sent), "nor deleting");
}

{
  // Switching mid-session re-primes: the next question carries the new rules
  // rather than continuing under the old ones.
  const stub = new Stub();
  const loop = new ToolLoop(stub, all, lifecycle);
  loop.use(p("daedalus"), toolsFor(p("daedalus"), all));
  await loop.ask("one");
  await loop.ask("two");
  assert.ok(!stub.seen[1]!.includes("finish things rather than propose"));

  loop.use(p("argus"), toolsFor(p("argus"), all));
  await loop.ask("three");
  assert.ok(
    stub.seen[2]!.includes("find out and report"),
    "the new brief is sent on the next question",
  );
  assert.equal(Object.keys(loop.tools).length, Object.keys(argus).length);
}

// --- the reviewer is given nothing to go on --------------------------------
//
// What it is worth is exactly that it does not already believe what everyone
// involved believes, and that is only true if nothing was carried in.
{
  const themis = p("themis");
  assert.equal(themis.sealed, true);
  assert.equal(
    PROFILES.filter((x) => x.sealed).length,
    1,
    "and it is the only one — the rest keep their context",
  );

  // A reviewer reads; it does not rewrite the thing it is judging.
  const offered = toolsFor(themis, all);
  for (const denied of ["write_file", "edit_file", "delete_file", "run_command"]) {
    assert.ok(!(denied in offered), `themis cannot ${denied}`);
  }
  assert.ok("read_file" in offered && "search_files" in offered);

  // The brief has to say what makes the judgement worth having.
  assert.match(themis.brief, /never seen before/);
  assert.match(themis.brief, /the code is what\s+is true/);
  assert.match(themis.hint, /did not check/);
}

console.log(
  `ok — profiles: ${PROFILES.length} defined, tool sets enforced, brief once and hint always`,
);
process.exit(0);
