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
| `npm run smoke:mcp` | MCP connect, namespacing, policy denial | local only |
| `npm run smoke:handoff` | failure classification, digest without a model, carry-over | no |
| `npm run smoke:tools` | marker parsing, denial, iteration cap | no |
| `npm run smoke:spinner` | frames, label changes, sharing the line | no |
| `npm run smoke:aimode` | two real AI Mode turns, context preserved | **yes** |

Measured latency, plain question, no tools: about 3.5s per turn.
| `npm run demo` | a scripted run through every scope, printing the audit trail | local only |

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
than by reading the reply.

| Group | Before | After | Note |
|---|---|---|---|
| reasoning (no tools) | 3/3 | 2/3 | unchanged by the fix; run-to-run variance |
| problem solving | 1/3 | **3/3** | |
| autonomy (dependent steps) | 1–2/3 | **3/3** | 8/8 steps unaided |

The fix came from the per-task detail, not the headline: every failure had
spent **zero tool calls** and answered from reasoning instead of acting.
Reasoning was already 3/3, so the gap was never capability — it was doing
rather than describing. Two changes followed. A turn that reports work while
calling nothing now gets one demand for the real thing, and an autonomous run
that produces no plan asks whether the goal is *actually* met and keeps going
while it is not, rather than accepting the first summary.

The cost is turns: autonomy went from 1 turn and 20s per task to 4.7 turns
and 105s. Each of those turns is a query against a limit of roughly eighty
per ten minutes.

**Read these numbers as nine tasks written by the same person who wrote the
agent.** The same group scored 2/3 and 1/3 on consecutive runs before the
fix, and reasoning scored 3/3 then 2/3 after it with no relevant change in
between — a single pass has an error bar of about a task.

## Storage

The browser profile for the `ai-mode` backend lives in `data/browser-profile`;
deleting it starts over with fresh cookies.

Messages, thread metadata, traces, and eval scores all live in
`data/gahoole.db` (libSQL / SQLite-compatible). One file, no server, survives
restarts. The lifecycle's own audit log is `data/events.jsonl`.

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
| Rate limit | ~77–100 queries per 10–13 min, *silent* | 429 with `retry-after` |

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
