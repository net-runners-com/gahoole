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

/**
 * Deleting is the one action here with no undo, driven by a model that asked
 * for it in prose. So it does not unlink: it moves the target into
 * `data/trash/<timestamp>/`, keeping the path it came from. The model is told
 * plainly that this is what "delete" means, and the result says where the file
 * went so a person can put it back.
 */
export const deleteFile = createTool({
  id: "delete_file",
  description:
    "Delete a file by moving it to data/trash, from where it can be restored. Use when asked to remove a file.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
  }),
  outputSchema: z.object({ path: z.string(), trashed: z.string() }),
  execute: async ({ path: p }) => {
    const target = resolveInRoot(p);
    if (target === ROOT) throw new Error("refusing to delete the project root");

    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) throw new Error(`no such file: ${rel(target)}`);
    if (stat.isDirectory()) {
      throw new Error(`${rel(target)} is a directory — delete files individually`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(ROOT, "data", "trash", stamp, rel(target));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(target, dest);
    return { path: rel(target), trashed: rel(dest) };
  },
});

/**
 * Search file contents.
 *
 * `list_files` answers "what exists"; this answers "where is it". Without it
 * the model reaches for the shell — the screenshot that prompted this shows it
 * trying `pwd` to locate a file it had just written, which failed because pwd
 * was not on the allowlist and would not have answered the question anyway.
 *
 * Implemented by walking rather than shelling out to grep or ripgrep: it has
 * to work the same on a machine that has neither, and the walk already knows
 * which directories are not worth reading.
 */
export const searchFiles = createTool({
  id: "search_files",
  description:
    "Search file contents and return the matching lines with their file and line number. Use to find where something is defined or mentioned, before reading whole files.",
  inputSchema: z.object({
    pattern: z.string().describe("Text to find, or a regular expression"),
    dir: z.string().optional().describe("Where to search; defaults to the project"),
    glob: z.string().optional().describe("Only files matching this, e.g. *.ts"),
    regex: z.boolean().optional().describe("Treat the pattern as a regex"),
  }),
  outputSchema: z.object({
    matches: z.array(z.object({ file: z.string(), line: z.number(), text: z.string() })),
    files: z.number(),
    truncated: z.boolean(),
  }),
  execute: async ({ pattern, dir, glob, regex }) => {
    const re = regex
      ? new RegExp(pattern, "i")
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const start = resolveInRoot(dir ?? ".");
    const candidates: string[] = [];
    await walk(start, 6, glob ? globToRegExp(glob) : undefined, candidates);

    const matches: { file: string; line: number; text: string }[] = [];
    const seen = new Set<string>();
    for (const file of candidates) {
      if (matches.length >= 60) break;
      // The guard checks the directory being searched, not each file found in
      // it. A secret that is not a dotfile — a key, a credentials.json — would
      // otherwise have its contents quoted back in a match line, which is the
      // one way a read-only tool can leak.
      if (SECRET_FILE.test(rel(file))) continue;
      let text: string;
      try {
        const stat = await fs.stat(file);
        if (stat.size > 2_000_000) continue; // not a file anyone greps
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < 60; i++) {
        const line = lines[i]!;
        if (!re.test(line)) continue;
        seen.add(file);
        matches.push({
          file: rel(file),
          line: i + 1,
          text: line.trim().slice(0, 200),
        });
      }
    }
    return { matches, files: seen.size, truncated: matches.length >= 60 };
  },
});

/**
 * Running a command.
 *
 * Without this the model has no way to check its own work, and a model asked
 * to "test it" that cannot run anything will describe a test run it never
 * performed — which is worse than refusing. So it gets to run things, under
 * three restrictions: an allowlist of executables, an argv array with no
 * shell (so there is no `;` or backtick to smuggle anything through), and a
 * timeout. Approval gates it like any other mutating tool.
 */
const ALLOWED = new Set(
  (process.env.GAHOOLE_COMMANDS ??
    "node,npm,npx,python3,python,g++,gcc,clang,clang++,make,cargo,go,tsc,jest,vitest,pytest," +
    "ls,cat,echo,grep,rg,find,git,pwd,wc,head,tail,sort,uniq,diff,file,which,date"
  )
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean),
);

export const runCommand = createTool({
  id: "run_command",
  description:
    "Run a program and return its output. Use to compile, run and test the code you wrote. Give the executable and its arguments separately; there is no shell, so pipes and redirection do not work.",
  inputSchema: z.object({
    command: z.string().describe("Executable, e.g. g++ or node"),
    args: z.array(z.string()).optional().describe("Arguments, one per element"),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    code: z.number(),
  }),
  execute: async ({ command, args }) => {
    const argv = args ?? [];
    // A program the agent just built is not something an allowlist can name
    // in advance, so anything under the project root may be run — the path is
    // still resolved through resolveInRoot, so it cannot point outside. The
    // allowlist governs what may be reached on the wider system.
    const local = command.startsWith("./") || command.startsWith("../");
    const exe = local ? resolveInRoot(command) : command;
    if (!local && !ALLOWED.has(command) && !ALLOWED.has(path.basename(command))) {
      throw new Error(
        `${command} is not allowed. Run programs inside the project as ./name; the allowed system commands are ${[...ALLOWED].slice(0, 8).join(", ")}…`,
      );
    }

    const { execFile } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      execFile(
        exe,
        argv,
        { cwd: ROOT, timeout: 60_000, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          const cap = (t: string) =>
            t.length > 8000 ? `${t.slice(0, 8000)}\n… [truncated]` : t;
          // A non-zero exit is a result, not a failure to report — a failing
          // test is exactly what the model needs to see.
          const code = (err as { code?: number } | null)?.code;
          if (err && code === undefined) return reject(err);
          resolve({ stdout: cap(stdout), stderr: cap(stderr), code: code ?? 0 });
        },
      );
    });
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

/**
 * Secrets that are not dotfiles, and so survive the walk's dot filter. Kept
 * here rather than imported from the guard because the guard imports this file.
 */
const SECRET_FILE = /(\.(pem|key|p12|keystore)$|credentials?\.json$|(^|\/)id_(rsa|ed25519)$)/;

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
  delete_file: deleteFile,
  list_files: listFiles,
  search_files: searchFiles,
  run_command: runCommand,
  write_note: writeNote,
};

/** Tools that change the filesystem — the set approval and guards care about. */
export const MUTATING = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "write_note",
  "run_command",
]);
