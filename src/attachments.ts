import fs from "node:fs";
import path from "node:path";

/**
 * Pull local image paths out of what the user typed.
 *
 * Dragging a file into a terminal pastes its path, usually quoted and often
 * containing spaces and Japanese, so a bare whitespace split does not find it.
 * A path only counts as an attachment if it actually exists — a sentence that
 * merely mentions a filename is left alone.
 */

const IMAGE_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif",
]);

/** Quoted first, so a path with spaces survives; then bare non-space runs. */
const CANDIDATES = [/'([^']+)'/g, /"([^"]+)"/g, /(\S+)/g];

export interface Extracted {
  paths: string[];
  /** The prompt with the attachment paths removed. */
  prompt: string;
}

export function extractAttachments(input: string): Extracted {
  const paths: string[] = [];
  let prompt = input;

  for (const re of CANDIDATES) {
    for (const m of [...prompt.matchAll(re)]) {
      const raw = (m[1] ?? "").trim();
      if (!raw || !IMAGE_EXT.has(path.extname(raw).toLowerCase())) continue;
      const resolved = raw.startsWith("~")
        ? path.join(process.env.HOME ?? "", raw.slice(1))
        : path.resolve(raw);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
      paths.push(resolved);
      prompt = prompt.replace(m[0], " ");
    }
  }

  return { paths, prompt: prompt.replace(/\s+/g, " ").trim() };
}
