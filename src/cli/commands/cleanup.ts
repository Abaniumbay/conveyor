import { applyRetention, type RetentionReport } from "../../app/retention";
import { ConveyorStore } from "../../db/store";
import { parseDuration } from "../args";
import { loadCommandConfig, printJson, stringOption, type Command } from "../command";
import { control, ServiceUnavailable } from "../control-client";
import { formatBytes } from "./operations";

export const cleanup: Command = {
  name: "cleanup",
  summary: "prune finished work past the retention policy (run events and per-run artifacts)",
  options: {
    "dry-run": { type: "boolean", description: "report what would be deleted without deleting it" },
    "run-history": { type: "string", value: "<duration>", description: "this time instead of settings.retention.runHistory" },
    artifacts: { type: "string", value: "<duration>", description: "this time instead of settings.retention.artifacts" },
  },
  details: [
    "Only runs of items that are closed, done or offboarded (and finished steering runs) are pruned;",
    "open items keep everything they may need to resume. Service logs rotate by settings.logging.",
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
      const store = await ConveyorStore.open(config.settings.database);
      try {
        report = await applyRetention({ store, artifacts: config.settings.artifacts, dryRun, policy: { ...config.settings.retention, ...overrides } });
      } finally {
        store.close();
      }
    }
    if (context.json) return printJson(context, report);
    const verb = report.dryRun ? "Would delete" : "Deleted";
    context.out([
      `${verb} ${report.runHistory.events} run event(s) of ${report.runHistory.runs} finished run(s).`,
      `${verb} ${report.artifacts.directories} artifact director${report.artifacts.directories === 1 ? "y" : "ies"} (${formatBytes(report.artifacts.bytes)}).`,
    ].join("\n"));
  },
};
