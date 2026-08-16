#!/usr/bin/env node
/**
 * A minimal MCP server over stdio, used to check the whole path end to end:
 * gahoole connects it, the tool shows up namespaced, PreToolUse can gate it,
 * and the model can drive it through the text protocol.
 *
 * One tool, `hello`: spawns a command and returns what it printed. It defaults
 * to echoing "hello", so the happy path needs no arguments.
 *
 * The command runs with `shell: false` and an argv array — a model-supplied
 * string is never handed to a shell, so there is nothing to quote-escape and
 * no `;` or backtick to smuggle through.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const run = promisify(execFile);

const server = new McpServer({ name: "hello", version: "1.0.0" });

server.registerTool(
  "hello",
  {
    title: "Run a command",
    description:
      "Run a command and return its output. With no arguments it prints hello.",
    inputSchema: {
      command: z
        .string()
        .optional()
        .describe("Executable to run. Defaults to echo."),
      args: z
        .array(z.string())
        .optional()
        .describe('Arguments. Defaults to ["hello"].'),
    },
  },
  async ({ command, args }) => {
    const cmd = command ?? "echo";
    const argv = args ?? (command ? [] : ["hello"]);
    try {
      const { stdout, stderr } = await run(cmd, argv, {
        timeout: 10_000,
        maxBuffer: 1 << 20,
      });
      const text = (stdout + stderr).trim();
      return { content: [{ type: "text", text: text || "(no output)" }] };
    } catch (e) {
      return {
        isError: true,
        content: [{ type: "text", text: `failed: ${e.message}` }],
      };
    }
  },
);

await server.connect(new StdioServerTransport());
