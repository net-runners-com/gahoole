# Gahoole

A local agent that keeps Claude Code's scope model — process, session, turn,
tool call — with everything stored in one SQLite file.

Named for Ga'Hoole, the owls' tree in *Guardians of Ga'Hoole*: a night watch
that keeps records. Spelled without the apostrophe so it survives a package
name.

```
プロセス   起動 ─────────────────────────────────── exit
  └ セッション  SessionStart ──────────────── SessionEnd
      │        （/clear /compact /resume /fork で何度でも張り直される）
      └ ターン   UserPromptSubmit ─────── Stop / StopFailure
          └ ツール呼び出し  PreToolUse ── PostToolUse
```

Each scope opens with exactly one event and closes with exactly one, and an inner
scope never outlives the scope that opened it.

## Setup

```bash
npm install
cp .env.example .env   # set ANTHROPIC_API_KEY
npm run dev            # or: npm link && gahoole
```

| Test | Covers | Network |
|---|---|---|
| `npm run smoke` | hook dispatch, PreToolUse deny, Pre/Post pairing, session store | no |
| `npm run smoke:protocol` | calls, bodies, result budgets, plans, verdicts, the benchmark's own checks | no |
| `npm run smoke:tui` | printed width with CJK, truncation, wrapping, boxes square at five widths, banner | no |
| `npm run smoke:paths` | the slug, one directory per project, settings precedence, the move out of `data/` | no |
| `npm run smoke:core` | backend selection, turn context, hook precedence, audit log, MCP policy, failure classes | no |
| `npm run smoke:tools` | marker parsing, denial, iteration cap, batching, spin detection | no |
| `npm run smoke:files` | the file tools, the guard, approval | no |
| `npm run smoke:trust` | the folder check, inheritance, the record outside the project | no |
| `npm run smoke:profile` | tool sets per profile, brief once and hint always | no |
| `npm run smoke:auto` | plan, steps, discovery, budget, stuck, no-plan | no |
| `npm run smoke:handoff` | failure classification, digest without a model, carry-over | no |
| `npm run smoke:spinner` | frames, label changes, sharing the line | no |
| `npm run smoke:ratelimit` | rotation policy, bounded retries | no |
| `npm run smoke:cli` | the CLI end to end: commands, profiles, approval, sessions, trust, migration | no |
| `npm run smoke:dom` | reading an answer out of real Chromium, against a fixture | local only |
| `npm run smoke:mcp` | MCP connect, namespacing, policy denial | local only |
| `npm run smoke:aimode` | two real AI Mode turns, context preserved | **yes** |
| `npm run canary` | the selectors still resolve and the page still answers | **yes** |

`npm run smoke:offline` runs everything that needs nothing; `npm run smoke:all`
adds the browser. CI runs both on every push.

### Recording a session

A live run costs forty seconds, ten queries against a rate limit, and gives a
different answer each time — which makes it a poor instrument for finding out
why something went wrong.

```bash
GAHOOLE_RECORD=run.jsonl gahoole            # write down every exchange
GAHOOLE_BACKEND=replay GAHOOLE_REPLAY=run.jsonl gahoole   # answer from it
```

Everything above the backend — the tool loop, the nudges, the autonomous loop,
the CLI — then runs for real against real answers, instantly and identically.
A recording is also readable on its own: the bug that had survived a dozen
live runs was three lines into the first one taken, where the answer to a
message of file contents turned out to be six web search results.

If a change alters what would have been asked, replay says so and carries on,
since changing the prompt is usually the point.

None of them need an API key.

## Where each scope lives

| Scope | Implementation | File |
|---|---|---|
| process | the CLI's `main()` | `src/cli.ts` |
| session | one Mastra memory thread | `src/session.ts` |
| turn | one `agent.generate()` call | `src/session.ts` |
| tool call | Mastra's `beforeToolCall` / `afterToolCall` | `src/agent.ts` |

