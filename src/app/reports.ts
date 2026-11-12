// The Reports view: delivery, usage and time figures per repository, month, stage and item, computed
// read-only from the store. An item counts as delivered when it finished its last stage (Conveyor
// records that as an advance from the last stage to itself); items imported as done without that
// record have no history and are left out of every figure.

import type { ConveyorConfig } from "../config/load";
import type { ReportStore } from "../db/ports";
import type { ReportIssueRow, ReportRunRow } from "../db/reports";
import { buildFindingReport } from "./finding-report";
import { displayName } from "../tasks/agent-support";
import type {
  ReportFindingCountRow,
  ReportFindings,
  ReportItemRow,
  ReportMonthRow,
  ReportPeriod,
  ReportRepositoryRow,
  ReportStageRow,
  ReportTotals,
  ReportViewModel,
} from "../web/types";

const DAY = 86_400_000;
const PERIOD_MS: Record<Exclude<ReportPeriod, "all">, number> = { "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY, "12m": 365 * DAY };
const NOT_IN_PROGRESS = new Set(["done", "unlisted", "closed"]);

/** Everything about one item the report needs, over its whole life. */
interface ItemFacts {
  issue: ReportIssueRow;
  enrolledAt: string | null;
  finishedAt: string | null;
  runs: ReportRunRow[];
  agentMs: number;
  tokens: number;
  checksWaitMs: number;
  waitingForYouMs: number;
  returns: number;
  stops: number;
}

const ms = (iso: string) => Date.parse(iso);
const tokensOf = (run: ReportRunRow) => (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
const runMs = (run: ReportRunRow, now: number) => Math.max(0, (run.finished_at ? ms(run.finished_at) : now) - ms(run.started_at));
const average = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const month = (iso: string) => iso.slice(0, 7);

export function reportSince(period: ReportPeriod, now: Date): string | null {
  return period === "all" ? null : new Date(now.getTime() - PERIOD_MS[period]).toISOString();
}

function loadFacts(store: ReportStore, now: number): ItemFacts[] {
  const queries = store.reports();
  const issues = queries.issues();
  const byIssue = <T extends { issue_id: string }>(rows: T[]) => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) grouped.set(row.issue_id, [...(grouped.get(row.issue_id) ?? []), row]);
    return grouped;
  };
  const runs = byIssue(queries.runs());
  const transitions = byIssue(queries.transitions());
  // A parked task waited on something outside the agent: CI, a deploy, a dependency.
  const waits = byIssue(queries.waits());
  const enrolled = new Map(queries.firstEnrollments().map((row) => [row.issue_id, row.started_at]));

  return issues.map((issue) => {
    const itemRuns = runs.get(issue.id) ?? [];
    const itemTransitions = (transitions.get(issue.id) ?? []).filter((transition) => transition.status === "completed");
    const finished = itemTransitions.filter((transition) => transition.kind === "advance" && transition.from_stage !== null && transition.from_stage === transition.to_stage).at(-1);
    let waitingForYouMs = 0;
    itemTransitions.forEach((transition, index) => {
      if (transition.kind !== "stopped") return;
      const next = itemTransitions[index + 1];
      const end = next ? ms(next.created_at) : finished ? ms(finished.created_at) : now;
      waitingForYouMs += Math.max(0, end - ms(transition.created_at));
    });
    return {
      issue,
      enrolledAt: enrolled.get(issue.id) ?? itemTransitions[0]?.created_at ?? null,
      finishedAt: finished?.created_at ?? null,
      runs: itemRuns,
      agentMs: itemRuns.reduce((sum, run) => sum + runMs(run, now), 0),
      tokens: itemRuns.reduce((sum, run) => sum + tokensOf(run), 0),
      checksWaitMs: (waits.get(issue.id) ?? []).reduce((sum, wait) => sum + Math.max(0, ms(wait.updated_at) - ms(wait.pending_since)), 0),
      waitingForYouMs,
      returns: itemTransitions.filter((transition) => transition.kind === "correction").length,
      stops: itemTransitions.filter((transition) => transition.kind === "stopped").length,
    };
  });
}

