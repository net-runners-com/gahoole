import path from "node:path";
import type { Lifecycle } from "../lifecycle.js";
import { MUTATING } from "../tools.js";

/**
 * The PreToolUse guard for the file tools.
 *
 * The tools themselves also confine paths to the project root, deliberately —
 * a guard that is the only check fails open the moment someone adds a tool and
 * forgets to wire it up. This is the layer that can say *no* with a reason the
 * model reads, before anything opens a file.
 *
 * What it refuses:
 *   - anything resolving outside the project root
 *   - secrets and version-control internals, on read as well as write, since
 *     a model that can read .env can also repeat it into a chat window
 *   - writes to directories that are generated rather than authored
 *   - absurd payloads, which are more likely a runaway loop than an intention
 */

const ROOT = process.cwd();

/** Matched against the path relative to the root, with `/` separators. */
const SECRET = [
  /(^|\/)\.env($|\.)/,
  /(^|\/)\.git\//,
  /(^|\/)\.ssh\//,
  /\.(pem|key|p12|keystore)$/,
  /(^|\/)(id_rsa|id_ed25519)$/,
  /credentials?\.json$/,
  /\.npmrc$/,
];

/** Generated trees: writing here is almost always a mistake. */
const GENERATED = [
  /^node_modules\//,
  /^dist\//,
  // gahoole's own directory: the notes are the agent's, the rest is the
  // program's bookkeeping and not something a tool call should be editing.
  /^\.gahoole\/(?!notes\/)/,
  /^data\/(?!notes\/)/,
];

/**
 * Files whose loss would not be recoverable from the trash, because losing
 * them is how you lose everything else too.
 */
const UNDELETABLE = [
  /^package(-lock)?\.json$/,
  /^tsconfig\.json$/,
  /^src\/tools\.ts$/,
  /^src\/hooks\/file-guard\.ts$/,
];

const MAX_WRITE = 500_000;

function relativize(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const abs = path.resolve(ROOT, p);
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

/** Set by the CLI once plugins are loaded; see the note in tools.ts. */
const readable: string[] = [];

export function allowReadOutsideRoot(dir: string): void {
  const abs = path.resolve(dir);
  if (!readable.includes(abs)) readable.push(abs);
}

export function registerFileGuard(lifecycle: Lifecycle): void {
  lifecycle.on("PreToolUse", (e) => {
    const input = (e.input ?? {}) as {
      path?: string;
      dir?: string;
      content?: string;
      new?: string;
    };
    const target = relativize(input.path ?? input.dir);

    if (target !== undefined) {
      if (target.startsWith("..")) {
        // A plugin's own directory is readable, because a skill that ships a
        // reference document has to be able to read it. Writing there is
        // still refused: installing a plugin is not agreeing to have it
        // rewritten.
        const abs = path.resolve(ROOT, (input.path ?? input.dir)!);
        if (!MUTATING.has(e.toolName) && readable.some((r) => abs.startsWith(r + path.sep))) {
          return undefined;
        }
        return { deny: `${input.path ?? input.dir} is outside the project` };
      }
      // An empty relative path is the project root. Reading it is the most
      // ordinary thing there is — `list_files({dir:"."})` is how a session
      // starts — so only the tools that change things are stopped here.
      if (target === "" && MUTATING.has(e.toolName)) {
        return { deny: `${input.path ?? input.dir} is the project root, not a file` };
      }
      if (SECRET.some((re) => re.test(target))) {
        return { deny: `${target} holds credentials or repository internals` };
      }
      if (MUTATING.has(e.toolName) && GENERATED.some((re) => re.test(target))) {
        return { deny: `${target} is generated — edit the source instead` };
      }
      if (e.toolName === "delete_file" && UNDELETABLE.some((re) => re.test(target))) {
        return { deny: `${target} is not something to delete` };
      }
    }

    const size = (input.content ?? input.new ?? "").length;
    if (size > MAX_WRITE) {
      return { deny: `${size} characters is too much to write in one call` };
    }
  });
}
