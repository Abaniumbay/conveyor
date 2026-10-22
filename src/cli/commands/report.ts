// Reports computed by the running service: the finding-type report.

import type { FindingReport } from "../../app/finding-report";
import { parseSince } from "../../app/finding-report";
import { CliError, EXIT } from "../args";
import { printJson, stringOption, type Command } from "../command";
import { control } from "../control-client";

const percent = (share: number | null) => (share === null ? "n/a" : `${(share * 100).toFixed(1)}%`);

function counts(title: string, values: Record<string, number>): string[] {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length === 0 ? [] : ["", `${title}:`, ...entries.map(([key, count]) => `  ${key.padEnd(24)}${count}`)];
}

export function renderFindingReport(report: FindingReport): string {
  return [
    `Findings: ${report.total}`,
    `Review rounds: ${report.reviewRounds}`,
    "",
    "By type (findings, review rounds with the type, share of rounds):",
    ...report.typeShares.map((row) => `  ${row.type.padEnd(24)}${String(row.findings).padStart(5)}${String(row.rounds).padStart(7)}  ${percent(row.share).padStart(6)}`),
    ...counts("By repository", report.byRepository),
    ...counts("By author", report.byAuthor),
    ...counts("By week", report.byWeek),
  ].join("\n");
}

export const reportFindings: Command = {
  name: "report findings",
  summary: "show how many review findings exist by type and how often each type appears in a review round",
  options: {
    repository: { type: "string", value: "<id>", description: "only this configured repository" },
    since: { type: "string", value: "<date>", description: "only findings and review rounds from this ISO 8601 date or timestamp on (inclusive)" },
  },
  async run(context) {
    const repository = stringOption(context, "repository");
    const since = stringOption(context, "since");
    if (context.options.repository === true || repository === "") throw new CliError("--repository needs a repository id", EXIT.usage);
    if (context.options.since === true || (since !== undefined && parseSince(since) === null)) {
      throw new CliError(`--since must be an ISO 8601 date or timestamp, not ${since ?? "empty"}`, EXIT.usage);
    }
    const query = new URLSearchParams();
    if (repository !== undefined) query.set("repository", repository);
    if (since !== undefined) query.set("since", since);
    const report = await control<FindingReport>(context, "GET", `/v1/reports/findings${query.size > 0 ? `?${query}` : ""}`);
    if (context.json) printJson(context, report);
    else context.out(renderFindingReport(report));
  },
};
