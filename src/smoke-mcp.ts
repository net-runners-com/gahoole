/**
 * MCP smoke test: connects the servers in mcp.json, checks that their tools
 * arrive namespaced, and drives one through the same PreToolUse path a local
 * tool takes — including a denial from the MCP policy hook.
 *
 * Needs no API key; it never calls the model. Requires whatever mcp.json
 * declares to be launchable (the default entry runs a filesystem server
 * over npx).
 */
import assert from "node:assert/strict";
import { Lifecycle } from "./lifecycle.js";
import { createToolHooks } from "./agent.js";
import { registerMcpPolicy } from "./hooks/logging.js";
import { connectMcp, mcpServerOf } from "./mcp.js";
import { turnStore, type TurnContext } from "./turn-context.js";

const lifecycle = new Lifecycle();
const mcp = await connectMcp();

if (mcp.servers.length === 0) {
  console.log("no MCP servers in mcp.json — nothing to test");
  process.exit(0);
}

const toolNames = Object.keys(mcp.tools);
assert.ok(toolNames.length > 0, "at least one MCP tool");

// listTools() namespaces every tool as `<server>_<tool>`.
for (const name of toolNames) {
  assert.ok(
    mcpServerOf(name, mcp.servers),
    `${name} resolves to one of ${mcp.servers.join(", ")}`,
  );
}

const target = toolNames[0]!;
const server = mcpServerOf(target, mcp.servers)!;

// The policy hook denies by server name, so it covers tools nobody enumerated.
process.env.MCP_DENY = server;
registerMcpPolicy(lifecycle, mcp.servers);

const hooks = createToolHooks(lifecycle);
const ctx: TurnContext = {
  sessionId: "s-mcp",
  turnId: "t-mcp",
  toolCalls: 0,
  pending: new Map(),
};

const post: string[] = [];
lifecycle.on("PostToolUse", (e) => {
  post.push(e.toolName);
});

await turnStore.run(ctx, async () => {
  const denied = await hooks.beforeToolCall({ toolName: target, input: {} });
  assert.equal(denied?.proceed, false, `${target} is denied by server policy`);

  // A local tool is untouched by the MCP policy.
  const local = await hooks.beforeToolCall({
    toolName: "read_file",
    input: { path: "package.json" },
  });
  assert.equal(local, undefined, "local tools bypass the MCP policy");
  await hooks.afterToolCall({ toolName: "read_file", output: {} });
});

assert.deepEqual(post, ["read_file"]);
assert.equal(ctx.toolCalls, 2, "denied calls still count as tool calls");

console.log(
  `ok — ${mcp.servers.length} server(s), ${toolNames.length} tool(s), policy denied ${target}`,
);
await mcp.disconnect();
process.exit(0);