`src/lifecycle.ts` holds the event types and the dispatcher. `src/hooks/logging.ts`
is a worked example of three hooks: a JSONL audit log, a console tracer, and a
PreToolUse guard that blocks a call.

## Hooks

```ts
lifecycle.on("UserPromptSubmit", (e) => console.log(e.prompt));
```

Observer hooks cannot break a turn — one that throws is logged and skipped.
**PreToolUse is the exception**: returning `{ deny: "reason" }` stops the call
before the tool runs. Mastra short-circuits with a synthetic output rather than
throwing, so the model sees the denial as an ordinary tool result and can react
to it.

```ts
lifecycle.on("PreToolUse", (e) => {
  if (e.toolName === "write_note" && tooBig(e.input)) {
    return { deny: "note body exceeds 20000 characters" };
  }
});
```

## MCP

Servers go in `mcp.json`, in the same shape Claude Desktop and Claude Code use —
copy an existing config over unchanged. `${VAR}` in any value is filled from the
environment, so the file can be committed while tokens stay in `.env`.

```json
{
  "mcpServers": {
    "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "./data"] },
    "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } }
  }
}
```

`mcp.json` is gitignored; `mcp.json.example` is the committed template, which
points at `examples/mcp-hello` — a minimal stdio server whose one tool spawns a
command and returns its output (with no arguments, it prints `hello`). It
exists so the whole path can be checked end to end: connect, namespace, gate,
and drive from the model. With no `mcp.json` the agent runs with local tools
only.

**MCP tools take the same hook path as local ones.** They arrive namespaced
`<server>_<tool>` and pass through `PreToolUse`/`PostToolUse` unchanged — which
is the point: a policy written once covers third-party tools you did not author.
`registerMcpPolicy` is the worked example, driven by two env vars:

```bash
MCP_DENY=fs_write_file,fs_edit_file   # deny wins
MCP_ALLOW=fs_read_file,fs_list_directory   # empty = allow all
```

Rules match a whole server (`fs`) or one tool (`fs_write_file`), so a new tool
appearing on a server you denied is denied too.

A server that fails to start is logged and skipped rather than taking the
process down. Connections close on `ProcessExit`.

**A filesystem MCP server pointed at `.` gives the model read and write access to
the whole project.** Scope it to a subdirectory, or use `MCP_DENY`.

## Plugins

Claude Code's layout, read as it is:

```
<plugin>/.claude-plugin/plugin.json   name, description
<plugin>/skills/<name>/SKILL.md       frontmatter, then the instructions
```

Put one in `~/.gahoole/plugins/`, or name it in `settings.json`:

```json
{ "plugins": ["~/work/doc-skill"] }
```

`/plugins` lists what is installed and how to call it; each skill becomes a
command. Reading someone else's format rather than inventing one is the whole
point — a directory that works in Claude Code works here untouched.

A skill is instructions, not code. Invoking one sends its body as the
question, with `$ARGUMENTS` filled in and `${CLAUDE_PLUGIN_ROOT}` pointing at
the plugin, so a skill that says "run `${CLAUDE_PLUGIN_ROOT}/engine/x.py`"
resolves to a path the tools can reach. `allowed-tools` names Claude Code's
tools, which are not this program's, so they are mapped: `Bash` becomes
`run_command`, `Grep` becomes `search_files`, and anything with no equivalent
is dropped rather than guessed at. Honouring the intent of a narrower tool set
matters more than honouring the spelling.

A plugin's own directory is **readable** — a skill that ships a reference
document has to be able to read it — and not writable. Installing a plugin is
not agreeing to have it rewritten.

## Session commands

| Command | Effect |
|---|---|
| `/clear` | end the session, open an empty one |
| `/compact` | summarize the thread, seed a new session with the summary |
| `/fork` | copy the thread (`memory.cloneThread`) and continue on the copy |
| `/resume <id>` | end the session, re-open an existing thread |
| `/sessions` | list stored threads |

