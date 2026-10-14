export type IssueTone = "active" | "success" | "warning" | "danger" | "muted";

export interface IssueRelationViewModel {
  id: string;
  repository: string;
  number: number;
  title: string;
  url: string | null;
  satisfied: boolean;
  /** A parent's child only: its station on the line (Backlog, each stage, Done). */
  station?: { index: number; count: number; name: string };
  /** A child or a dependency that is not finished: its andon signal, and its state in words ("Blocked"). */
  signal?: "run" | "wait" | "stop";
  state?: string;
}

export interface IssueWaitingViewModel {
  /** Waiting is a future gate poll; queued is runnable work held by capacity. */
  kind: "waiting" | "queued";
  reason: string;
  since: string;
  nextCheckAt: string | null;
  deadline: string | null;
}

/** A server-ready issue card with lightweight hierarchy references. */
export interface IssueTodosViewModel {
  finished: number;
  total: number;
  skipped: number;
  /** The item in progress, or else the next pending one; null when every item is terminal. */
  current: string | null;
  items: ReadonlyArray<{ id: string; text: string; status: "pending" | "in_progress" | "done" | "skipped"; note?: string }>;
}

export interface IssueCriterionViewModel {
  id: string;
  text: string;
  approved: boolean;
}

/** A native exit gate that a superuser may require or approve for this item. */
export interface ManualGateViewModel {
  stageId: string;
  gateId: string;
  configured: boolean;
  itemSpecific: boolean;
  waiting: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
}

export type { IndicatorViewModel } from "../app/indicators";
import type { IndicatorViewModel } from "../app/indicators";

export interface IssueCardViewModel {
  id: string;
  repository: string;
  /** One-based palette slot assigned by repository configuration order. */
  repositoryColor: number;
  number: number;
  title: string;
  url: string | null;
  state: string;
  labels: readonly string[];
  /** The GitHub issue type, when the owner defines types and one is set. */
  issueType: string | null;
  /** The repository-configured organization issue-field values that are set, in configuration order. */
  issueFields: ReadonlyArray<{ name: string; value: string }>;
  acceptanceCriteria: readonly IssueCriterionViewModel[];
  /** Current and future native exit gates; absent on older API payloads. */
  manualGates?: readonly ManualGateViewModel[];
  /** Request token copied into superuser forms rendered from this card. */
  csrfToken?: string;
  /** The implementer's todo list, kept by Conveyor; null until one is written. */
  todos: IssueTodosViewModel | null;
  /** The stage the item is in; card todo progress is shown only in the stage that owns the list. */
  stage?: string | null;
  /** Agents configured for this item's own pipeline stage, for board search metadata. */
  searchActors?: readonly StageActorViewModel[];
  /** Stored status indicators (CI first); rendered by one shared component on the card and in the details. */
  indicators: readonly IndicatorViewModel[];
  activity: string | null;
  reason: string | null;
  cost: string | null;
  duration: string | null;
  stateChangedAt: string | null;
  waiting: IssueWaitingViewModel | null;
  blocked: boolean;
  inconsistent: boolean;
  closable: boolean;
  noSplit: boolean;
  tone: IssueTone;
  parent: IssueRelationViewModel | null;
  /** A child only: how many of its parent's children are done. */
  parentProgress?: { done: number; total: number } | null;
  children: readonly IssueRelationViewModel[];
  dependencies: readonly IssueRelationViewModel[];
  working: boolean;
  /** True for stopped states and any item surfaced in Needs you. */
  needsAttention: boolean;
  retryable: boolean;
}

export interface ActiveRunViewModel {
  id: string;
  issueId: string;
  repository: string;
  issueNumber: number;
  issueTitle: string;
  stageId: string;
  kind: string;
  startedAt: string;
}

