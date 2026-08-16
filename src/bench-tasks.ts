import fs from "node:fs";
import path from "node:path";

/**
 * The tasks, kept apart from the runner so more than one runner can use them.
 *
 * `src/bench.ts` runs them against gahoole. `src/duel.ts` runs the identical
 * prompts against Claude Code as well, which only works if neither runner can
 * quietly reword anything — hence one definition, imported twice.
 *
 * Every task is checked by code. Paths inside a prompt are relative, so the
 * same wording works whatever directory a contender is started in.
 */

export type Group = "reason" | "solve" | "auto";

export interface BenchTask {
  id: string;
  group: Group;
  /** Steps a person would have to take; used for the autonomy score. */
  steps: number;
  prompt: string;
  setup?: (dir: string) => void;
  /** `read` returns the file's contents, or "" if it is not there. */
  check: (answer: string, read: (file: string) => string) => boolean;
}

const has = (answer: string, ...needles: string[]): boolean =>
  needles.some((n) => answer.toLowerCase().includes(n.toLowerCase()));

export const TASKS: BenchTask[] = [
  // --- reasoning: one checkable answer, arrived at in several hops ----------
  {
    id: "reason/ages",
    group: "reason",
    steps: 1,
    prompt:
      "アリスはボブより3歳年上で、ボブはキャロルの2倍の年齢です。3人の年齢の合計は33歳です。ボブは何歳ですか。数字だけ答えて。",
    check: (a) => /\b12\b/.test(a),
  },
  {
    id: "reason/schedule",
    group: "reason",
    steps: 1,
    prompt:
      "会議は9:00に始まり45分続きます。その後15分休憩し、次の会議は前の会議の2倍の長さです。2つ目の会議は何時に終わりますか。HH:MM形式で答えて。",
    check: (a) => /11:30/.test(a),
  },
  {
    id: "reason/contradiction",
    group: "reason",
    steps: 1,
    prompt:
      "「このリストの全ての数は偶数です」と言われました。リストは [2, 4, 7, 8] です。この主張は正しいですか。正しくない場合、反例の数字だけを挙げて。",
    check: (a) => /\b7\b/.test(a),
  },

  // --- problem solving: a verifiable end state, reached with tools ----------
  {
    id: "solve/write",
    group: "solve",
    steps: 1,
    prompt: `bench-tmp/greet.txt というファイルを作って、中身を正確に "hello gahoole" にして。`,
    check: (_a, read) => read("greet.txt").trim() === "hello gahoole",
  },
  {
    id: "solve/compute",
    group: "solve",
    steps: 2,
    prompt:
      "1から50までの整数のうち、3の倍数の合計を、実際にプログラムを書いて実行して求めて。最後に数字だけを答えて。",
    // 3+6+...+48 = 408
    check: (a) => /\b408\b/.test(a),
  },
  {
    id: "solve/fix",
    group: "solve",
    steps: 2,
    setup: (dir) => write(dir, "add.js", "function add(a, b) { return a - b; }\nconsole.log(add(2, 3));\n"),
    prompt:
      "bench-tmp/add.js にバグがあります。add(2,3) が 5 を出力するように直して、node で実行して確認して。",
    // Spacing is the author's business, not the task's.
    check: (_a, read) => /return\s+a\s*\+\s*b/.test(read("add.js")),
  },

  // --- autonomy: dependent steps, no one stepping in -----------------------
  {
    id: "auto/cpp",
    group: "auto",
    steps: 3,
    prompt:
      "bench-tmp/fizz.cpp に 1から15までのFizzBuzzを出力するC++を書いて、g++でコンパイルして、実行して出力を確認する",
    check: (a, read) => read("fizz.cpp").includes("iostream") && has(a, "FizzBuzz", "Fizz"),
  },
  {
    id: "auto/pipeline",
    group: "auto",
    steps: 3,
    prompt:
      "bench-tmp/nums.txt に 1行1つで 5,3,9,1 と書いて、node でそれを読んで昇順に並べ替えて bench-tmp/sorted.txt に書き、結果を確認する",
    // Any separator. The prompt says one number per line for the *input* and
    // says nothing about the output, so "1, 3, 5, 9" is a fair reading of it —
    // and a check that only accepted newlines failed a run that had done the
    // task correctly. What is being tested is the sorting, not the punctuation.
    check: (_a, read) => (read("sorted.txt").match(/\d+/g) ?? []).join(",") === "1,3,5,9",
  },
  {
    id: "auto/inspect",
    group: "auto",
    steps: 2,
    setup: (dir) =>
      write(
        dir,
        "data.json",
        JSON.stringify({ users: [{ name: "a" }, { name: "b" }, { name: "c" }] }),
      ),
    prompt:
      "bench-tmp/data.json を読んで users の件数を数え、その数を bench-tmp/count.txt に書く",
    check: (_a, read) => read("count.txt").trim() === "3",
  },
];

function write(dir: string, file: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), body);
}
