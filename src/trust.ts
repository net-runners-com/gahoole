import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { wrap } from "./tui.js";

/**
 * The folder check that runs before anything else.
 *
 * gahoole reads, writes and executes files in whatever directory it is started
 * from, and it reads `mcp.json` from there too — so launching it inside a
 * folder someone else prepared means running that folder's choices. That is
 * fine in your own repository and not fine in a directory you just cloned to
 * look at. The check costs one keystroke the first time and nothing after.
 *
 * Two decisions worth stating.
 *
 * The record lives in `~/.gahoole/trusted.json`, outside every project. A file
 * inside the folder being judged would be written by the folder itself, which
 * is not a check at all — an untrusted repository could simply ship one saying
 * it is trusted.
 *
 * Trust is inherited by subdirectories. You trust a repository, not each of
 * its directories, and re-asking inside `src/` would train the answer out of
 * anyone.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const AMBER = "\x1b[38;5;179m";
const CYAN = "\x1b[38;5;110m";

const STORE = path.join(os.homedir(), ".gahoole", "trusted.json");

interface Record_ {
  trustedAt: string;
}
type Store = Record<string, Record_>;

function load(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, "utf8")) as unknown;
    return raw && typeof raw === "object" ? (raw as Store) : {};
  } catch {
    return {};
  }
}

/**
 * True when this directory, or any directory above it, has been trusted. The
 * walk stops at the filesystem root, so `/` being trusted would trust
 * everything — which is why nothing here ever offers to trust it.
 */
export function isTrusted(dir: string, store: Store = load()): boolean {
  let cur = path.resolve(dir);
  for (;;) {
    if (store[cur]) return true;
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

export function trust(dir: string): void {
  const store = load();
  store[path.resolve(dir)] = { trustedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);
}

export function untrust(dir: string): boolean {
  const store = load();
  const key = path.resolve(dir);
  if (!store[key]) return false;
  delete store[key];
  fs.writeFileSync(STORE, `${JSON.stringify(store, null, 2)}\n`);
  return true;
}

export const trustedPaths = (): string[] => Object.keys(load()).sort();

const OPTIONS = ["Yes, I trust this folder", "No, exit"];

function render(dir: string, columns: number, color: boolean): string {
  const c = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s);
  const w = Math.min(columns - 2, 96);

  const body = [
    "Quick safety check: is this a folder you made, or one you trust — your own",
    "code, a well-known open source project, work from your team? If not, take a",
    "moment to look at what is in it first.",
    "",
    "gahoole will be able to read, write, delete and run files here, and it will",
    "load this folder's mcp.json if it has one.",
  ].join(" ");

  return [
    c(AMBER, "─".repeat(w)),
    "",
    c(BOLD, "Accessing workspace:"),
    "",
    c(BOLD, dir),
    "",
    ...wrap(body, w),
    "",
  ].join("\n");
}

function options(selected: number, color: boolean): string[] {
  const c = (code: string, s: string) => (color ? `${code}${s}${RESET}` : s);
  return [
    ...OPTIONS.map((label, i) =>
      i === selected
        ? `${c(CYAN, "❯")} ${i + 1}. ${c(CYAN, label)}`
        : `  ${i + 1}. ${label}`,
    ),
    "",
    c(DIM, "Enter to confirm · Esc to cancel"),
  ];
}

/**
 * Read one choice with the arrow keys. Raw mode is entered and left here
 * rather than by the caller, because the CLI opens readline immediately
 * afterwards and a terminal left in raw mode swallows every line it reads.
 */
async function choose(color: boolean): Promise<number> {
  return await new Promise<number>((resolve) => {
    let selected = 0;
    const lines = options(selected, color);
    stdout.write(`${lines.join("\n")}\n`);
    stdout.write("\x1b[?25l");

    const redraw = () => {
      stdout.write(`\x1b[${lines.length}A`);
      for (const line of options(selected, color)) {
        stdout.write(`\x1b[2K${line}\n`);
      }
    };

    const raw = (on: boolean) => {
      // isTTY without setRawMode happens under some launchers and test
      // harnesses; the menu still works from line-buffered input.
      if (typeof stdin.setRawMode === "function") stdin.setRawMode(on);
    };

    const done = (choice: number) => {
      stdin.off("data", onData);
      raw(false);
      stdin.pause();
      stdout.write("\x1b[?25h\n");
      resolve(choice);
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();
      if (key === "\x03" || key === "\x1b" || key === "q") return done(1); // Ctrl-C, Esc
      if (key === "\r" || key === "\n") return done(selected);
      if (key === "1") return done(0);
      if (key === "2") return done(1);
      if (key === "\x1b[A" || key === "k") selected = 0;
      else if (key === "\x1b[B" || key === "j") selected = 1;
      else return;
      redraw();
    };

    raw(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export interface TrustOptions {
  /** `--trust`: record it without asking, for scripts and first runs in CI. */
  assume?: boolean;
  /** Overridable so the tests do not depend on a terminal. */
  ask?: (dir: string) => Promise<boolean>;
}

/**
 * Returns true when the directory may be worked in. Callers exit on false.
 *
 * This has to run before the memory store is created, before MCP connects and
 * before the banner — the first two touch the folder, and there is no point
 * asking whether to trust something after acting on it.
 */
export async function ensureTrusted(
  dir: string,
  opts: TrustOptions = {},
): Promise<boolean> {
  if (isTrusted(dir)) return true;

  if (opts.assume) {
    trust(dir);
    return true;
  }

  const ask = opts.ask ?? defaultAsk;
  if (!stdin.isTTY && !opts.ask) {
    // Nobody to ask. Refusing is the only safe answer, but a script that meant
    // it should be able to say so once rather than be stuck.
    stdout.write(
      `gahoole has not been run in ${dir} before, and there is no terminal to ask.\n` +
        `Start it once interactively, or pass --trust to record it now.\n`,
    );
    return false;
  }

  const yes = await ask(dir);
  if (yes) trust(dir);
  return yes;
}

async function defaultAsk(dir: string): Promise<boolean> {
  const color = !process.env.NO_COLOR;
  const columns = stdout.columns || 80;
  stdout.write(`\n${render(dir, columns, color)}\n`);
  return (await choose(color)) === 0;
}

/** Where the record lives, for `/trust` to print. */
export const trustStorePath = STORE;
