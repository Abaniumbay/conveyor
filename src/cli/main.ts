import { BUILD, versionLine } from "../version";
import { CliError, EXIT, parseArgs, type ExitCode, type OptionSpecs } from "./args";
import { GLOBAL_OPTIONS, printJson, type Command, type CommandContext } from "./command";
import { adminResetPassword } from "./commands/admin";
import { cleanup } from "./commands/cleanup";
import { diagnosticsExport } from "./commands/diagnostics";
import { configBuiltin, configCheck, configCompare, configMigrate, configShow } from "./commands/config";
import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { logs } from "./commands/logs";
import { board, itemHistory, itemLogs, itemPause, itemResume, itemRetry, itemShow, questionsAnswer, questionsList, status } from "./commands/operations";
import { rollback, upgrade } from "./commands/release";
import { serve } from "./commands/serve";
import { serviceInstall, serviceRestart, serviceStart, serviceStatus, serviceStop, serviceUninstall } from "./commands/service";
import { homePaths, resolveHome } from "./home";
import { isInteractive } from "./secret-input";

const version: Command = {
  name: "version",
  summary: "print the version and build metadata",
  async run(context) {
    if (context.json) printJson(context, BUILD);
    else context.out(versionLine());
  },
};

/** `check-config [--compare <other>]`, the v0.1 spelling of config check / config compare. */
const checkConfigAlias: Command = {
  name: "check-config",
  summary: "deprecated: use config check or config compare",
  hidden: true,
  options: { compare: { type: "string", value: "<config>", description: "compare with this configuration" } },
  async run(context) {
    const other = context.options.compare;
    if (typeof other !== "string") return configCheck.run(context);
    // v0.1 exited 0 whatever the differences: reading the summary is the review.
    await configCompare.run({ ...context, positionals: [other] });
    return EXIT.ok;
  },
};

export const COMMANDS: Command[] = [
  init,
  doctor,
  version,
  configCheck,
  configShow,
  configCompare,
  configMigrate,
  configBuiltin,
  serve,
  serviceInstall,
  serviceStart,
  serviceStop,
  serviceRestart,
  serviceStatus,
  serviceUninstall,
  status,
  board,
  itemShow,
  itemHistory,
  itemLogs,
  itemRetry,
  itemPause,
  itemResume,
  questionsList,
  questionsAnswer,
  logs,
  upgrade,
  rollback,
  cleanup,
  diagnosticsExport,
  adminResetPassword,
  checkConfigAlias,
];

/** The command named by the first one or two arguments (the longest match wins). */
function findCommand(argv: readonly string[], commands: readonly Command[]): { command: Command; rest: string[] } | null {
  for (const length of [2, 1]) {
    const name = argv.slice(0, length).join(" ");
    const command = commands.find((candidate) => candidate.name === name);
    if (command) return { command, rest: argv.slice(length) };
  }
  return null;
}

function optionLines(options: OptionSpecs): string[] {
  return Object.entries(options).map(([name, spec]) => {
    const flag = `--${name}${spec.value ? ` ${spec.value}` : ""}`;
    return `  ${flag.padEnd(34)}${spec.description}`;
  });
}

export function commandHelp(command: Command): string {
  return [
    `Usage: conveyor ${command.name}${command.usage ? ` ${command.usage}` : ""} [options]`,
    "",
    command.summary,
    ...(command.details ? ["", command.details] : []),
    "",
    "Options:",
    ...optionLines({ ...command.options, ...GLOBAL_OPTIONS }),
  ].join("\n");
}

export function generalHelp(commands: readonly Command[] = COMMANDS): string {
  const visible = commands.filter((command) => !command.hidden);
  const width = Math.max(...visible.map((command) => command.name.length)) + 2;
  return [
    "Usage: conveyor <command> [options]",
    "",
    "Commands:",
    ...visible.map((command) => `  ${command.name.padEnd(width)}${command.summary}`),
    "",
    "Global options:",
    ...optionLines({ ...GLOBAL_OPTIONS, version: { type: "boolean", description: "print the version" } }),
    "",
    "Run conveyor <command> --help for a command's options. Exit codes: 0 ok, 1 failed,",
    "2 usage error, 3 invalid configuration, 4 service unreachable, 5 request rejected.",
  ].join("\n");
}

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  environment?: NodeJS.ProcessEnv;
  /** Whether commands may prompt; defaults to whether stdin and stderr are a terminal. */
  interactive?: boolean;
}

const defaultIo: CliIo = {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
};

/** Runs one command line and returns its exit code; errors are printed, never thrown. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo, commands: readonly Command[] = COMMANDS): Promise<ExitCode> {
  try {
    if (argv[0] === "--version") {
      io.out(versionLine());
      return EXIT.ok;
    }
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
      io.out(generalHelp(commands));
      return argv.length === 0 ? EXIT.usage : EXIT.ok;
    }
    const found = findCommand(argv, commands);
    if (!found) throw new CliError(`unknown command: ${argv[0]}\nRun conveyor --help for the list of commands.`, EXIT.usage);
    const { command, rest } = found;
    const parsed = parseArgs(rest, { ...command.options, ...GLOBAL_OPTIONS });
    if (parsed.options.help) {
      io.out(commandHelp(command));
      return EXIT.ok;
    }
    const home = resolveHome(typeof parsed.options.home === "string" ? parsed.options.home : undefined, io.environment ?? process.env);
    const context: CommandContext = {
      positionals: parsed.positionals,
      options: parsed.options,
      paths: homePaths(home, typeof parsed.options.config === "string" ? parsed.options.config : undefined),
      json: parsed.options.json === true,
      interactive: io.interactive ?? isInteractive(),
      out: io.out,
      err: io.err,
    };
    return (await command.run(context)) ?? EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return error.exitCode;
    }
    io.err(error instanceof Error ? error.message : String(error));
    return EXIT.failure;
  }
}
