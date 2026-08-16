#!/usr/bin/env node
// Entry point for the installed `gahoole` command.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("tsx/esm", pathToFileURL("./"));
await import("../src/cli.ts");