All four take the same path — end the current session, start the next one with a
`source` marker naming what it came from — so a hook can always tell why a
session boundary happened.

## Benchmark

`npm run bench` runs nine tasks in three groups, each checked by code rather
than by reading the reply. `npm run duel` runs the *same nine* against Claude
Code as well, so the numbers below come from one task list and one verifier.

| | reason | solve | auto | total | per task | model calls | cost |
|---|---|---|---|---|---|---|---|
| Claude Code · haiku-4.5 | 3/3 | 3/3 | 3/3 | **9/9** | 19.2s | 28 | $0.38 |
| Claude Code · sonnet-5 | 3/3 | 3/3 | 3/3 | **9/9** | 16.6s | 21 | $1.53 |
| Claude Code · opus-5 | 3/3 | 3/3 | 3/3 | **9/9** | 16.8s | 19 | $2.08 |
| gahoole (ai-mode) | 3/3 | 3/3 | 3/3 | **9/9** | 30.2s | 31 | none |

**All four score 9/9, which means the benchmark no longer separates them.**
What it still separates is price and patience: haiku reaches the same score for
a fifth of opus's cost, and gahoole pays in wall clock and queries rather than
dollars.

Read the comparison as **harness plus model, not model**. Claude Code has
native tool calling and a purpose-built Read/Write/Bash toolset; gahoole types
into a browser and parses markers out of rendered prose. The reasoning group is
the only one where the two are close to comparable, because no tools are
involved.

### Getting there in fewer calls

gahoole opened at 42 model calls and now sits at a median of 31 over seven
runs, without losing a task. Every one of those calls is a query against a
rate limit of roughly eighty per ten minutes, so this is the number that
decides how much work fits in a session.

**Read the per-change column below as a direction, not a measurement.** Each
of those rows is a single run, and seven runs of the *same* code came in at
29, 30, 30, 31, 33, 42 and 48 — a spread wider than most of the differences
being attributed. What holds across every run is where the calls go: the
reasoning group costs exactly 3 every time and the problem-solving group 7,
so all of the variance, and all of the room left, is in the autonomous group.

| | change | auto | total |
|---|---|---|---|
| 1 | several tool calls per reply | 32 | 42 |
| 2 | keep the prose from every reply in a turn | 23 | 33 |
| 3 | restore list markers when reading the page | 32 | 42 |
| 4 | let one turn finish several plan steps | 31 | 41 |
| 5 | end the run on the goal's own DONE | **19** | **29** |

A later fix belongs in this list even though it was found by a test rather
than by a stopwatch: the Japanese verdict words could never match, because
`\b完了\b` needs 完了 to be surrounded by ASCII. On a backend that answers in
Japanese, a run could only end by saying DONE in English. The four runs since
came in at 30, 30, 31 and 33, against 29, 42 and 48 before — not faster, but
no longer wandering.

Two of those made it worse before the last one made it better, and both are
worth keeping written down.

**The protocol forbade batching.** It said "reply with a single TOOL_CALL line
and nothing else", so writing a file and running it always cost two round
trips. Replies may now carry as many calls as the next steps need; a fenced
block belongs to the call above it, which is what made more than one possible.

**Only the last reply of a turn survived.** An autonomous run opens by asking
for a numbered plan, and that reply also carries the calls that begin the work
— so the loop ran them, asked for a continuation, and returned the
continuation. The plan never reached the parser. Every autonomous task across
five measured runs reported "no plan came back" for this reason. Prose from
every reply is now kept, except from a reply that had to be nudged: the nudge
fires because that reply claimed work it had not done.

**The numbers were drawn, not written.** With the prose kept, the plan still
did not parse — because AI Mode renders a numbered list as an `<ol>`, and the
"1." is drawn by the list rather than written in the item. Read back as text it
is three bare sentences. The markers are now put back into the DOM before
reading and taken out again after, which is the same class of problem as
`<iostream>` vanishing from a rendered code block.

