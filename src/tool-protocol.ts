/**
 * A text protocol for tool use, for backends that have no function calling.
 *
 * AI Mode returns prose and nothing else, so the model is asked to write a
 * marker line when it wants a tool, and gahoole executes it and feeds the
 * result back as the next turn. The marker is plain ASCII on its own line
 * because it has to survive markdown rendering and being read back out of the
 * DOM as `innerText` — anything relying on code fences or unusual characters
 * gets reformatted somewhere along the way.
 *
 *   TOOL_CALL: {"tool":"read_file","input":{"path":"package.json"}}
 *   TOOL_RESULT: {"tool":"read_file","output":{...}}
 *
 * Every parsed call still goes through PreToolUse/PostToolUse, so a policy
 * that blocks a tool blocks it here too — the model asking in prose does not
 * get it past the guard.
 */

export const CALL_PREFIX = "TOOL_CALL:";
export const RESULT_PREFIX = "TOOL_RESULT:";

/** Leaves room for the instruction that follows the result. */
const MAX_RESULT = 6000;

/**
 * Tolerant of the model decorating the line — `**TOOL_CALL:**`, a blockquote,
 * an inline code span, leading indentation. Markdown around the marker is
 * cosmetic; the JSON is the payload.
 */
const CALL_RE = /^[\s>*_`]*TOOL_CALL:[ \t*_`]*(\{.*\})[ \t*_`]*$/gm;

/**
 * Same shape, consuming the line break so removal leaves no blank line behind.
 * Both are greedy to the last brace on the line and never cross one: the
 * protocol requires the JSON on a single line, and a lazy match would stop at
 * the first `}` of a nested object.
 */
const CALL_LINE_RE = /^[\s>*_`]*TOOL_CALL:[ \t*_`]*\{.*\}[ \t*_`]*\n?/gm;

export interface ParsedCall {
  tool: string;
  input: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: string[];
}

/**
 * Best-effort parameter names. Mastra tools carry a zod schema, MCP tools a
 * JSON schema; neither is worth a dependency to render precisely when the
 * consumer is a chat model reading prose.
 */
export function describeTool(name: string, tool: unknown): ToolSpec {
  const t = tool as {
    description?: string;
    inputSchema?: { shape?: Record<string, unknown>; properties?: Record<string, unknown> };
  };
  const shape = t?.inputSchema?.shape ?? t?.inputSchema?.properties;
  return {
    name,
    description: (t?.description ?? "").replace(/\s+/g, " ").trim(),
    params: shape ? Object.keys(shape) : [],
  };
}

export function buildPreamble(tools: ToolSpec[]): string {
  if (tools.length === 0) return "";
  const list = tools
    .map(
      (t) =>
        `- ${t.name}(${t.params.join(", ")})${t.description ? ` — ${t.description}` : ""}`,
    )
    .join("\n");

  return [
    "You are running inside a program that can execute tools for you.",
    "",
    "Available tools:",
    list,
    "",
    "To use one, write a line exactly like this, on its own line, with nothing else on it:",
    `${CALL_PREFIX} {"tool":"<name>","input":{ ... }}`,
    "",
    "Rules:",
    "- Write the line as plain text. Do not put it in a code block, table, or quote.",
    "- The JSON must be valid and on one line.",
    "- Stop after the tool call line and wait. Do not guess what the result will be.",
    `- I will reply with a line starting ${RESULT_PREFIX} containing the output, and then you continue.`,
    "- If no tool is needed, just answer normally and never mention this protocol.",
    "",
    "Acknowledge with one short sentence, then wait for my question.",
  ].join("\n");
}

export function parseCalls(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  for (const m of text.matchAll(CALL_RE)) {
    const json = m[1];
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { tool?: unknown; input?: unknown };
      if (typeof parsed.tool === "string") {
        calls.push({ tool: parsed.tool, input: parsed.input ?? {} });
      }
    } catch {
      // A malformed call is treated as prose; the model gets told below.
    }
  }
  return calls;
}

/** The answer with the marker lines removed, for showing to the user. */
export function stripCalls(text: string): string {
  return text.replace(CALL_LINE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatResult(
  tool: string,
  outcome: { output?: unknown; error?: unknown },
): string {
  const body = outcome.error
    ? { tool, error: String((outcome.error as Error)?.message ?? outcome.error) }
    : { tool, output: outcome.output ?? null };
  let json = JSON.stringify(body);
  // The AI Mode composer caps input at 8192 characters, and the result shares
  // that budget with the follow-up instruction. Truncating here keeps a large
  // file from silently losing its tail inside the page.
  if (json.length > MAX_RESULT) {
    json = `${json.slice(0, MAX_RESULT)}… [truncated]`;
  }
  return `${RESULT_PREFIX} ${json}`;
}
