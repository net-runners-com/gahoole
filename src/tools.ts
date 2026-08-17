import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectDir } from "./paths.js";

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

/**
 * Directories outside the project that may be *read*.
 *
 * A plugin's skills refer to files inside the plugin — a reference document,
 * an example spec, the engine they drive. The first thing the doc-skill
 * plugin does is read its own reference.md, and confining reads to the project
 * root refused it, which makes plugins that ship anything more than prose
 * unusable.
 *
 * Read only, and registered by the program rather than reachable from a
 * prompt: the model cannot widen this, it can only use what the person who
 * installed a plugin already put on their disk.
 */
const READABLE: string[] = [];

export function allowReadRoot(dir: string): void {
  const abs = path.resolve(dir);
  if (!READABLE.includes(abs)) READABLE.push(abs);
}

const within = (target: string, root: string): boolean =>
  target === root || target.startsWith(root + path.sep);

function resolveInRoot(rel: string, mode: "read" | "write" = "write"): string {
  const target = path.resolve(ROOT, rel);
  if (within(target, ROOT)) return target;
  if (mode === "read" && READABLE.some((r) => within(target, r))) return target;
  throw new Error(`path escapes the project root: ${rel}`);
}

/**
 * A path as a person would write it.
 *
 * Relative to the project when it is inside it, and absolute — with the home
 * directory shortened — when it is not. The trash lives under ~/.gahoole now,
 * and a plain `path.relative` rendered it as seven levels of `..` followed by
 * the absolute path anyway.
 */
const rel = (abs: string): string => {
  const inside = path.relative(ROOT, abs);
  if (inside && !inside.startsWith("..")) return inside;
  if (abs === ROOT) return ".";
  const home = os.homedir();
  return abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
};

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
    const text = await fs.readFile(resolveInRoot(p, "read"), "utf8");
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
    /** Read back from disk after writing, not taken from the input. */
    verified: z.boolean(),
  }),
  execute: async ({ path: p, content }) => {
    const target = resolveInRoot(p);
    const created = !(await exists(target));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");

    // Checked, not assumed. A write that reports success for a file that is
    // not there teaches the model it succeeded, and it says so to the user —
    // which is exactly what happened when a fenced block went to the wrong
    // call and a file was created with nothing in it. The size comes from the
    // filesystem so the number in the result is the number on disk.
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) throw new Error(`wrote ${rel(target)} but it is not there`);
    const bytes = Buffer.byteLength(content);
    if (stat.size !== bytes) {
      throw new Error(
        `wrote ${bytes} bytes to ${rel(target)} but it holds ${stat.size}`,
      );
    }
    return { path: rel(target), bytes: stat.size, created, verified: true };
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
  outputSchema: z.object({
    path: z.string(),
    replaced: z.number(),
    verified: z.boolean(),
  }),
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

    // Read back, because "replaced: 1" is a claim about the file and not
    // about the call.
    const after = await fs.readFile(target, "utf8").catch(() => "");
    if (next && !after.includes(next)) {
      throw new Error(`edited ${rel(target)} but the new text is not in it`);
    }
    return { path: rel(target), replaced: 1, verified: true };
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
    const start = resolveInRoot(dir ?? ".", "read");
    const re = pattern ? globToRegExp(pattern) : undefined;
    const found: string[] = [];
    await walk(start, depth ?? 3, re, found);
    return { files: found.slice(0, 200).map(rel), truncated: found.length > 200 };
  },
});

/**
 * Deleting is the one action here with no undo, driven by a model that asked
 * for it in prose. So it does not unlink: it moves the target into
 * `.gahoole/trash/<timestamp>/`, keeping the path it came from. The model is told
 * plainly that this is what "delete" means, and the result says where the file
 * went so a person can put it back.
 */
export const deleteFile = createTool({
  id: "delete_file",
  description:
    "Delete a file by moving it to .gahoole/trash, from where it can be restored. Use when asked to remove a file.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
  }),
  outputSchema: z.object({
    path: z.string(),
    trashed: z.string(),
    /** Confirmed after the move: gone from there, and there to restore. */
    verified: z.boolean(),
  }),
  execute: async ({ path: p }) => {
    const target = resolveInRoot(p);
    if (target === ROOT) throw new Error("refusing to delete the project root");

    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat) throw new Error(`no such file: ${rel(target)}`);
    if (stat.isDirectory()) {
      throw new Error(`${rel(target)} is a directory — delete files individually`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = path.join(projectDir(), "trash", stamp, rel(target));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(target, dest);

    // Both halves checked. "Deleted" is worth nothing if the file is still
    // there, and "recoverable" is worth less than nothing if it is not.
    if (await exists(target)) {
      throw new Error(`${rel(target)} is still there after being deleted`);
    }
    if (!(await exists(dest))) {
      throw new Error(`${rel(target)} was removed but is not in the trash`);
    }
    return { path: rel(target), trashed: rel(dest), verified: true };
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
    const start = resolveInRoot(dir ?? ".", "read");
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
    command: z
      .string()
      .optional()
      .describe("Executable, e.g. g++ or node — or the whole command line"),
    args: z.array(z.string()).optional().describe("Arguments, one per element"),
    // Not documented in the description on purpose: it is here to catch the
    // fenced block a model attaches when it writes the command as a body
    // rather than as JSON, not to invite that.
    content: z.string().optional(),
  }),
  outputSchema: z.object({
    stdout: z.string(),
    stderr: z.string(),
    code: z.number(),
  }),
  execute: async ({ command, args, content }) => {
    // Models write a command line, not an argv. Measured running a plugin
    // skill: five calls in a row arrived as
    // `{"command":"python3 engine/docctl.py check spec.toml"}` or with the
    // line in a fenced block, and all five were refused. Refusing what the
    // model reliably produces is a protocol that does not work.
    //
    // Splitting here is not a shell: quotes group, and nothing else is
    // special. `;` and `|` remain literal arguments, which is the whole point
    // of not having one.
    let line = (command ?? "").trim();
    if (!line && typeof content === "string") line = content.trim();
    if (!line) throw new Error("run_command needs a command");
    let argv = args ?? [];
    if (argv.length === 0 && /\s/.test(line)) {
      const parts = splitCommandLine(line);
      line = parts[0] ?? line;
      argv = parts.slice(1);
    }
    command = line;
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
      const child = execFile(
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
      // Nothing is ever going to be typed at it. A model wrote `-args` where
      // it meant `args`, which launched a bare `python3`, and the interactive
      // interpreter sat waiting on stdin for the full sixty-second timeout.
      // Closing it turns that into an immediate exit.
      child.stdin?.end();
    });
  },
});

/** Kept separate from write_file: notes are the agent's own scratch space. */
export const writeNote = createTool({
  id: "write_note",
  description:
    "Save a note to .gahoole/notes/<name>.md. Use when asked to remember or write something down for later.",
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
    const dir = path.join(projectDir(), "notes");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${safe}.md`);
    await fs.writeFile(target, body, "utf8");
    return { path: rel(target) };
  },
});

/** Directories that are never worth walking and never worth reading. */
const SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "data",
  ".gahoole",
  ".cloakbrowser",
]);

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

/**
 * A command line into an argv, without a shell.
 *
 * Quotes group and are removed; everything else, `;` and `|` and `&&`
 * included, stays a literal argument. A program named `;` does not exist, so
 * the worst a smuggled metacharacter achieves is an argument nobody wanted.
 */
function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
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