const leadMs = (item: ItemFacts) => (item.finishedAt && item.enrolledAt ? Math.max(0, ms(item.finishedAt) - ms(item.enrolledAt)) : null);
const queuedMs = (item: ItemFacts) => {
  const lead = leadMs(item);
  return lead === null ? null : Math.max(0, lead - item.agentMs - item.checksWaitMs - item.waitingForYouMs);
};
const inProgress = (item: ItemFacts) => item.issue.source_state === "open" && item.finishedAt === null && item.enrolledAt !== null
  && !NOT_IN_PROGRESS.has(item.issue.projected_state ?? "");

function totals(items: readonly ItemFacts[], since: string | null, now: number): ReportTotals {
  const inPeriod = (iso: string | null) => iso !== null && (since === null || iso >= since);
  const delivered = items.filter((item) => inPeriod(item.finishedAt));
  const runs = items.flatMap((item) => item.runs.filter((run) => inPeriod(run.started_at)));
  const per = (pick: (item: ItemFacts) => number | null) => average(delivered.flatMap((item) => {
    const value = pick(item);
    return value === null ? [] : [value];
  }));
  return {
    delivered: delivered.length,
    inProgress: items.filter(inProgress).length,
    runs: runs.length,
    failedRuns: runs.filter((run) => run.status !== "succeeded" && run.status !== "running").length,
    inputTokens: runs.reduce((sum, run) => sum + (run.input_tokens ?? 0), 0),
    outputTokens: runs.reduce((sum, run) => sum + (run.output_tokens ?? 0), 0),
    cachedTokens: runs.reduce((sum, run) => sum + (run.cached_tokens ?? 0), 0),
    agentMs: runs.reduce((sum, run) => sum + runMs(run, now), 0),
    avgTokensPerItem: per((item) => item.tokens),
    avgRunsPerItem: per((item) => item.runs.length),
    avgLeadMs: per(leadMs),
    avgAgentMs: per((item) => item.agentMs),
    avgChecksWaitMs: per((item) => item.checksWaitMs),
    avgWaitingForYouMs: per((item) => item.waitingForYouMs),
    avgQueuedMs: per(queuedMs),
    avgReturnsPerItem: per((item) => item.returns),
    avgStopsPerItem: per((item) => item.stops),
    firstPassRate: delivered.length === 0 ? null : delivered.filter((item) => item.returns === 0).length / delivered.length,
  };
}

function months(items: readonly ItemFacts[], since: string | null, now: number): ReportMonthRow[] {
  const rows = new Map<string, { delivered: ItemFacts[]; runs: ReportRunRow[] }>();
  const row = (key: string) => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created = { delivered: [] as ItemFacts[], runs: [] as ReportRunRow[] };
    rows.set(key, created);
    return created;
  };
  for (const item of items) {
    if (item.finishedAt && (since === null || item.finishedAt >= since)) row(month(item.finishedAt)).delivered.push(item);
    for (const run of item.runs) if (since === null || run.started_at >= since) row(month(run.started_at)).runs.push(run);
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({
    month: key,
    delivered: value.delivered.length,
    runs: value.runs.length,
    tokens: value.runs.reduce((sum, run) => sum + tokensOf(run), 0),
    agentMs: value.runs.reduce((sum, run) => sum + runMs(run, now), 0),
    avgTokensPerItem: average(value.delivered.map((item) => item.tokens)),
    avgLeadMs: average(value.delivered.flatMap((item) => leadMs(item) ?? [])),
  }));
}

function stages(items: readonly ItemFacts[], since: string | null, now: number, config: ConveyorConfig, repositoryIds: readonly string[]): ReportStageRow[] {
  const order: string[] = [];
  const names = new Map<string, string>();
  for (const id of repositoryIds) {
    const pipeline = config.pipelines[config.repositories[id]?.pipeline ?? ""];
    for (const stage of pipeline?.stages ?? []) {
      if (!names.has(stage.id)) { order.push(stage.id); names.set(stage.id, stage.name ?? displayName(stage.id)); }
    }
  }
  const grouped = new Map<string, ReportRunRow[]>();
  for (const item of items) for (const run of item.runs) {
    if (since !== null && run.started_at < since) continue;
    grouped.set(run.stage_id, [...(grouped.get(run.stage_id) ?? []), run]);
  }
  const ids = [...order.filter((id) => grouped.has(id)), ...[...grouped.keys()].filter((id) => !names.has(id)).sort()];
  return ids.map((id) => {
    const runs = grouped.get(id)!;
    const agentMs = runs.reduce((sum, run) => sum + runMs(run, now), 0);
    return {
      id,
      name: names.get(id) ?? displayName(id),
      runs: runs.length,
      failedRuns: runs.filter((run) => run.status !== "succeeded" && run.status !== "running").length,
      tokens: runs.reduce((sum, run) => sum + tokensOf(run), 0),
      agentMs,
      avgRunMs: runs.length === 0 ? null : agentMs / runs.length,
    };
  });
}

