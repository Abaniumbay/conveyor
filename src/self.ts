// How Conveyor starts processes that need its own code: helper processes (the run-scoped MCP server,
// the sandbox bridge) run this same executable through internal subcommands, never a source file.
// Operator scripts run under their configured interpreter.

import path from "node:path";

import { BUILD } from "./version";

/** Internal subcommands; not listed in `conveyor --help`. */
export const INTERNAL = { mcp: "__mcp", bridge: "__bridge" } as const;

/** The argv that runs `conveyor <subcommand> ...args` with this executable (or this checkout). */
export function selfCommand(subcommand: string, ...args: string[]): string[] {
  return BUILD.compiled
    ? [process.execPath, subcommand, ...args]
    : [process.execPath, path.join(import.meta.dir, "cli.ts"), subcommand, ...args];
}

/** The interpreter of a script that does not name one: Bun, which must then be installed. */
export const DEFAULT_SCRIPT_INTERPRETER: readonly string[] = ["bun", "run"];

/**
 * An operator script's argv: the interpreter (an argv prefix) followed by the script path.
 * `[python3]` runs `python3 <script>`; `[]` executes the script itself.
 */
export function scriptCommand(script: string, interpreter: readonly string[] = DEFAULT_SCRIPT_INTERPRETER): string[] {
  return [...interpreter, script];
}
