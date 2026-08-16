#!/usr/bin/env node
// Installed entry point. Runs the compiled CLI; `npm run dev` runs the
// TypeScript directly through tsx instead.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/cli.js");

if (!existsSync(cli)) {
  console.error("gahoole is not built yet — run `npm run build`");
  process.exit(1);
}
await import(pathToFileURLString(cli));

function pathToFileURLString(p) {
  return new URL(`file://${p}`).href;
}
