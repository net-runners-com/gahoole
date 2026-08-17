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
/** The same, scanning the whole reply so each block can be placed. */
const FENCE_G = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * What all of a message's results may take up together.
 *
 * The composer accepts 8000 characters and silently drops the rest, so this
 * has to leave room for the instruction that follows. It is a budget for the
 * whole message rather than a cap per result, because a reply may now carry
 * several calls and their results travel together: three results capped at
 * 6000 each came to 18000, of which the composer kept the first 8000 — cutting
 * off the instruction at the end and leaving the model holding output with
 * nothing asked of it.
 */
const RESULT_BUDGET = 7000;

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
    // Without this the model spends a turn finding out where it is — the first
    // observed session ran `pwd`, was refused, and fell back to python. Paths
    // are relative to this directory, so it is worth one line to say so.
    `The working directory is ${process.cwd()}. Every path you give a tool is`,
    "relative to it, and nothing outside it can be read or written.",
    "",
    "Available tools:",
    list,
    "",
    "To use one, write a line on its own that starts with the marker below,",
    "followed by JSON naming the tool and its input:",
    `${CALL_PREFIX} {"tool":"read_file","input":{"path":"README.md"}}`,
    "",
    // "End your reply there" and "put the contents in a block on the next
    // line" cannot both be obeyed, and a model asked to write a file obeyed
    // the first: it emitted the call, stopped, and the file was created empty.
    // Twice in a row, with a paragraph of intent in front of each.
    "Write it as plain text, not in a code block. Nothing follows the call",
    "except the block carrying a file's contents, when there is one.",
    "",
    "You may write several of these lines in one reply, and you should whenever",
    "the steps do not need to see each other's output — write a file and run it,",
    "or read two files at once. They run in order and all the results come back",
    "together, which is one round trip instead of three. A code block belongs to",
    "the line directly above it.",
    "",
    "To write a file, put its whole text in `content`:",
    `${CALL_PREFIX} {"tool":"write_file","input":{"path":"hello.py","content":"print(1)"}}`,
    "",
    // The block was the first instruction and the JSON the fallback, on the
    // strength of one C++ file whose quotes broke the JSON. Recordings say
    // that was backwards: every write that worked had its text in `content`,
    // and every call that followed the block instruction arrived as 67
    // characters of call line with no block behind it — three times in a row
    // before the model gave up and blamed the environment.
    "If the text has quotes or backslashes that would break that JSON, leave",
    "`content` out and put the text in a fenced block on the next line",
    "instead. A call with neither writes nothing at all:",
    `${CALL_PREFIX} {"tool":"write_file","input":{"path":"main.cpp"}}`,
    "```cpp",
    'std::cout << "hi\\n";',
    "```",
    `I will reply with a ${RESULT_PREFIX} line containing the output, and then`,
    "you continue. If no tool is needed, just answer normally.",
    "",
    "Two things to get right:",
    "- Do not say you are going to use a tool. Emit the line instead. A reply",
    "  that announces a tool without the line does nothing at all.",
    "- Never write the output of a tool you have not run, and never describe a",
    "  result you have not been given. If you need it, call the tool.",
    "- You have no way to produce a file except through these tools. Asked for",
    "  a spreadsheet, this replied \"Here is your file:\" and described one it",
    "  had made — and there was nothing on disk, because nothing had been",
    "  written. Write the program that makes it, run the program, read what it",
    "  printed.",
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
    `You cannot make a file yourself and there is nothing to attach or download here: a file exists only once ${CALL_PREFIX} write_file has run with its contents in a block below the line.`,
    // "Nothing else" forbade the very block a write needs, and the model
    // obeyed it exactly: three write_file calls in a row, each 67 characters
    // long, each the call line and no contents.
    `Reply with ${CALL_PREFIX} lines — as many as the next steps need, in order — and put a file's text in \`content\`, or in a fenced block under the line when quotes would break the JSON. Nothing besides those. Do not search the web. If the request is only a question, answer it normally.]`,
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

