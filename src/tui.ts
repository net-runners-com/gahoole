/**
 * Just enough terminal drawing for the startup panel.
 *
 * No alternate screen and no floating status bar: everything is printed once
 * and scrolls away like ordinary output, so scrollback, copy-paste and piping
 * all keep working. The cost is that the panel does not reflow when the window
 * is resized after launch, which is the right trade for a REPL you scroll.
 */

const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");

/**
 * Printed width. CJK and emoji occupy two cells, and the panel is full of
 * Japanese in practice, so measuring by `.length` misaligns every border.
 */
export function width(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue; // ZWJ, variation
    n += isWide(c) ? 2 : 1;
  }
  return n;
}

function isWide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK radicals … Yi
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK compatibility forms
    (c >= 0xff00 && c <= 0xff60) || // fullwidth forms
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f9ff) // emoji
  );
}

/** Cut to `max` printed cells, keeping escape sequences intact. */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = "";
  let n = 0;
  let i = 0;
  while (i < s.length) {
    const esc = s.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const w = width(ch);
    if (n + w > max - 1) break;
    out += ch;
    n += w;
    i += ch.length;
  }
  return `${out}…`;
}

export const pad = (s: string, to: number): string =>
  s + " ".repeat(Math.max(0, to - width(s)));

export interface BoxOptions {
  title: string;
  left: string[];
  right: string[];
  columns: number;
  /** Border and title colour; empty disables colour. */
  accent?: string;
}

const RESET = "\x1b[0m";

/**
 * A bordered panel with the title sitting in the top rule and two columns
 * divided by a vertical rule — the shape of a terminal agent's welcome screen.
 * Falls back to a single column when there is not enough room to split.
 */
export function renderBox(opts: BoxOptions): string {
  const { title, left, right, columns } = opts;
  const accent = opts.accent ?? "";
  const c = (s: string) => (accent ? `${accent}${s}${RESET}` : s);

  const outer = Math.min(columns - 1, 100);
  const inner = outer - 2; // the two vertical borders
  const split = right.length > 0 && inner >= 60;

  const leftW = split ? Math.floor(inner * 0.42) : inner;
  const rightW = split ? inner - leftW - 3 : 0; // 3 = " │ "

  const top = `${c("╭─")} ${c(title)} ${c("─".repeat(Math.max(0, outer - width(title) - 5)))}${c("╮")}`;
  const bottom = c(`╰${"─".repeat(outer - 2)}╯`);

  const rows: string[] = [];
  const height = split ? Math.max(left.length, right.length) : left.length;
  for (let i = 0; i < height; i++) {
    const l = pad(truncate(left[i] ?? "", leftW - 2), leftW - 2);
    if (!split) {
      rows.push(`${c("│")} ${l} ${c("│")}`);
      continue;
    }
    const r = pad(truncate(right[i] ?? "", rightW), rightW);
    rows.push(`${c("│")} ${l} ${c("│")} ${r} ${c("│")}`);
  }

  return [top, ...rows, bottom].join("\n");
}

/**
 * Break text into lines of at most `w` printed cells, on spaces. A word longer
 * than the width is left over-long rather than cut, since the only things that
 * long are paths and URLs, and half of one of those is useless.
 */
export function wrap(text: string, w: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && width(line) + 1 + width(word) > w) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Centre within `w` printed cells. */
export function center(s: string, w: number): string {
  const gap = Math.max(0, w - width(s));
  return " ".repeat(Math.floor(gap / 2)) + s;
}