**Then planning made it slower.** With a plan finally in hand, walking it one
step per turn cost 32 calls against the 23 the same tasks took with no plan at
all — a loop that hands the model one step at a time forbids exactly the
batching that had just been enabled. Asking instead for "everything still
outstanding, as far as one reply can get" helped, but the run still could not
end until every step carried its own `STEP n DONE`. Letting a single
goal-level DONE end the run brought it to 19. The plan is still parsed, still
shown, still what the run is tracked against — it is just not used as a leash.

### What the duel actually found

Two harness bugs, both of which had been quietly costing scores.

`--permission-mode acceptEdits` grants file edits and **not** Bash. Every task
that had to run a program stalled on a permission that headless mode can never
grant, and haiku and sonnet came in at 6/9 — three failures each that were the
harness, not the model. `--allowedTools` fixed it, and the runner now records
`permission_denials` so a refused tool can never again be read as a wrong
answer.

`#settle()` treated an empty page as a finished one. A page that had not
started rendering looks exactly like a page that has stopped: `#waitForGrowth`
gave up at its 8s cap, settle called it done 1.2s later, and `#read` threw
"AI Mode returned nothing" at about 9s. It reproduced three runs out of three
on the two questions Google renders as **math**, which are the slowest to
appear — scoring gahoole 5-6/9 on a transport failure that had nothing to do
with reasoning. One clause fixed it: an empty conversation is never settled.

## Storage

Everything gahoole keeps lives under the home directory, in the shape Claude
Code uses — not beside your code.

```
~/.gahoole/
  trusted.json                    folders you have said yes to
  settings.json                   defaults everywhere
  projects/<slug>/                one directory per project you work in
    gahoole.db                    messages, threads, traces
    events.jsonl                  the lifecycle audit log
    memory/                       what earlier sessions established
    handoff/                      a conversation cut short, waiting
    notes/                        the agent's own scratch space
    trash/                        deleted files, recoverable
    browser-profile-N/            Chromium user data, one per rotation

<project>/.gahoole/settings.json  settings the repository chose to commit
<project>/GAHOOLE.md              instructions for this project
```

A repository is something you clone, share and gitignore; a browser profile
and a database of your conversations are none of those. Keeping them in the
working tree means every project you touch grows a directory you then have to
remember to ignore. The slug is the project's absolute path with its
separators flattened, so two checkouts of the same repository keep their own
histories.

What stays in the repository is what belongs to it: `GAHOOLE.md`, read at
startup the way Claude Code reads `CLAUDE.md`, and any settings someone chose
to commit. Project settings win over global ones; a flag wins over both.

```json
{ "profile": "argus", "approve": "allow", "maxSteps": 40 }
```

`data/` is where all of this used to live. It is moved across on first run,
whole, and the move is announced rather than done quietly.

Deleting `~/.gahoole/projects/<slug>` starts that project over. Deleting
`~/.gahoole` starts everything over, including which folders you trust.

This will not work on a serverless host with an ephemeral filesystem. Swapping
`LibSQLStore` for Turso or Postgres in `src/agent.ts` is the only change needed
if that becomes relevant.

## Backends

The model is pluggable, and the two options are not equivalent.

| | `ai-mode` (default) | `api` |
|---|---|---|
| What it is | Google AI Mode (`udm=50`) driven through a stealth Chromium | Mastra agent on `anthropic/claude-opus-5` |
| Key | none | `ANTHROPIC_API_KEY` |
| Cost | none | per token |
| Tool calling | **no** | yes |
| Rate limit | ~98 queries per profile, *silent* | 429 with `retry-after` |

### What the rate limit actually is

Measured with `npm run ratelimit`, which spends the limit on purpose:

| profile | queries | seconds | ended by |
|---|---|---|---|
| 1 (already part-spent) | 17 | 47 | limit |
| 2 (fresh) | **98** | 288 | limit |
| 3 (fresh) | **99** | 364 | limit |

