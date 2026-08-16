import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The local file tools.
 *
 * Every path the model supplies is resolved and checked against the project
 * root before anything opens it — `resolveInRoot` is the only way these tools
 * turn a string into a path, so there is one place to get it right rather than
 * one per tool. That is the last line of defence, not the first: the
 * PreToolUse guard in `hooks/file-guard.ts` rejects paths and patterns before
 * a tool ever runs, and approval (when on) asks a human before a write lands.
 */

const ROOT = process.cwd();

function resolveInRoot(rel: string): string {
  const target = path.resolve(ROOT, rel);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes the project root: ${rel}`);
  }
  return target;
}

const rel = (abs: string) => path.relative(ROOT, abs) || ".";

export const readFile = createTool({
  id: "read_file",
  description:
    "Read a UTF-8 text file. Use when you need the contents of a file. Optionally read a range of lines.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
    offset: z.number().int().optional().describe("First line, 1-based"),
    limit: z.number().int().optional().describe("How many lines to read"),
  }),
  outputSchema: z.object({
    content: z.string(),
    lines: z.number(),
    truncated: z.boolean(),
  }),
  execute: async ({ path: p, offset, limit }) => {
    const text = await fs.readFile(resolveInRoot(p), "utf8");
    const all = text.split("\n");
    if (offset === undefined && limit === undefined) {
      // A whole file still has to fit the model's next message.
      const capped = text.length > 40_000;
      return {
        content: capped ? `${text.slice(0, 40_000)}\n… [truncated]` : text,
        lines: all.length,
        truncated: capped,
      };
    }
    const start = Math.max(0, (offset ?? 1) - 1);
    const slice = all.slice(start, start + (limit ?? 200));
    return {
      content: slice.join("\n"),
      lines: all.length,
      truncated: start + slice.length < all.length,
    };
  },
});

export const writeFile = createTool({
  id: "write_file",
  description:
    "Create a file or replace its contents entirely. Use for new files; prefer edit_file to change part of an existing one.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
    content: z.string().describe("The complete new contents"),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytes: z.number(),
    created: z.boolean(),
  }),
  execute: async ({ path: p, content }) => {
    const target = resolveInRoot(p);
    const created = !(await exists(target));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return { path: rel(target), bytes: Buffer.byteLength(content), created };
  },
});

export const editFile = createTool({
  id: "edit_file",
  description:
    "Replace an exact string in a file. The old text must appear exactly once, so include enough context to be unambiguous.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
    old: z.string().describe("Text to replace; must match exactly and once"),
    new: z.string().describe("Replacement text"),
  }),
  outputSchema: z.object({ path: z.string(), replaced: z.number() }),
  execute: async ({ path: p, old, new: next }) => {
    const target = resolveInRoot(p);
    const text = await fs.readFile(target, "utf8");
    const count = text.split(old).length - 1;
    if (count === 0) throw new Error(`no match for that text in ${rel(target)}`);
    if (count > 1) {
      throw new Error(
        `that text appears ${count} times in ${rel(target)} — include more context`,
      );
    }
    await fs.writeFile(target, text.replace(old, next), "utf8");
    return { path: rel(target), replaced: 1 };
  },
});

export const listFiles = createTool({
  id: "list_files",
  description:
    "List files under a directory, optionally filtered by a glob such as *.ts. Use to find out what exists before reading.",
  inputSchema: z.object({
    dir: z.string().optional().describe("Directory, relative to the root"),
    pattern: z.string().optional().describe("Glob applied to the file name"),
    depth: z.number().int().optional().describe("How deep to walk; default 3"),
  }),
  outputSchema: z.object({ files: z.array(z.string()), truncated: z.boolean() }),
  execute: async ({ dir, pattern, depth }) => {
    const start = resolveInRoot(dir ?? ".");
    const re = pattern ? globToRegExp(pattern) : undefined;
    const found: string[] = [];
    await walk(start, depth ?? 3, re, found);
    return { files: found.slice(0, 200).map(rel), truncated: found.length > 200 };
  },
});

/** Kept separate from write_file: notes are the agent's own scratch space. */
export const writeNote = createTool({
  id: "write_note",
  description:
    "Save a note to data/notes/<name>.md. Use when asked to remember or write something down for later.",
  inputSchema: z.object({
    name: z.string().describe("File name without extension"),
    body: z.string().describe("Markdown body of the note"),
  }),
  outputSchema: z.object({ path: z.string() }),
  execute: async ({ name, body }) => {
    const safe = path.basename(name).replace(/[^\w.-]/g, "_");
    if (!safe || safe === "." || safe === "..") {
      throw new Error(`invalid note name: ${name}`);
    }
    const dir = path.join(ROOT, "data", "notes");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${safe}.md`);
    await fs.writeFile(target, body, "utf8");
    return { path: rel(target) };
  },
});

/** Directories that are never worth walking and never worth reading. */
const SKIP = new Set([".git", "node_modules", "dist", "data", ".cloakbrowser"]);

async function walk(
  dir: string,
  depth: number,
  re: RegExp | undefined,
  out: string[],
): Promise<void> {
  if (depth < 0 || out.length > 400) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, depth - 1, re, out);
    else if (!re || re.test(e.name)) out.push(full);
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const tools = {
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_files: listFiles,
  write_note: writeNote,
};

/** Tools that change the filesystem — the set approval and guards care about. */
export const MUTATING = new Set(["write_file", "edit_file", "write_note"]);
