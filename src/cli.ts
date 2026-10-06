#!/usr/bin/env bun
// The `conveyor` executable. Commands live in src/cli/; `conveyor --help` lists them.
import { runCli } from "./cli/main";

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
