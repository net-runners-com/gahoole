import fs from "node:fs";
import path from "node:path";
import type { Lifecycle } from "../lifecycle.js";
import { mcpServerOf } from "../mcp.js";

const LOG = path.resolve("data/events.jsonl");

/**
 * Every lifecycle event, one JSON object per line. This is the audit trail —
 * it is what the diagram's nesting looks like once it has actually run.
 */
export function registerJsonlLog(lifecycle: Lifecycle): void {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const write = (event: string, data: unknown) => {
    fs.appendFileSync(
      LOG,
      JSON.stringify({ t: new Date().toISOString(), event, ...(data as object) }) +
        "\n",
    );
  };

  lifecycle
    .on("ProcessStart", (e) => write("ProcessStart", e))
    .on("ProcessExit", (e) => write("ProcessExit", e))
    .on("SessionStart", (e) => write("SessionStart", e))
    .on("SessionEnd", (e) => write("SessionEnd", e))
    .on("UserPromptSubmit", (e) => write("UserPromptSubmit", e))
    .on("Stop", (e) => write("Stop", e))
    .on("StopFailure", (e) =>
      write("StopFailure", { ...e, error: e.error.message }),
    )
    .on("PreToolUse", (e) => {
      write("PreToolUse", e);
    })
    .on("PostToolUse", (e) =>
      write("PostToolUse", {
        ...e,
        error: e.error instanceof Error ? e.error.message : e.error,
      }),
    );
}

/** Console tracing that mirrors the nesting of the lifecycle. */
export function registerConsoleTrace(lifecycle: Lifecycle): void {
  lifecycle
    .on("SessionStart", (e) =>
      console.log(
        `\x1b[2m● session ${e.sessionId.slice(0, 8)}${e.source ? ` (${e.source.kind} of ${e.source.from.slice(0, 8)})` : ""}\x1b[0m`,
      ),
    )
    .on("SessionEnd", (e) =>
      console.log(
        `\x1b[2m○ session ${e.sessionId.slice(0, 8)} ended: ${e.reason} · ${e.turns} turns · ${(e.ms / 1000).toFixed(1)}s\x1b[0m`,
      ),
    )
    .on("PreToolUse", (e) => {
      const input = JSON.stringify(e.input) ?? "";
      const shown = input.length > 120 ? `${input.slice(0, 117)}…` : input;
      console.log(`\x1b[2m  ├ ${e.toolName} ${shown}\x1b[0m`);
    })
    .on("PostToolUse", (e) => {
      // A denial arrives here as an ordinary output — surface it as its own
      // outcome rather than letting it read as a successful call.
      const denied = (e.output as { denied?: boolean } | undefined)?.denied;
      const status = e.error ? "failed" : denied ? "denied" : "ok";
      const color = e.error ? "\x1b[31m" : denied ? "\x1b[33m" : "\x1b[2m";
      console.log(`${color}  └ ${e.toolName} ${status} · ${e.ms}ms\x1b[0m`);
    })
    .on("Stop", (e) =>
      console.log(
        `\x1b[2m  turn done · ${e.toolCalls} tool calls · ${(e.ms / 1000).toFixed(1)}s\x1b[0m`,
      ),
    )
    .on("StopFailure", (e) =>
      console.error(`\x1b[31m  turn failed: ${e.error.message}\x1b[0m`),
    );
}

/**
 * A PreToolUse hook that can stop a call. This is the one place in the
 * lifecycle where a hook changes the outcome instead of observing it.
 */
/**
 * The reason MCP tools go through the same hook path as local ones: a policy
 * written once applies to third-party tools you did not author and cannot
 * audit line by line.
 *
 * `MCP_ALLOW` / `MCP_DENY` are comma-separated lists of `server` or
 * `server_tool` names. Deny wins; an empty allowlist allows everything.
 */
export function registerMcpPolicy(
  lifecycle: Lifecycle,
  servers: string[],
): void {
  if (servers.length === 0) return;

  const parse = (v?: string) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const allow = parse(process.env.MCP_ALLOW);
  const deny = parse(process.env.MCP_DENY);
  const matches = (list: string[], tool: string, server: string) =>
    list.some((rule) => rule === tool || rule === server);

  lifecycle.on("PreToolUse", (e) => {
    const server = mcpServerOf(e.toolName, servers);
    if (!server) return; // local tool — this policy does not apply
    if (matches(deny, e.toolName, server)) {
      return { deny: `MCP_DENY blocks ${e.toolName}` };
    }
    if (allow.length > 0 && !matches(allow, e.toolName, server)) {
      return { deny: `${e.toolName} is not in MCP_ALLOW` };
    }
  });
}

export function registerWriteGuard(lifecycle: Lifecycle): void {
  lifecycle.on("PreToolUse", (e) => {
    if (e.toolName !== "write_note") return;
    const body = (e.input as { body?: string })?.body ?? "";
    if (body.length > 20_000) {
      return { deny: "note body exceeds 20000 characters" };
    }
  });
}
