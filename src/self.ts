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

/**
 * What a confined agent needs from a source checkout to run `selfCommand` (`__mcp`): the checkout's
 * `src/` and `package.json` (read for the version) and `node_modules`, the dependencies the server
 * imports. Mounting the dependency directory whole, rather than the packages the server happens to
 * load, keeps resolution identical to the host's and cannot go stale as imports change; it holds
 * only installed packages. Nothing else of the checkout (`.git`, configuration, other runs) is listed.
 * A compiled build runs from its single executable and needs nothing, so it returns none.
 */
export function sourceCheckoutRuntime(): string[] {
  if (BUILD.compiled) return [];
  const root = path.dirname(import.meta.dir);
  return ["src", "package.json", "node_modules"].map((entry) => path.join(root, entry));
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
