#!/usr/bin/env node
// Installed entry point. Runs the compiled CLI; `npm run dev` runs the
// TypeScript directly through tsx instead.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../dist/cli.js");

if (!existsSync(cli)) {
  console.error("gahoole is not built yet — run `npm run build`");
  process.exit(1);
}
// pathToFileURL, not `file://` + the path.
//
// A Windows path is `C:\Users\...`, which is not a URL path, and a directory
// with a space in it is not one either. Node has a function for this and
// hand-rolling it broke both.
await import(pathToFileURL(cli).href);
