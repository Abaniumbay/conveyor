// A read-only dashboard contract built from loaded configuration and durable store facts.
// It deliberately has no source/provider dependency so callers can render it without a request.

import { buildReport } from "./reports";
import { isLightweightRepositoryStage } from "./stage-capacity";
import type { ConveyorConfig } from "../config/load";
import type { ConveyorStore, StoredIssue } from "../db/store";
import { concise, displayName } from "../tasks/agent-support";

export type RepositoryItemState = "Running" | "Queued" | "Waiting" | "Needs you" | "Blocked";

export interface RepositorySummaryItem {
  number: number;
  title: string;
  stage: string | null;
  state: RepositoryItemState;
}

export interface RepositoryDeliverySummary {
  number: number;
  title: string;
  deliveredAt: string;
}

export interface RepositorySummary {
  id: string;
  address: string;
  addressUrl: string | null;
  color: number;
  health: "healthy" | "degraded";
  error: string | null;
  errorSummary: string | null;
  lastReconciledAt: string | null;
  backlog: number;
  stages: Array<{ id: string; name: string; count: number }>;
  done: number;
  items: RepositorySummaryItem[];
  deliveries: RepositoryDeliverySummary[];
  capacity: { busy: number; slots: number };
  setup: {
    pipeline: string;
    baseBranch: string;
    itemProvider: string;
    itemSync: "webhook" | "polling";
    ciProvider: string | null;
    ciMode: "required" | "advisory" | "disabled";
    systemLabels: string[];
  };
  report30d: {
    delivered: number;
    inputTokens: number;
    outputTokens: number;
    agentMs: number;
  };
}

/** Keep filesystem and network allow-list facts out of the ordinary dashboard contract. */
export interface RestrictedRepositorySummary {
  id: string;
  folder: string;
  agentEgressHosts: string[];
}

export interface RepositorySummaries {
  repositories: RepositorySummary[];
  restrictedRepositories: RestrictedRepositorySummary[];
}

export interface BuildRepositorySummariesInput {
  store: ConveyorStore;
  config: ConveyorConfig;
  /** The board already loaded these rows; reuse them instead of issuing another list query. */
  issues?: readonly StoredIssue[];
  onboardingErrors?: ReadonlyMap<string, string>;
  reconciliationErrors?: ReadonlyMap<string, string>;
  lastReconciledAt?: string | null;
  now?: Date;
}

interface DeliveryRow {
  issue_id: string;
  repository_id: string;
  source_number: number;
  title: string;
  delivered_at: string;
}

const DONE_STATES = new Set(["done", "completed"]);
const INACTIVE_STATES = new Set(["closed", "missing", "offboarded", "paused"]);
const BLOCKED_STATES = new Set(["blocked", "error", "failed", "rejected", "inconsistent"]);
const NEEDS_YOU_STATES = new Set(["needs-input", "needs-intervention"]);

const isDone = (issue: StoredIssue) => DONE_STATES.has(issue.projectedState ?? "");
const isActiveWork = (issue: StoredIssue) => !isDone(issue) && !INACTIVE_STATES.has(issue.projectedState ?? "");

function deliveryRows(store: ConveyorStore): DeliveryRow[] {
  return store.sqlite().query(`
    SELECT i.id AS issue_id, i.repository_id, i.source_number, i.title,
           MAX(st.created_at) AS delivered_at
    FROM stage_transitions st
    JOIN issues i ON i.id = st.issue_id
    WHERE st.status = 'completed'
      AND st.kind = 'advance'
      AND st.from_stage IS NOT NULL
      AND st.from_stage = st.to_stage
    GROUP BY i.id, i.repository_id, i.source_number, i.title
    ORDER BY delivered_at DESC, i.source_number DESC
  `).all() as DeliveryRow[];
}

function stateFor(issue: StoredIssue, activeIssueIds: ReadonlySet<string>, questionIssueIds: ReadonlySet<string>, store: ConveyorStore): RepositoryItemState {
  if (activeIssueIds.has(issue.id)) return "Running";
  if (questionIssueIds.has(issue.id) || NEEDS_YOU_STATES.has(issue.projectedState ?? "")) return "Needs you";
  if (BLOCKED_STATES.has(issue.projectedState ?? "")) return "Blocked";
  if (store.executions().getCursor(issue.id)?.state === "pending") return "Waiting";
  return "Queued";
}

function errorsFor(id: string, onboarding: ReadonlyMap<string, string>, reconciliation: ReadonlyMap<string, string>): string | null {
  const errors = [onboarding.get(id), reconciliation.get(id)].filter((value): value is string => Boolean(value));
  return errors.length === 0 ? null : [...new Set(errors)].join("\n");
}

