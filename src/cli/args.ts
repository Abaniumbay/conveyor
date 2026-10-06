// Command-line parsing and the stable exit codes every command uses.

/** Stable exit codes; documented in docs/cli.md. */
export const EXIT = {
  ok: 0,
  /** The command ran and failed: an operation error or a failed check. */
  failure: 1,
  /** The command line is invalid. */
  usage: 2,
  /** The configuration does not load or validate. */
  config: 3,
  /** The running service cannot be reached (it is stopped, or the control socket is missing). */
  unavailable: 4,
  /** The service refused the request: a precondition does not hold. */
  rejected: 5,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  override readonly name = "CliError";

  constructor(message: string, readonly exitCode: ExitCode = EXIT.failure) {
    super(message);
  }
}

export interface OptionSpec {
  type: "string" | "boolean";
  description: string;
  /** Shown as the value placeholder in help, e.g. "<file>". */
  value?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | boolean | undefined>;
}

/**
 * Parses `--name value`, `--name=value` and boolean `--flag` options against `specs`; everything
 * else, and everything after `--`, is positional. Unknown options and missing values are usage errors.
 */
export function parseArgs(argv: readonly string[], specs: OptionSpecs): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals >= 0 ? equals : undefined);
    const spec = specs[name];
    if (!spec) throw new CliError(`unknown option --${name}`, EXIT.usage);
    if (name in options) throw new CliError(`--${name} is given more than once`, EXIT.usage);
    if (spec.type === "boolean") {
      if (equals >= 0) throw new CliError(`--${name} does not take a value`, EXIT.usage);
      options[name] = true;
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : argv[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith("--"))) {
      throw new CliError(`--${name} needs a value`, EXIT.usage);
    }
    options[name] = value;
    if (equals < 0) index += 1;
  }
  return { positionals, options };
}

/** Parses a duration such as 90s, 30m, 6h or 7d into milliseconds. */
export function parseDuration(value: string, option: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new CliError(`${option} must be a duration such as 30s, 10m, 6h or 7d`, EXIT.usage);
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "ms" | "s" | "m" | "h" | "d"];
  return Number(match[1]) * unit;
}
