/**
 * Scripted end-to-end run, no API key required.
 *
 * Everything here is the real thing — real sessions, real threads written to
 * libSQL, real MCP tools executed over stdio, real hooks firing in the real
 * dispatcher. The only part that is scripted rather than decided by a model is
 * *which* tool gets called: instead of `agent.generate()` choosing, this file
 * chooses, then drives the identical PreToolUse → execute → PostToolUse path.
 *
 *   npm run demo
 */

import fs from "node:fs";
import { Lifecycle } from "./lifecycle.js";
import { createMemory, createToolHooks } from "./agent.js";
import { Session } from "./session.js";
import { connectMcp } from "./mcp.js";
import { formatSessions, SessionStore } from "./sessions.js";
import { tools as localTools } from "./tools.js";
import {
  registerConsoleTrace,
  registerJsonlLog,
  registerMcpPolicy,
  registerWriteGuard,
} from "./hooks/logging.js";


const LOG = "data/events.jsonl";
fs.rmSync(LOG, { force: true });

const lifecycle = new Lifecycle();
registerJsonlLog(lifecycle);
registerConsoleTrace(lifecycle);
registerWriteGuard(lifecycle);

const opened: string[] = [];
lifecycle.on("SessionStart", (e) => {
  opened.push(e.sessionId);
});

await lifecycle.emit("ProcessStart", {
  pid: process.pid,
  argv: [],
  cwd: process.cwd(),
});

const memory = createMemory();
const resourceId = "demo-user";
const sessions = new SessionStore(memory, resourceId);
sessions.register(lifecycle);
const mcp = await connectMcp();
registerMcpPolicy(lifecycle, mcp.servers);
const hooks = createToolHooks(lifecycle);

const allTools: Record<string, unknown> = { ...localTools, ...mcp.tools };

/**
 * One turn through the real `Session.run()`, with an executor standing in for
 * the model: instead of `agent.generate()` deciding which tools to call, the
 * caller says. Everything else — turn counting, the Stop/StopFailure pair, the
 * hook path each tool takes — is the product's own code.
 */
function turn(
  session: Session,
  prompt: string,
  calls: { tool: string; input: unknown }[],
): Promise<string> {
  console.log(`\n\x1b[1m› ${prompt}\x1b[0m`);
  return session.run(prompt, async () => {
    for (const call of calls) {
      const decision = await hooks.beforeToolCall({
        toolName: call.tool,
        input: call.input,
      });
      if (decision) {
        // Denied: the model would see this object as the tool's result.
        await hooks.afterToolCall({
          toolName: call.tool,
          output: decision.output,
        });
        continue;
      }

      const tool = allTools[call.tool] as
        | { execute?: (input: unknown, ctx?: unknown) => Promise<unknown> }
        | undefined;
      try {
        const output = await tool?.execute?.(call.input, {});
        await hooks.afterToolCall({ toolName: call.tool, output });
      } catch (error) {
        await hooks.afterToolCall({ toolName: call.tool, error });
      }
    }
    return "(the model's reply would go here)";
  });
}

// ── session 1: local tool, then an MCP tool ────────────────────────────────
let session = await Session.start({
  agent: null as never, // unused: this driver never calls generate()
  memory,
  lifecycle,
  resourceId,
});

await turn(session, "save a note about today", [
  { tool: "write_note", input: { name: "demo", body: "# demo\nhello" } },
]);

const listTool = Object.keys(mcp.tools).find((t) => t.endsWith("_list_directory"));
if (listTool) {
  await turn(session, "what's in data/?", [
    { tool: listTool, input: { path: "data" } },
  ]);
}

// ── the PreToolUse guard actually stopping a call ──────────────────────────
await turn(session, "write a huge note", [
  { tool: "write_note", input: { name: "huge", body: "x".repeat(20_001) } },
]);

// ── session 2: fork the thread and keep going ──────────────────────────────
session = await session.fork();
await turn(session, "read the note back", [
  { tool: "read_file", input: { path: "data/notes/demo.md" } },
]);

// ── session 3: clear, then exit ────────────────────────────────────────────
session = await session.clear();
await session.end("exit");
await lifecycle.emit("ProcessExit", { code: 0, sessions: opened });
await mcp.disconnect();

// ── the audit trail this produced ──────────────────────────────────────────
const lines = fs.readFileSync(LOG, "utf8").trim().split("\n");
console.log(`\n\x1b[1m${LOG} — ${lines.length} events\x1b[0m`);
const depth: Record<string, string> = {
  ProcessStart: "",
  ProcessExit: "",
  SessionStart: "  ",
  SessionEnd: "  ",
  UserPromptSubmit: "    ",
  Stop: "    ",
  StopFailure: "    ",
  PreToolUse: "      ",
  PostToolUse: "      ",
};
for (const line of lines) {
  const e = JSON.parse(line) as { event: string; toolName?: string; reason?: string };
  const detail = e.toolName ? ` ${e.toolName}` : e.reason ? ` (${e.reason})` : "";
  console.log(`${depth[e.event] ?? ""}${e.event}${detail}`);
}
console.log("\n\x1b[1msessions\x1b[0m");
console.log(formatSessions(await sessions.list(), session.id));
process.exit(0);