/**
 * Builds dashboard data without contacting a provider or mutating the store. Error and time
 * inputs are supplied by the service because they are intentionally process-local facts.
 */
export function buildRepositorySummaries(input: BuildRepositorySummariesInput): RepositorySummaries {
  const { config, store, now = new Date(), lastReconciledAt = null } = input;
  const onboarding = input.onboardingErrors ?? new Map<string, string>();
  const reconciliation = input.reconciliationErrors ?? new Map<string, string>();
  const activeRuns = store.listActiveIssueRuns();
  const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
  const questionIssueIds = new Set(store.listOpenQuestions().map((question) => question.issueId));
  const issuesByRepository = new Map<string, StoredIssue[]>();
  for (const issue of input.issues ?? store.listIssues()) {
    if (!config.repositories[issue.repositoryId] || issue.projectedState === "offboarded") continue;
    issuesByRepository.set(issue.repositoryId, [...(issuesByRepository.get(issue.repositoryId) ?? []), issue]);
  }
  const recordedDeliveries = deliveryRows(store);
  const reportByRepository = new Map(
    buildReport({ store, config, period: "30d", repository: null, now }).byRepository.map((report) => [report.id, report]),
  );

  const repositories = Object.entries(config.repositories).map(([id, repository], index) => {
    const issues = issuesByRepository.get(id) ?? [];
    const nonDone = issues.filter(isActiveWork);
    const doneIssueIds = new Set(issues.filter(isDone).map((issue) => issue.id));
    const stages = config.pipelines[repository.pipeline]?.stages ?? [];
    const error = errorsFor(id, onboarding, reconciliation);
    // Dashboard fixtures and older in-process callers can carry partially-normalised
    // repository records. Keep this derived, read-only view safe while configuration
    // loading remains responsible for enforcing the complete production schema.
    const source = config.sources?.[repository.source];
    const codeHost = config.codeHosts?.[repository.codeHost ?? repository.source] ?? source;
    const ci = repository.ci ?? { mode: "disabled" as const };
    const ciProvider = ci.provider ? config.ci?.[ci.provider]?.type ?? null : null;
    const report = reportByRepository.get(id)!;

    return {
      id,
      address: repository.address,
      addressUrl: codeHost?.type === "github" ? `https://github.com/${repository.address}` : null,
      color: (index % 8) + 1,
      health: error === null ? "healthy" : "degraded",
      error,
      errorSummary: error === null ? null : concise(error, 240),
      lastReconciledAt,
      backlog: nonDone.filter((issue) => issue.projectedStage === null).length,
      stages: stages.map((stage) => ({
        id: stage.id,
        name: stage.name ?? displayName(stage.id),
        count: nonDone.filter((issue) => issue.projectedStage === stage.id).length,
      })),
      done: doneIssueIds.size,
      items: nonDone.map((issue) => ({
        number: issue.sourceNumber,
        title: issue.title,
        stage: issue.projectedStage,
        state: stateFor(issue, activeIssueIds, questionIssueIds, store),
      })),
      deliveries: recordedDeliveries
        .filter((delivery) => delivery.repository_id === id && doneIssueIds.has(delivery.issue_id))
        .slice(0, 10)
        .map((delivery) => ({ number: delivery.source_number, title: delivery.title, deliveredAt: delivery.delivered_at })),
      capacity: {
        busy: new Set(activeRuns
          .filter((run) => run.repository === id && !isLightweightRepositoryStage(config, run.repository, run.stageId))
          .map((run) => run.issueId)).size,
        slots: repository.concurrency,
      },
      setup: {
        pipeline: repository.pipeline,
        baseBranch: repository.baseBranch,
        itemProvider: source?.type ?? repository.source,
        itemSync: source?.type === "github" && source.autoConfigureWebhook && config.web.publicUrl ? "webhook" : "polling",
        ciProvider,
        ciMode: ci.mode,
        systemLabels: [...(repository.systemLabels ?? [])],
      },
      report30d: {
        delivered: report.delivered,
        inputTokens: report.inputTokens,
        outputTokens: report.outputTokens,
        agentMs: report.agentMs,
      },
    } satisfies RepositorySummary;
  });

  return {
    repositories,
    restrictedRepositories: Object.entries(config.repositories).map(([id, repository]) => ({
      id,
      folder: repository.folder,
      agentEgressHosts: [...(repository.agentEgress?.httpsHosts ?? [])],
    })),
  };
}