function itemRows(items: readonly ItemFacts[], since: string | null): ReportItemRow[] {
  const active = (item: ItemFacts) => inProgress(item)
    || (item.finishedAt !== null && (since === null || item.finishedAt >= since))
    || item.runs.some((run) => since === null || run.started_at >= since);
  return items.filter(active)
    .sort((a, b) => Number(b.finishedAt === null) - Number(a.finishedAt === null)
      || (b.finishedAt ?? b.runs.at(-1)?.started_at ?? "").localeCompare(a.finishedAt ?? a.runs.at(-1)?.started_at ?? "")
      || b.issue.source_number - a.issue.source_number)
    .map((item) => ({
      repository: item.issue.repository_id,
      number: item.issue.source_number,
      title: item.issue.title,
      state: item.finishedAt ? "done" : item.issue.projected_state ?? item.issue.source_state,
      finishedAt: item.finishedAt,
      leadMs: leadMs(item),
      agentMs: item.agentMs,
      checksWaitMs: item.checksWaitMs,
      waitingForYouMs: item.waitingForYouMs,
      runs: item.runs.length,
      tokens: item.tokens,
      returns: item.returns,
      stops: item.stops,
    }));
}

const byCount = (counts: Record<string, number>, order: (a: string, b: string) => number): ReportFindingCountRow[] =>
  Object.entries(counts).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || order(a.key, b.key));

/** The shared finding report as view rows: types in taxonomy order, others by count, weeks newest first. */
function findings(store: ReportStore, repository: string | null, since: string | null): ReportFindings {
  const report = buildFindingReport(store, { ...(repository ? { repositoryId: repository } : {}), ...(since ? { since } : {}) });
  const byKey = (a: string, b: string) => a.localeCompare(b);
  return {
    total: report.total,
    reviewRounds: report.reviewRounds,
    byType: report.typeShares,
    byRepository: byCount(report.byRepository, byKey),
    byAuthor: byCount(report.byAuthor, byKey),
    byWeek: Object.entries(report.byWeek).map(([key, count]) => ({ key, count })).sort((a, b) => b.key.localeCompare(a.key)),
  };
}

export function buildReport(input: {
  store: ReportStore;
  config: ConveyorConfig;
  period: ReportPeriod;
  repository: string | null;
  now?: Date;
}): ReportViewModel {
  const nowDate = input.now ?? new Date();
  const now = nowDate.getTime();
  const since = reportSince(input.period, nowDate);
  const repositories = Object.keys(input.config.repositories);
  const facts = loadFacts(input.store, now).filter((item) => repositories.includes(item.issue.repository_id));
  const imported = (item: ItemFacts) => item.issue.projected_state === "done" && item.finishedAt === null;
  const counted = facts.filter((item) => !imported(item));
  const scope = input.repository ? counted.filter((item) => item.issue.repository_id === input.repository) : counted;
  const scopeRepositories = input.repository ? [input.repository] : repositories;
  return {
    period: input.period,
    since,
    repository: input.repository,
    repositories,
    totals: totals(scope, since, now),
    byRepository: repositories.map((id) => ({ id, ...totals(counted.filter((item) => item.issue.repository_id === id), since, now) })),
    byMonth: months(scope, since, now),
    byStage: stages(scope, since, now, input.config, scopeRepositories),
    items: input.repository ? itemRows(scope, since) : [],
    findings: findings(input.store, input.repository, since),
    importedWithoutHistory: facts.filter((item) => imported(item) && (!input.repository || item.issue.repository_id === input.repository)).length,
    generatedAt: nowDate.toISOString(),
  };
}