**A fresh profile is worth about 98 queries, and rotation buys a full
allowance each time** — 99 on the third profile, not a smaller one. That is
what makes long runs possible at all, and it had only ever been assumed.

It is a count, not a rate. The earlier estimate of "77–100 queries per 10–13
minutes" had the count right and the window wrong: at three seconds a query
the same 98 are gone in under five minutes. So waiting does not help and
rotating does, which is what the backend already did — now for a measured
reason rather than a guessed one.

The limit is silent. HTTP stays 200 and the answer is replaced by a short
error string, which is why `BLOCKED` in `aimode.ts` reads the answer rather
than the status.

Select with `GAHOOLE_BACKEND=api`. Both plug into `Session.run()`, so the
lifecycle, hooks, session management and handoff are identical either way.

### Profiles

Claude Code switches between Haiku and Opus. There is nothing to switch to
here — AI Mode is one model behind a browser — so a profile changes the two
things that *are* ours: what the model is told, and what it may reach for.

The names are the constraint, not decoration.

| | | | |
|---|---|---|---|
| `athena` | 均衡 | wisdom, and the owl this program is named after — good at both counsel and craft | every tool · 4 rounds |
| `pythia` | 推論 | the oracle at Delphi: she answers and does nothing else | **no tools** · 1 round |
| `daedalus` | 実装 | the craftsman who built the labyrinth and the wings, and found out which of them flew | every tool · 8 rounds |
| `argus` | 調査 | Panoptes, the hundred-eyed watchman — all eyes, no hands | **read-only** · 6 rounds |

```
gahoole --profile argus         start in one
/profile                        list them, current one marked
/profile daedalus               switch mid-session
GAHOOLE_PROFILE=pythia gahoole
```

The plain names (`general`, `reason`, `build`, `research`) still resolve, so
nothing written before the rename has to be retrained.

The tool set is the half that does the work. A brief saying "do not write
files" is a suggestion; a tool list with no `write_file` in it is not — so
`argus` is not *told* to avoid changing things, it is not offered the means,
and `pythia` genuinely cannot act. The prose only has to describe the shape the
tools already enforce.

Each profile carries a long **brief**, sent once when it becomes active, and a
one-line **hint** restated with every question — AI Mode drops instructions
from earlier turns far more readily than it drops the question in front of it.
Switching mid-session re-primes, so the next question carries the new rules and
the switch itself costs no query. The model-side conversation is left intact.

This has nothing to do with the browser profiles the backend rotates through on
a rate limit; those are Chromium data directories.

### Trusting a folder

The first time gahoole starts in a directory it asks before doing anything
there:

```
────────────────────────────────────────────────────────────────

Accessing workspace:

/Users/you/work/some-repo

Quick safety check: is this a folder you made, or one you trust — your own
code, a well-known open source project, work from your team? …

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel
```

Arrows or `1`/`2` to choose, Enter to confirm, Esc to leave. The check runs
before the memory store is created and before MCP connects, because both of
those act on the folder — `mcp.json` in particular names commands that get
launched, and asking afterwards would be asking after the fact.

The answer is recorded in `~/.gahoole/trusted.json`, deliberately outside every
project: a trust file living inside the folder being judged is written by that
folder, so an untrusted repository could simply ship one saying it is trusted.
Subdirectories inherit the answer — you trust a repository, not each of its
directories.

| | |
|---|---|
| `gahoole --trust` | record this folder without asking |
| `/trust` | list the trusted folders |
| `/trust revoke` | stop trusting this one |

Piped input has nobody to ask, so an untrusted folder is refused rather than
assumed; `--trust` is the way to say it once in a script.

### Local file tools

| Tool | What it does |
|---|---|
| `read_file(path, offset, limit)` | Read a file, optionally a range of lines |
| `write_file(path, content)` | Create or replace a file |
| `edit_file(path, old, new)` | Replace an exact string that appears once |
| `delete_file(path)` | Move a file to `data/trash/<timestamp>/`, recoverable |
| `list_files(dir, pattern, depth)` | Find what exists before reading it |
| `search_files(pattern, dir, glob, regex)` | Search contents; returns `file:line` and the matching line |
| `run_command(command, args)` | Run a program to check its own work |
| `write_note(name, body)` | The agent's own scratch space under `data/notes` |

