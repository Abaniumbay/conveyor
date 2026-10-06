#!/usr/bin/env bun
// The `conveyor` executable. Commands live in src/cli/; `conveyor --help` lists them. Helper
// processes re-run this executable with an internal subcommand, which loads only what it needs.
import { INTERNAL } from "./self";

if (import.meta.main) {
  const [command, ...rest] = Bun.argv.slice(2);
  if (command === INTERNAL.bridge) {
    const { runBridge } = await import("./isolation/bridge");
    await runBridge(rest[0]);
  } else if (command === INTERNAL.mcp) {
    const { runMcpCli } = await import("./mcp/cli");
    await runMcpCli(rest).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    const { runCli } = await import("./cli/main");
    process.exitCode = await runCli(Bun.argv.slice(2));
  }
}
