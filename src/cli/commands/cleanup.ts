import { applyRetention, type RetentionReport } from "../../app/retention";
import { ConveyorStore } from "../../db/store";
import { parseDuration } from "../args";
import { loadCommandConfig, printJson, stringOption, type Command } from "../command";
import { control, ServiceUnavailable } from "../control-client";
import { formatBytes } from "./operations";

export const cleanup: Command = {
  name: "cleanup",
  summary: "prune finished work and reclaim private homes of terminal runs",
  options: {
    "dry-run": { type: "boolean", description: "report what would be deleted without deleting it" },
    "run-history": { type: "string", value: "<duration>", description: "this time instead of settings.retention.runHistory" },
    artifacts: { type: "string", value: "<duration>", description: "this time instead of settings.retention.artifacts" },
  },
  details: [
    "Run events and artifact directories follow the configured retention policy for retired items.",
    "Private homes of every terminal run are reclaimed immediately; running runs and shared caches are kept.",
    "Service logs rotate by settings.logging.",
  ].join("\n"),
  async run(context) {
    const runHistory = stringOption(context, "run-history");
    const artifacts = stringOption(context, "artifacts");
    const overrides = {
      ...(runHistory ? { runHistoryMs: parseDuration(runHistory, "--run-history") } : {}),
      ...(artifacts ? { artifactsMs: parseDuration(artifacts, "--artifacts") } : {}),
    };
    const dryRun = context.options["dry-run"] === true;
    let report = await control<RetentionReport>(context, "POST", "/v1/cleanup", { dryRun, ...overrides }).catch((error: unknown) => {
      if (error instanceof ServiceUnavailable) return null;
      throw error;
    });
    if (!report) {
      // The service is stopped: the same operation, on the store directly.
      const config = await loadCommandConfig(context, null);
      const store = await ConveyorStore.open(config.settings.database, { migrateExisting: false });
      try {
        report = await applyRetention({ store, artifacts: config.settings.artifacts, dryRun, policy: { ...config.settings.retention, ...overrides }, eventsMs: config.settings.events.retentionMs });
      } finally {
        store.close();
      }
    }
    if (context.json) return printJson(context, report);
    const verb = report.dryRun ? "Would delete" : "Deleted";
    context.out([
      `${verb} ${report.runHistory.events} run event(s) of ${report.runHistory.runs} finished run(s).`,
      `${verb} ${report.artifacts.directories} artifact director${report.artifacts.directories === 1 ? "y" : "ies"} (${formatBytes(report.artifacts.bytes)}).`,
      `${verb} ${report.homes.directories} run home${report.homes.directories === 1 ? "" : "s"} (${formatBytes(report.homes.bytes)}).`,
      `${verb} ${report.eventLog.events} recorded event${report.eventLog.events === 1 ? "" : "s"} past the event log's retention.`,
      ...(report.homes.failures.length > 0 ? [`Could not delete ${report.homes.failures.length} run home${report.homes.failures.length === 1 ? "" : "s"}: ${report.homes.failures.join("; ")}`] : []),
    ].join("\n"));
  },
};