export interface IssueRunEventViewModel {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface IssueRunViewModel {
  id: string;
  stageId: string;
  attempt: number;
  kind: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  result: unknown | null;
  events: readonly IssueRunEventViewModel[];
  nextEventBefore: number | null;
}

export interface IssueActivityViewModel {
  issueId: string;
  runs: readonly IssueRunViewModel[];
  nextRunBefore: string | null;
}

export interface IssueRunEventsViewModel {
  issueId: string;
  runId: string;
  events: readonly IssueRunEventViewModel[];
  nextEventBefore: number | null;
}

export interface SystemStatusViewModel {
  memory: { usedBytes: number; totalBytes: number; processBytes: number };
  disk: { usedBytes: number; totalBytes: number; availableBytes: number };
  uptimeSeconds: number;
}

export interface IssueConversationMessageViewModel {
  id: number;
  stageId: string | null;
  actorType: string;
  actorId: string;
  actorName: string;
  actorAvatar?: string | null;
  actorTitle: string | null;
  message: string;
  createdAt: string;
}

export interface IssueConversationViewModel {
  issueId: string;
  messages: readonly IssueConversationMessageViewModel[];
}

export interface IssueJourneyTransitionViewModel {
  id: string;
  fromStage: string | null;
  toStage: string | null;
  kind: string;
  status: string;
  resultStatus: string | null;
  reason: string | null;
  requiredFixes: readonly string[];
  actor: string;
  createdAt: string;
  completedAt: string | null;
}

export interface IssueJourneyViewModel {
  issueId: string;
  now: {
    stage: string | null;
    state: string;
    reason: string | null;
    since: string | null;
  };
  transitions: readonly IssueJourneyTransitionViewModel[];
}

export interface StageActorViewModel {
  type: "agent" | "script";
  name: string;
  title: string | null;
}

export interface StageColumnViewModel {
  id: string;
  name: string;
  /** The stage's configured description, shown in its information dialog. */
  description?: string | null;
  /** The stage's configured emoji, shown beside its name. */
  icon?: string | null;
  actors: readonly StageActorViewModel[];
  cost: string | null;
  totalIssues: number;
  page: number;
  totalPages: number;
  issues: readonly IssueCardViewModel[];
}

export interface DashboardPageSelection {
  view: DashboardView;
  /** Configured repository selected by the repository detail page, if any. */
  repositoryId?: string | null;
  column: string | null;
  page: number;
  doneLimit: number;
  runId: string | null;
  issueId: string | null;
  /** Board-only client filters, also understood by the server for the Done column and no-JS form. */
  repositoryIds?: readonly string[];
  q?: string;
  state?: string | null;
}

export type DashboardView = "board" | "attention" | "agent" | "team" | "reports" | "repositories" | "repository" | "about" | "accounts" | "profile" | "notifications";

export interface RepositoryDashboardItem {
  number: number;
  title: string;
  stage: string | null;
  state: "Running" | "Queued" | "Waiting" | "Needs you" | "Blocked";
}

export interface RepositoryDashboardSummary {
  id: string;
  address: string;
  addressUrl: string | null;
  color: number;
  health: "healthy" | "degraded";
  error: string | null;
  errorSummary: string | null;
  lastReconciledAt: string | null;
  backlog: number;
  stages: readonly { id: string; name: string; count: number }[];
  done: number;
  items: readonly RepositoryDashboardItem[];
  deliveries: readonly { number: number; title: string; deliveredAt: string }[];
  capacity: { busy: number; slots: number };
  setup: {
    pipeline: string;
    baseBranch: string;
    itemProvider: string;
    itemSync: "webhook" | "polling";
    ciProvider: string | null;
    ciMode: "required" | "advisory" | "disabled";
    systemLabels: readonly string[];
  };
  report30d: { delivered: number; inputTokens: number; outputTokens: number; agentMs: number };
}

export interface RestrictedRepositoryDashboardSummary {
  id: string;
  folder: string;
  agentEgressHosts: readonly string[];
}

export interface DashboardAccountViewModel {
  id: string;
  username: string;
  role: "superuser" | "user";
  avatar: string;
}

export interface NotificationPreferencesViewModel {
  questions: boolean;
  stopped: boolean;
  done: boolean;
}

export interface SteeringEventViewModel {
  sequence: number;
  type: string;
  text: string;
  createdAt: string;
}

export interface SteeringRunViewModel {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  events: readonly SteeringEventViewModel[];
}

export interface SteeringViewModel {
  enabled: boolean;
  agent: string | null;
  selected: SteeringRunViewModel | null;
  recent: readonly { id: string; status: string; startedAt: string }[];
}

export interface QuestionViewModel {
  id: string;
  issueId: string;
  repository: string;
  /** One-based palette slot assigned by repository configuration order. */
  repositoryColor: number;
  issueNumber: number;
  issueTitle: string;
  prompt: string;
  reason: string;
  options: readonly { id: string; label: string }[];
  allowFreeText: boolean;
  answerError?: string | null;
}

export interface DashboardViewModel {
  title: string;
  project: string;
  totalUsage: string;
  harnessUsage: readonly HarnessQuotaViewModel[];
  updatedAt: string;
  revision: string;
  view: DashboardView;
  repositoryId: string | null;
  boardFilters?: { repositories: readonly string[]; q: string; state: string | null };
  counts: { board: number; attention: number };
  activeWork: {
    runnerCount: number;
    runnerCapacity: number;
    runs: readonly ActiveRunViewModel[];
  };
  stages: readonly StageColumnViewModel[];
  backlog: readonly IssueCardViewModel[];
  done: StageColumnViewModel;
  attention: StageColumnViewModel;
  questions: readonly QuestionViewModel[];
  needsYou: readonly IssueCardViewModel[];
  systemWarnings: readonly string[];
  /** Durable, provider-free repository summaries used by Board and repository views. */
  repositories: readonly RepositoryDashboardSummary[];
  /** Rendered only for a superuser on repository details. */
  restrictedRepositories: readonly RestrictedRepositoryDashboardSummary[];
  steering: SteeringViewModel;
  selectedIssue: IssueCardViewModel | null;
  /** Read-only agent profiles, loaded only for the team view. */
  team?: readonly AgentProfileViewModel[];
  report?: ReportViewModel;
  /** Dashboard accounts, loaded only for the superuser Accounts view. */
  accounts?: readonly DashboardAccountViewModel[];
  /** Browser-push categories, loaded only for the Notifications view. */
  notifications?: NotificationPreferencesViewModel;
  csrfToken: string;
  account?: DashboardAccountViewModel;
}

export interface HarnessQuotaViewModel {
  id: string;
  name: string;
  windows: import("../usage/quota").QuotaWindows;
}

export interface AgentSummaryViewModel {
  id: string;
  name: string;
  title: string;
}

export interface AgentUsageViewModel {
  /** Null for a role outside any pipeline, such as dashboard steering. */
  pipeline: string | null;
  stage: string | null;
  role: string;
}

export interface AgentProfileViewModel extends AgentSummaryViewModel {
  harness: string;
  model: string | null;
  effort: string | null;
  access: string;
  usage: readonly AgentUsageViewModel[];
  /** Granted MCP tool tasks grouped by task group, sorted. */
  tasks: ReadonlyArray<{ group: string; tasks: readonly string[] }>;
  /** Instruction text, or null when the file could not be read. */
  instructions: string | null;
}

export type ReportPeriod = "7d" | "30d" | "90d" | "12m" | "all";

/** Delivery totals and per-item averages over a set of items and runs. Durations in milliseconds. */
export interface ReportTotals {
  /** Items that finished their last stage in the period. */
  delivered: number;
  /** Items currently enrolled and not done. */
  inProgress: number;
  /** Runs started in the period, and how many of them did not succeed. */
  runs: number;
  failedRuns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Wall time of the runs started in the period. */
  agentMs: number;
  /** Averages over the delivered items, each counted over its whole life; null without delivered items. */
  avgTokensPerItem: number | null;
  avgRunsPerItem: number | null;
  avgLeadMs: number | null;
  avgAgentMs: number | null;
  avgChecksWaitMs: number | null;
  avgWaitingForYouMs: number | null;
  avgQueuedMs: number | null;
  avgReturnsPerItem: number | null;
  avgStopsPerItem: number | null;
  /** Share of delivered items that never went back to an earlier stage. */
  firstPassRate: number | null;
}

export interface ReportRepositoryRow extends ReportTotals {
  id: string;
}

export interface ReportMonthRow {
  /** YYYY-MM (UTC). */
  month: string;
  delivered: number;
  runs: number;
  tokens: number;
  agentMs: number;
  avgTokensPerItem: number | null;
  avgLeadMs: number | null;
}

export interface ReportStageRow {
  id: string;
  name: string;
  runs: number;
  failedRuns: number;
  tokens: number;
  agentMs: number;
  avgRunMs: number | null;
}

export interface ReportItemRow {
  repository: string;
  number: number;
  title: string;
  state: string;
  finishedAt: string | null;
  leadMs: number | null;
  agentMs: number;
  checksWaitMs: number;
  waitingForYouMs: number;
  runs: number;
  tokens: number;
  returns: number;
  stops: number;
}

export interface ReportViewModel {
  period: ReportPeriod;
  /** Start of the period (ISO), null for all time. */
  since: string | null;
  /** The drilled-into repository, or null for every repository. */
  repository: string | null;
  repositories: readonly string[];
  totals: ReportTotals;
  byRepository: readonly ReportRepositoryRow[];
  byMonth: readonly ReportMonthRow[];
  byStage: readonly ReportStageRow[];
  /** The items of the drilled-into repository with activity in the period (empty for every repository). */
  items: readonly ReportItemRow[];
  /** Done items imported without a recorded delivery; left out of every figure. */
  importedWithoutHistory: number;
  generatedAt: string;
}
