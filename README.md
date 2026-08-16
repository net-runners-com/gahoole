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

### Local file tools

| Tool | What it does |
|---|---|
| `read_file(path, offset, limit)` | Read a file, optionally a range of lines |
| `write_file(path, content)` | Create or replace a file |
| `edit_file(path, old, new)` | Replace an exact string that appears once |
| `list_files(dir, pattern, depth)` | Find what exists before reading it |
| `write_note(name, body)` | The agent's own scratch space under `data/notes` |

Three layers stand between the model and the disk, and they are deliberately
not the same check written three times:

1. **The tools** resolve every path against the project root and refuse to
   leave it. `resolveInRoot` is the only way a string becomes a path, so
   there is one place to get right rather than one per tool.
2. **`registerFileGuard`** refuses with a reason the model reads — outside the
   root, `.env` and `.git` and key files (on read as well as write, since a
   model that can read a secret can repeat it), writes into generated trees,
   and absurd payloads.
3. **Approval** asks a human before anything is written. `GAHOOLE_APPROVE=ask`
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

Its rate limit is the reason the handoff machinery exists: HTTP stays 200 and
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
