import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Two tools with different risk profiles, so PreToolUse has something worth
 * deciding about: `read_file` is read-only, `write_note` touches the disk.
 */

const NOTES_DIR = path.resolve("data/notes");

export const readFile = createTool({
  id: "read_file",
  description:
    "Read a UTF-8 text file from the project. Use when the user asks about the contents of a file.",
  inputSchema: z.object({
    path: z.string().describe("Path relative to the project root"),
  }),
  outputSchema: z.object({ content: z.string() }),
  execute: async ({ path: rel }) => {
    // The model chooses this path — confine it to the project root before use.
    const root = process.cwd();
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`path escapes the project root: ${rel}`);
    }
    return { content: await fs.readFile(target, "utf8") };
  },
});

export const writeNote = createTool({
  id: "write_note",
  description:
    "Save a note to data/notes/<name>.md. Use when the user asks to remember or write something down.",
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
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const target = path.join(NOTES_DIR, `${safe}.md`);
    await fs.writeFile(target, body, "utf8");
    return { path: path.relative(process.cwd(), target) };
  },
});

export const tools = { read_file: readFile, write_note: writeNote };
