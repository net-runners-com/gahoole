import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Startup banner.
 *
 * Three widths, because a banner that wraps is worse than no banner: the full
 * wordmark, a stacked header, and a single line. Anything that is not an
 * interactive terminal gets nothing at all — piping `gahoole` into a file
 * should not produce escape codes and block art.
 *
 * The wordmark is drawn entirely in U+2588 FULL BLOCK, so it renders the same
 * in any monospace font rather than depending on how a given terminal draws
 * punctuation.
 */

const WORDMARK = [
  " ██████   █████  ██   ██  ██████   ██████  ██      ███████",
  "██       ██   ██ ██   ██ ██    ██ ██    ██ ██      ██     ",
  "██   ███ ███████ ███████ ██    ██ ██    ██ ██      █████  ",
  "██    ██ ██   ██ ██   ██ ██    ██ ██    ██ ██      ██     ",
  " ██████  ██   ██ ██   ██  ██████   ██████  ███████ ███████",
];

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const AMBER = "\x1b[38;5;179m";

export interface BannerInfo {
  version: string;
  model: string;
  cwd: string;
  sessionId: string;
  /** How this session came to be, when it is not simply new. */
  origin?: string;
  tools: number;
  mcpServers: number;
}

export function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of ["../package.json", "../../package.json"]) {
      const p = path.resolve(here, candidate);
      if (fs.existsSync(p)) {
        return (JSON.parse(fs.readFileSync(p, "utf8")) as { version?: string })
          .version ?? "0.0.0";
      }
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function colorize(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

export function renderBanner(
  info: BannerInfo,
  opts: { columns: number; color: boolean },
): string {
  const { columns, color } = opts;
  const c = (code: string, text: string) => colorize(color, code, text);

  const facts = [
    `v${info.version}`,
    info.model,
    `${info.tools} tools${info.mcpServers ? ` (${info.mcpServers} mcp)` : ""}`,
    shortenPath(info.cwd),
  ].join(" · ");

  const session = `session ${info.sessionId.slice(0, 8)}${
    info.origin ? ` · ${info.origin}` : ""
  }`;

  // < 40 columns: a single line, no art.
  if (columns < 40) {
    return `${c(BOLD, "gahoole")} ${c(DIM, `v${info.version}`)}\n`;
  }

  // < 72 columns: the wordmark would wrap, so drop to a stacked header.
  if (columns < 72) {
    return (
      [
        c(AMBER, "gahoole"),
        c(DIM, `  v${info.version} · ${info.model}`),
        c(DIM, `  ${shortenPath(info.cwd)}`),
        c(DIM, `  ${session}`),
      ].join("\n") + "\n"
    );
  }

  const art = WORDMARK.map((row) => c(AMBER, row)).join("\n");
  return `${art}\n\n  ${c(DIM, facts)}\n  ${c(DIM, session)}\n`;
}

/** Returns "" when stdout is not a terminal, so piped output stays clean. */
export function banner(info: BannerInfo): string {
  if (!process.stdout.isTTY) return "";
  const color = !process.env.NO_COLOR;
  const columns = process.stdout.columns || 80;
  return renderBanner(info, { columns, color });
}
