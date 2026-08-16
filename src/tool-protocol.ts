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

/**
 * File contents do not survive JSON written by a language model. Asked to
 * write a C++ program, it produced
 * `{"content":"std::cout << "FizzBuzz\n";"}` — unescaped quotes inside the
 * string, invalid JSON, silently no call. So the JSON carries only short
 * scalars and the payload goes in a delimited block after it, where quotes
 * and newlines need no escaping at all.
 *
 *   TOOL_CALL: {"tool":"write_file","input":{"path":"a.cpp"}}
 *   TOOL_BODY:
 *   #include <iostream>
 *   TOOL_END
 */
export const BODY_PREFIX = "TOOL_BODY:";
export const BODY_SUFFIX = "TOOL_END";

/**
 * ...and the block has to be a fenced one, because plain text is not safe
 * either. The page renders the answer as markdown, so `<iostream>` written in
 * prose is parsed as an unknown HTML element and vanishes before it can be
 * read back — which is why the first C++ file this wrote began `#include `
 * with nothing after it. Inside a code fence the same text survives intact.
 */
const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/;

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

/** A marker line that was meant to be a call but could not be read as one. */
export interface MalformedCall {
  line: string;
  reason: string;
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

/**
 * Wording matters more than length here, and not in the direction you would
 * guess. A terser version of this — same rules, led by a bare
 * `{"tool":"<name>","input":{...}}` template — was refused outright by AI
 * Mode with "この検索に対しては回答することができなかったようです", through
 * both the search URL and the composer, while a plain question from the same
 * profile answered normally. Prose that explains what the program is, with a
 * concrete example instead of an angle-bracket template, is answered. Only
 * tool descriptions are trimmed for length: the first clause carries the
 * signal, the rest is detail the model does not need in order to choose.
 */
export function buildPreamble(tools: ToolSpec[]): string {
  if (tools.length === 0) return "";
  const list = tools
    .map((t) => {
      const gist = t.description.split(/(?<=\.)\s/)[0] ?? "";
      return `- ${t.name}(${t.params.join(", ")}) ${gist}`.trim();
    })
    .join("\n");

  return [
    "You are running inside a program that can execute tools for you.",
    "",
    "Available tools:",
    list,
    "",
    "To use one, write a line on its own that starts with the marker below,",
    "followed by JSON naming the tool and its input:",
    `${CALL_PREFIX} {"tool":"read_file","input":{"path":"README.md"}}`,
    "",
    "Write it as plain text, not in a code block, and end your reply there.",
    "",
    "For file contents, leave `content` out of the JSON and put the text in a",
    "fenced code block on the next line. Quotes, newlines and angle brackets",
    "all survive there, and none of them survive anywhere else:",
    `${CALL_PREFIX} {"tool":"write_file","input":{"path":"main.cpp"}}`,
    "```cpp",
    "#include <iostream>",
    "```",
    `I will reply with a ${RESULT_PREFIX} line containing the output, and then`,
    "you continue. If no tool is needed, just answer normally.",
    "",
    "Two things to get right:",
    "- Do not say you are going to use a tool. Emit the line instead. A reply",
    "  that announces a tool without the line does nothing at all.",
    "- Never write the output of a tool you have not run, and never describe a",
    "  result you have not been given. If you need it, call the tool.",
    "- Keep going until the task is done. Do not stop to ask permission for",
    "  steps the task already implies.",
  ].join("\n");
}

/**
 * A one-line reminder prepended to every question.
 *
 * The preamble alone is not enough on AI Mode: it is a search product, and a
 * question that looks like a topic gets answered from the web several turns
 * after the rules were explained. Restating the rule in the same message as
 * the question is what actually holds.
 */
export function buildReminder(tools: ToolSpec[]): string {
  if (tools.length === 0) return "";
  const names = tools.map((t) => `${t.name}(${t.params.join(",")})`).join(", ");
  return [
    `[Tools you can run here: ${names}.`,
    `If this asks you to create, change, delete, run or inspect anything, you must call a tool — describing it does not do it, and you cannot know a file's contents or a program's output without reading or running it.`,
    `Reply with a single ${CALL_PREFIX} line and nothing else. Do not search the web. If the request is only a question, answer it normally.]`,
  ].join(" ");
}

const BODY_RE = new RegExp(
  `^[\\s>*_\`]*${BODY_PREFIX}[ \\t]*\\n([\\s\\S]*?)\\n[\\s>*_\`]*${BODY_SUFFIX}[ \\t]*$`,
  "m",
);

/** The body block, if the reply carries one: a fence, or the marker pair. */
export function parseBody(text: string): string | undefined {
  return text.match(FENCE_RE)?.[1]?.replace(/\n$/, "") ?? text.match(BODY_RE)?.[1];
}

export function parseCalls(text: string): ParsedCall[] {
  const body = parseBody(text);
  const calls: ParsedCall[] = [];
  for (const m of text.matchAll(CALL_RE)) {
    const json = m[1];
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { tool?: unknown; input?: unknown };
      if (typeof parsed.tool !== "string") continue;
      const input = (parsed.input ?? {}) as Record<string, unknown>;
      // The block supplies the field the model was told to leave out.
      if (body !== undefined && input.content === undefined) input.content = body;
      calls.push({ tool: parsed.tool, input });
    } catch {
      // Reported by parseMalformed rather than swallowed here.
    }
  }
  return calls;
}

/**
 * Marker lines that could not be parsed. Silently treating these as prose is
 * how a turn ends having done nothing while claiming otherwise — the model
 * gets told, and fixes it far more often than not.
 */
export function parseMalformed(text: string): MalformedCall[] {
  const bad: MalformedCall[] = [];
  for (const m of text.matchAll(CALL_RE)) {
    const json = m[1];
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { tool?: unknown };
      if (typeof parsed.tool !== "string") {
        bad.push({ line: json.slice(0, 120), reason: 'no "tool" field' });
      }
    } catch (e) {
      bad.push({ line: json.slice(0, 120), reason: (e as Error).message });
    }
  }
  return bad;
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