/**
 * Every call in the reply, each with the block that belongs to it.
 *
 * A reply may carry more than one call, and that is the point: every round
 * trip here is a query against the rate limit, so a turn that writes a file
 * and runs it costs one query instead of two. They execute in order and their
 * results come back together.
 *
 * Which block goes with which call is settled by position — a fenced block
 * belongs to the TOOL_CALL line above it, up to the next one. With a single
 * call the question does not arise, and a block written *before* the marker
 * still counts, because models put the code first about as often as last.
 */
export function parseCalls(text: string): ParsedCall[] {
  const found = [...text.matchAll(CALL_RE)];
  const fences = [...text.matchAll(FENCE_G)].map((m) => ({
    at: m.index ?? 0,
    body: (m[1] ?? "").replace(/\n$/, ""),
  }));

  const calls: ParsedCall[] = [];
  for (let i = 0; i < found.length; i++) {
    const m = found[i]!;
    const json = m[1];
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as { tool?: unknown; input?: unknown };
      if (typeof parsed.tool !== "string") continue;
      const input = (parsed.input ?? {}) as Record<string, unknown>;

      const from = m.index ?? 0;
      const until = found[i + 1]?.index ?? Number.POSITIVE_INFINITY;
      const body =
        fences.find((f) => f.at > from && f.at < until)?.body ??
        (found.length === 1 ? parseBody(text) : undefined);

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
  return formatResults([{ tool, outcome }])[0]!;
}

/**
 * Every result in one message, sharing one budget.
 *
 * Small results are never trimmed to make room for a large one — the budget is
 * handed out in equal shares and whatever a result does not use goes back into
 * the pot, so `{"code":0}` alongside a long file costs the file almost
 * nothing.
 *
 * What gets cut is the middle. The end of a compiler's output is where it says
 * what went wrong, and head-only truncation reliably threw away the one line
 * worth reading.
 */
export function formatResults(
  items: { tool: string; outcome: { output?: unknown; error?: unknown } }[],
  budget = RESULT_BUDGET,
): string[] {
  const rendered = items.map(({ tool, outcome }) => {
    const body = outcome.error
      ? { tool, error: String((outcome.error as Error)?.message ?? outcome.error) }
      : { tool, output: prune(outcome.output) ?? null };
    return JSON.stringify(body);
  });

  // The budget is what the message may take up, so it has to pay for the
  // markers and the newlines between them too — nine results overran by
  // exactly their nine prefixes and eight separators before this was counted.
  const perItem = RESULT_PREFIX.length + 1;
  const forJson =
    budget - rendered.length * perItem - Math.max(0, rendered.length - 1);

  const total = rendered.reduce((a, r) => a + r.length, 0);
  if (total > forJson) {
    // Max-min fair shares: hand out the budget smallest-first, and whatever a
    // result does not need is left for the ones that do. Done in one pass —
    // an earlier version grew the share iteratively and diverged, handing out
    // five times the budget on the first case it was given.
    const bySize = rendered
      .map((r, i) => i)
      .sort((a, b) => rendered[a]!.length - rendered[b]!.length);
    const caps = new Array<number>(rendered.length).fill(0);
    let left = Math.max(0, forJson);
    let unset = rendered.length;
    for (const i of bySize) {
      const share = Math.floor(left / unset);
      const take = Math.min(rendered[i]!.length, share);
      caps[i] = take;
      left -= take;
      unset--;
    }
    for (let i = 0; i < rendered.length; i++) {
      if (rendered[i]!.length > caps[i]!) rendered[i] = middleOut(rendered[i]!, caps[i]!);
    }
  }

  return rendered.map((json) => `${RESULT_PREFIX} ${json}`);
}

/** Keep both ends, drop the middle, and say so where the cut was made. */
function middleOut(text: string, max: number): string {
  const note = "… [middle cut] …";
  if (max <= note.length + 40) return `${text.slice(0, max)}…`;
  const keep = max - note.length;
  const head = Math.ceil(keep * 0.6);
  return text.slice(0, head) + note + text.slice(text.length - (keep - head));
}

/** Empty strings carry nothing and cost as much as anything else to send. */
function prune(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const kept = Object.entries(output as Record<string, unknown>).filter(
    ([, v]) => v !== "" && v !== undefined,
  );
  return Object.fromEntries(kept);
}
