import fs from "node:fs";
import path from "node:path";
import { MCPClient } from "@mastra/mcp";
import type { Lifecycle } from "./lifecycle.js";

/**
 * MCP servers are declared in mcp.json, in the same shape Claude Desktop and
 * Claude Code use, so an existing config can be copied over unchanged:
 *
 *   { "mcpServers": {
 *       "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *       "example":    { "url": "https://mcp.example.com/mcp" }
 *   } }
 *
 * Tools arrive namespaced as `<server>_<tool>`, and they run through the same
 * beforeToolCall / afterToolCall bridge as the local ones — so a PreToolUse
 * hook gates a third-party MCP tool exactly the way it gates `write_note`.
 */

const CONFIG = path.resolve(process.env.MCP_CONFIG ?? "mcp.json");

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
}

type ServerDefinition = NonNullable<
  ConstructorParameters<typeof MCPClient>[0]["servers"]
>[string];

function loadConfig(): Record<string, McpServerEntry> {
  if (!fs.existsSync(CONFIG)) return {};
  const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8")) as {
    mcpServers?: Record<string, McpServerEntry>;
  };
  return raw.mcpServers ?? {};
}

/**
 * `${VAR}` in a config value is replaced from the environment, so mcp.json can
 * be committed while the tokens stay in .env.
 */
function expand(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`mcp.json references unset ${name}`);
    return v;
  });
}

function toDefinition(entry: McpServerEntry): ServerDefinition {
  if (entry.url) {
    return {
      url: new URL(expand(entry.url)),
      ...(entry.headers && {
        requestInit: {
          headers: Object.fromEntries(
            Object.entries(entry.headers).map(([k, v]) => [k, expand(v)]),
          ),
        },
      }),
      ...(entry.timeout && { timeout: entry.timeout }),
    } as ServerDefinition;
  }
  if (!entry.command) {
    throw new Error("mcp.json entry needs either `command` or `url`");
  }
  return {
    command: entry.command,
    args: entry.args ?? [],
    ...(entry.env && {
      env: Object.fromEntries(
        Object.entries(entry.env).map(([k, v]) => [k, expand(v)]),
      ),
    }),
    ...(entry.timeout && { timeout: entry.timeout }),
  } as ServerDefinition;
}

export interface McpBundle {
  tools: Record<string, unknown>;
  servers: string[];
  disconnect: () => Promise<void>;
}

/**
 * Connecting happens once per process. A server that fails to start is reported
 * and skipped — one broken MCP server should not stop the agent from running
 * with the tools that did connect.
 */
export async function connectMcp(lifecycle?: Lifecycle): Promise<McpBundle> {
  const config = loadConfig();
  const names = Object.keys(config);
  if (names.length === 0) {
    return { tools: {}, servers: [], disconnect: async () => {} };
  }

  const servers: Record<string, ServerDefinition> = {};
  for (const [name, entry] of Object.entries(config)) {
    try {
      servers[name] = toDefinition(entry);
    } catch (e) {
      console.error(`[mcp] skipping ${name}: ${(e as Error).message}`);
    }
  }

  const client = new MCPClient({ id: "gahoole-mcp", servers });

  let tools: Record<string, unknown> = {};
  try {
    tools = (await client.listTools()) as Record<string, unknown>;
  } catch (e) {
    console.error(`[mcp] listTools failed: ${(e as Error).message}`);
    await client.disconnect().catch(() => {});
    return { tools: {}, servers: [], disconnect: async () => {} };
  }

  const connected = Object.keys(servers);
  console.log(
    `\x1b[2m[mcp] ${connected.length} server(s), ${Object.keys(tools).length} tool(s): ${Object.keys(tools).join(", ") || "none"}\x1b[0m`,
  );
  lifecycle?.on("ProcessExit", async () => {
    await client.disconnect().catch(() => {});
  });

  return {
    tools,
    servers: connected,
    disconnect: () => client.disconnect(),
  };
}

/** Server name from a namespaced MCP tool name (`github_create_issue` → `github`). */
export function mcpServerOf(
  toolName: string,
  servers: string[],
): string | undefined {
  return servers.find((s) => toolName.startsWith(`${s}_`));
}
