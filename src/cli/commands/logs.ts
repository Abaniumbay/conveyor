import { LEVELS, formatRecord, type LogLevel, type LogRecord } from "../../log/logger";
import { followLog, readLogRecords, type LogQuery } from "../../log/reader";
import { CliError, EXIT, parseDuration } from "../args";
import { stringOption, type Command } from "../command";
import { statePaths } from "./operations";

export const logs: Command = {
  name: "logs",
  summary: "print the service log (it does not need the service running), optionally following it",
  options: {
    follow: { type: "boolean", description: "keep printing new records until interrupted" },
    level: { type: "string", value: "<level>", description: "minimum level: debug, info, warn or error" },
    since: { type: "string", value: "<duration>", description: "only records from this long ago, e.g. 30m, 1h, 7d" },
    item: { type: "string", value: "<item>", description: "only records about this item, e.g. conveyor:90" },
    stage: { type: "string", value: "<stage>", description: "only records about this stage" },
    lines: { type: "string", value: "<n>", description: "print at most the last n matching records (default 200; 0 for all)" },
  },
  details: "Agent transcripts are not in the service log: use conveyor item logs <item>.",
  async run(context) {
    const level = stringOption(context, "level");
    if (level && !LEVELS.includes(level as LogLevel)) throw new CliError(`--level must be one of ${LEVELS.join(", ")}`, EXIT.usage);
    const since = stringOption(context, "since");
    const item = stringOption(context, "item");
    const stage = stringOption(context, "stage");
    const query: LogQuery = {
      ...(level ? { level: level as LogLevel } : {}),
      ...(since ? { since: Date.now() - parseDuration(since, "--since") } : {}),
      ...(item ? { item } : {}),
      ...(stage ? { stage } : {}),
    };
    const lines = Number(stringOption(context, "lines") ?? "200");
    if (!Number.isInteger(lines) || lines < 0) throw new CliError("--lines must be a whole number", EXIT.usage);
    const directory = (await statePaths(context)).logs;
    const print = (record: LogRecord) => context.out(context.json ? JSON.stringify(record) : formatRecord(record));
    const records = await readLogRecords(directory, query);
    for (const record of lines === 0 ? records : records.slice(-lines)) print(record);
    if (!context.options.follow) return;
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await followLog(directory, query, print, controller.signal);
  },
};
