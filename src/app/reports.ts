// The Reports view: delivery, usage and time figures per repository, month, stage and item, computed
// read-only from the store. An item counts as delivered when it finished its last stage (Conveyor
// records that as an advance from the last stage to itself); items imported as done without that
// record have no history and are left out of every figure.

import type { Database } from "bun:sqlite";

import type { ConveyorConfig } from "../config/load";
import type { ConveyorStore } from "../db/store";
import { displayName } from "../tasks/agent-support";
import type {
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
const NOT_IN_PROGRESS = new Set(["done", "offboarded", "missing", "closed"]);

interface IssueRow { id: string; repository_id: string; source_number: number; title: string; source_state: string; projected_state: string | null }
interface RunRow { issue_id: string; stage_id: string; status: string; started_at: string; finished_at: string | null; input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null }
interface TransitionRow { issue_id: string; kind: string; from_stage: string | null; to_stage: string | null; status: string; created_at: string }
interface WaitRow { issue_id: string; pending_since: string; updated_at: string }

/** Everything about one item the report needs, over its whole life. */
interface ItemFacts {
  issue: IssueRow;
  enrolledAt: string | null;
  finishedAt: string | null;
  runs: RunRow[];
  agentMs: number;
  tokens: number;
  checksWaitMs: number;
  waitingForYouMs: number;
  returns: number;
  stops: number;
}

const ms = (iso: string) => Date.parse(iso);
const tokensOf = (run: RunRow) => (run.input_tokens ?? 0) + (run.output_tokens ?? 0);
const runMs = (run: RunRow, now: number) => Math.max(0, (run.finished_at ? ms(run.finished_at) : now) - ms(run.started_at));
const average = (values: readonly number[]) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const month = (iso: string) => iso.slice(0, 7);

export function reportSince(period: ReportPeriod, now: Date): string | null {
  return period === "all" ? null : new Date(now.getTime() - PERIOD_MS[period]).toISOString();
}

function loadFacts(db: Database, now: number): ItemFacts[] {
  const issues = db.query("SELECT id, repository_id, source_number, title, source_state, projected_state FROM issues").all() as IssueRow[];
  const byIssue = <T extends { issue_id: string }>(rows: T[]) => {
    const grouped = new Map<string, T[]>();
    for (const row of rows) grouped.set(row.issue_id, [...(grouped.get(row.issue_id) ?? []), row]);
    return grouped;
  };
  const runs = byIssue(db.query(`
    SELECT r.issue_id, r.stage_id, r.status, r.started_at, r.finished_at,
           SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(u.cached_tokens) AS cached_tokens
    FROM runs r LEFT JOIN usage_cost_entries u ON u.run_id = r.id
    GROUP BY r.id ORDER BY r.started_at`).all() as RunRow[]);
  const transitions = byIssue(db.query(
    "SELECT issue_id, kind, from_stage, to_stage, status, created_at FROM stage_transitions ORDER BY created_at, id",
  ).all() as TransitionRow[]);
  // A parked task waited on something outside the agent: CI, a deploy, a dependency.
  const waits = byIssue(db.query(
    "SELECT issue_id, pending_since, updated_at FROM task_executions WHERE pending_since IS NOT NULL",
  ).all() as WaitRow[]);
  const enrolled = new Map((db.query("SELECT issue_id, MIN(started_at) AS started_at FROM enrollments GROUP BY issue_id").all() as Array<{ issue_id: string; started_at: string }>)
    .map((row) => [row.issue_id, row.started_at]));

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
  const rows = new Map<string, { delivered: ItemFacts[]; runs: RunRow[] }>();
  const row = (key: string) => {
    const existing = rows.get(key);
    if (existing) return existing;
    const created = { delivered: [] as ItemFacts[], runs: [] as RunRow[] };
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
  const grouped = new Map<string, RunRow[]>();
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

export function buildReport(input: {
  store: ConveyorStore;
  config: ConveyorConfig;
  period: ReportPeriod;
  repository: string | null;
  now?: Date;
}): ReportViewModel {
  const nowDate = input.now ?? new Date();
  const now = nowDate.getTime();
  const since = reportSince(input.period, nowDate);
  const repositories = Object.keys(input.config.repositories);
  const facts = loadFacts(input.store.sqlite(), now).filter((item) => repositories.includes(item.issue.repository_id));
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
    importedWithoutHistory: facts.filter((item) => imported(item) && (!input.repository || item.issue.repository_id === input.repository)).length,
    generatedAt: nowDate.toISOString(),
  };
}
