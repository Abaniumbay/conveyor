// The shape every CLI command shares: its options, and the context it runs with (home, config, output).

import { ConfigError, loadConfig, type ConveyorConfig } from "../config/load";
import type { TaskRegistry } from "../tasks/contract";
import { CliError, EXIT, type ExitCode, type OptionSpecs } from "./args";
import type { HomePaths } from "./home";

export const GLOBAL_OPTIONS: OptionSpecs = {
  home: { type: "string", value: "<dir>", description: "Conveyor home (default: $CONVEYOR_HOME, else ~/.conveyor)" },
  config: { type: "string", value: "<file>", description: "configuration entrypoint (default: <home>/config/conveyor.yaml)" },
  json: { type: "boolean", description: "print machine-readable JSON" },
  help: { type: "boolean", description: "show help for the command" },
};

export interface CommandContext {
  positionals: string[];
  options: Record<string, string | boolean | undefined>;
  paths: HomePaths;
  json: boolean;
  /** Whether the command may prompt (a terminal is attached); otherwise it needs every input as an option. */
  interactive: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface Command {
  /** One or two words, e.g. "status" or "config check". */
  name: string;
  summary: string;
  /** Arguments after the command name, for help, e.g. "<item>". */
  usage?: string;
  options?: OptionSpecs;
  /** Shown under the usage in `--help`. */
  details?: string;
  /** Not listed in `conveyor --help` (internal helper entrypoints and compatibility aliases). */
  hidden?: boolean;
  run(context: CommandContext): Promise<ExitCode | void>;
}

export function stringOption(context: CommandContext, name: string): string | undefined {
  const value = context.options[name];
  return typeof value === "string" ? value : undefined;
}

export function positional(context: CommandContext, index: number, name: string): string {
  const value = context.positionals[index];
  if (!value) throw new CliError(`missing ${name}`, EXIT.usage);
  return value;
}

export function printJson(context: CommandContext, value: unknown): void {
  context.out(JSON.stringify(value, null, 2));
}

/** Loads the configuration for a command; an invalid configuration exits with EXIT.config. */
export async function loadCommandConfig(
  context: CommandContext,
  registry?: TaskRegistry | null,
  path = context.paths.config,
): Promise<ConveyorConfig> {
  try {
    const config = await loadConfig(path, registry, { home: context.paths.home });
    for (const warning of config.warnings ?? []) context.err(`warning: ${warning}`);
    return config;
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message, EXIT.config);
    throw error;
  }
}
