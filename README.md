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

`npm run smoke` runs the offline checks (hook dispatch, PreToolUse deny,
Pre/Post pairing, libSQL thread persistence) and `npm run smoke:mcp` checks the
MCP path end to end. Neither needs an API key.

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

`mcp.json` is gitignored; `mcp.json.example` is the committed template. With no
`mcp.json` the agent runs with local tools only.

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

Messages, thread metadata, traces, and eval scores all live in
`data/gahoole.db` (libSQL / SQLite-compatible). One file, no server, survives
restarts. The lifecycle's own audit log is `data/events.jsonl`.

This will not work on a serverless host with an ephemeral filesystem. Swapping
`LibSQLStore` for Turso or Postgres in `src/agent.ts` is the only change needed
if that becomes relevant.

## Model

`anthropic/claude-opus-5`, resolved by Mastra from `ANTHROPIC_API_KEY`.
Set in `MODEL` (`src/agent.ts`); `/compact` uses the same model for its
summarization call.

## Known limits

- **Tool call ids are synthetic.** Mastra's tool hooks do not expose a tool call
  id, so PreToolUse and PostToolUse are paired by tool name in call order. With
  two concurrent calls to the *same* tool, the reported durations can be swapped
  between them. The events themselves are still correct.
- **A live turn is untested here.** The smoke test covers everything except the
  model call; `npm run dev` with a real key is the first thing that exercises
  `agent.generate()`, `/compact`'s summarization, and the tool hooks under
  Mastra's own runtime.