`list_files` answers *what exists*, `search_files` answers *where is it*. The
search walks rather than shelling out to grep or ripgrep, so it behaves the
same on a machine that has neither, and it skips the same generated trees the
listing skips. It is read-only, so approval does not gate it — which is why it
also skips keys and `credentials.json` itself: the guard checks the directory
being searched, not every file found inside it, and a match line quotes the
contents back.

Three layers stand between the model and the disk, and they are deliberately
not the same check written three times:

1. **The tools** resolve every path against the project root and refuse to
   leave it. `resolveInRoot` is the only way a string becomes a path, so
   there is one place to get right rather than one per tool.
2. **`registerFileGuard`** refuses with a reason the model reads — outside the
   root, `.env` and `.git` and key files (on read as well as write, since a
   model that can read a secret can repeat it), writes into generated trees,
   and absurd payloads.
**Deleting does not unlink.** It is the one action with no undo, asked for in
prose by a model, so `delete_file` moves the target into
`data/trash/<timestamp>/` keeping its original path, and the result says where
it went. The tool description tells the model that is what delete means, so it
does not promise the user more than happened. Directories are refused —
files go one at a time — and a short list of files (`package.json`,
`tsconfig.json`, the tools and the guard itself) is refused outright, because
losing those is how you lose the ability to get anything else back.

3. **Approval** asks a human before anything is written or deleted. At the
   prompt, `y` allows this call, `a` allows that tool for the rest of the
   session, and `A` stops asking entirely. `/approve allow|ask|deny` switches
   it mid-session and `/approve` alone shows the current setting; `gahoole -y`
   starts in allow. Approval time is not counted in a tool's reported
   duration. `GAHOOLE_APPROVE=ask`
   is the default; `allow` skips it, `deny` refuses outright. Reads are never
   asked about — approving each one teaches the habit of saying yes, which is
   the failure this exists to prevent. Answering `a` allows that tool for the
   rest of the session.

```
› tmp-live.txt を作って hello と書いて

  write tmp-live.txt (5 chars)
  allow? [y/N/a] y
  ├ write_file {"path":"tmp-live.txt","content":"hello"}
  └ write_file ok · 8ms
```

### Subagents

`spawn_agent(task)` hands a self-contained task to a second AI Mode
conversation and returns only what it concluded:

```
› tmp-sub.txt の answer の値を subagent に調べさせて
  ├ spawn_agent {"task":"Read tmp-sub.txt and report the value of 'answer'."}
  ↳ subagent: Read tmp-sub.txt and report the value of 'answer'.
  ├ read_file {"path":"tmp-sub.txt"}
  └ read_file ok · 7ms
  ↲ subagent done · 15.1s
  └ spawn_agent ok · 15205ms

tmp-sub.txt に記載されていた answer の値は 42 です。
```

The point is context, not speed: a subagent can read twenty files and report
three sentences, and the parent never carries the twenty files.

It opens a second **tab**, not a second browser — AI Mode keeps its
conversation in the page, but a second Chromium would mean a second profile,
a second login and another 350MB.

Three limits, each for a reason:

- **No recursion.** The child's tool set has `spawn_agent` removed, so a
  runaway cannot spend the rate limit on grandchildren.
- **No parallelism.** Every subagent turn is a query against the same limit;
  two agents racing to spend it finish no sooner than one.
- **No separate policy.** The child's tool calls fire the same PreToolUse and
  PostToolUse, so approval still asks and the guard still refuses. Delegating
  a task is not a way around the rules.

Four subagents per session by default, three tool rounds each.
`GAHOOLE_SUBAGENTS=0` turns the tool off.

### Images

