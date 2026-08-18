import fs from "node:fs";
import path from "node:path";

/**
 * What file the request asked to end up with, when it named one.
 *
 * Asked for a shift table "エクセルで", one run wrote shift_data.json and
 * stopped — two tool calls, clean exit, no spreadsheet. Nothing caught it:
 * a file was written, so the "nothing happened" nudge stayed quiet, and the
 * only thing wrong was that the file was not the one asked for. Knowing that
 * requires knowing what was asked for, and when the request names a format —
 * エクセル, PDF, CSV — the program can know it without a model.
 *
 * Deliberately deterministic. The local router could classify this, but a
 * format word in the request *is* the classification; a keyword table is
 * free, instant, and testable offline, and a pro reaches for the model only
 * where the rule stops working.
 */
export interface WantedArtifact {
  ext: string;
  /** The word the request used, quoted back in the nudge. */
  word: string;
}

const FORMATS: [RegExp, string][] = [
  [/エクセル|excel|xlsx/gi, ".xlsx"],
  [/パワーポイント|パワポ|powerpoint|pptx/gi, ".pptx"],
  [/ワード文書|docx/gi, ".docx"],
  [/pdf/gi, ".pdf"],
  [/csv/gi, ".csv"],
];

/** Words that ask for something to exist, as opposed to be read or explained. */
const CREATES =
  /作っ|作成|作る|作り|作れ|生成|出力|書き出|にして|に変換|エクスポート|create|generate|make|build|export|convert/i;

export function wantedArtifact(request: string): WantedArtifact | undefined {
  // The hints ride on the question in [brackets], and one of them may name a
  // format — the narrowed skill line says "doc.toml から XLSX を組み立てる".
  // Only the person's own words count.
  const bare = request.replace(/\[[^\]]*\]/g, "");
  if (!CREATES.test(bare)) return undefined;

  // The last format named wins: "CSVをエクセルにして" wants the xlsx, and in
  // an A-to-B sentence B comes second.
  let best: { at: number; word: string; ext: string } | undefined;
  for (const [re, ext] of FORMATS) {
    re.lastIndex = 0;
    for (let m = re.exec(bare); m; m = re.exec(bare)) {
      if (!best || m.index > best.at) best = { at: m.index, word: m[0], ext };
    }
  }
  return best && { ext: best.ext, word: best.word };
}

/**
 * The files of that kind that exist right now, so "did one appear" is a
 * comparison of two snapshots rather than a guess. Snapshots, because the
 * artifact usually arrives from a script the model ran — no write_file call
 * ever names it.
 */
export function artifactsOnDisk(root: string, ext: string, depth = 3): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, left: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (left > 0) walk(p, left - 1);
      } else if (e.name.toLowerCase().endsWith(ext)) {
        found.add(p);
      }
    }
  };
  walk(root, depth);
  return found;
}