Drag an image into the terminal and ask about it. The path is pulled out of
the line, sent as an attachment, and the rest of the line becomes the question:

```
› '/Users/me/Desktop/screenshot.png' これ何が写ってる？
  attaching 1 image
```

A path only counts if the file exists and has an image extension, so a
sentence that merely names a file is left alone. Attachments cannot ride on a
search URL, so a conversation that opens with one starts from the empty AI
Mode composer instead — still one query.

### Tool use without function calling

AI Mode has no function-calling surface, so tools reach it as a text protocol.
The first turn of a session carries a preamble listing the tools and this
syntax; every answer is then scanned for it:

```
TOOL_CALL: {"tool":"read_file","input":{"path":"package.json"}}
TOOL_RESULT: {"tool":"read_file","output":{"content":"..."}}
```

gahoole parses the call, runs it, and sends the result back as the next turn,
up to four rounds per question. **Parsed calls take the same PreToolUse /
PostToolUse path as native ones**, so a policy that denies a tool denies it
here too — asking in prose does not get past the guard — and a denial is
handed back as the tool's result so the model can choose something else.

The parser tolerates the model decorating the line (`**TOOL_CALL:**`, a
blockquote, an inline code span); the marker is plain ASCII precisely because
it has to survive markdown rendering and being read back out of the DOM.

Two costs worth knowing: each tool call is another round trip, and every round
trip counts against the rate limit; and the composer caps input at 8192
characters, so a large tool result is truncated before it is sent. Set
`GAHOOLE_TOOLS=0` to turn the protocol off and get plain conversation.

### Running past the rate limit

A long run hits the limit — measured at roughly eighty queries per ten
minutes, and an autonomous task can spend six turns. The limit follows the
**session cookie, not the address**: a fresh profile answers immediately while
the blocked one is still refused (measured). So the backend rotates to a new
profile directory and retries, rather than stopping.

| Rotation | What happens |
|---|---|
| 1–2 | new profile, retry at once — seconds |
| 3–6 | new profile, then wait `GAHOOLE_RATE_WAIT_MS` (default 2 min) |
| past 6 | give up; a limit surviving six fresh cookies is not cookie-shaped |

A rotated profile is a new AI Mode thread with no memory of the task, so the
last few exchanges are prepended to the retried prompt. `/auto` runs up to
`GAHOOLE_MAX_STEPS` turns (default 100).

Its rate limit is also why the handoff machinery exists: HTTP stays 200 and
the answer is quietly replaced by a short error string, so the backend detects
it by reading the answer and raises a 429-shaped error that the rest of the
program already knows how to handle.

`/compact` and the handoff summary both go through whichever backend is active
(`src/summarize.ts`), so neither needs an API key. That matters for the handoff
in particular — it exists for the case where the only available model has
stopped answering.

### Why the page and not an HTTP call

AI Mode has no API, and the request the page makes cannot be replayed with a
different question. Measured:

| Request | Result |
|---|---|
| `/search?udm=50` with plain `fetch` | 200, 92 KB — a JS shell with no conversation container and none of the tokens (the browser gets 406 KB) |
| A captured `/async/folif` replayed **unchanged** | 200, 774 KB — the real answer |
| The same URL with only `q` changed | 400 |
| The same URL with only `csui` changed | 400 |

Cookies and headers are fine; the parameters are signed, and the question is
covered by the signature. A captured request can only be replayed as itself, so
driving the page is the only way to ask something new.

## Known limits

- **Tool call ids are synthetic.** Mastra's tool hooks do not expose a tool call
  id, so PreToolUse and PostToolUse are paired by tool name in call order. With
  two concurrent calls to the *same* tool, the reported durations can be swapped
  between them. The events themselves are still correct.
- **A live turn is untested here.** The smoke test covers everything except the
  model call; `npm run dev` with a real key is the first thing that exercises
  `agent.generate()`, `/compact`'s summarization, and the tool hooks under
  Mastra's own runtime.
