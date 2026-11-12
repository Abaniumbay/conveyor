// What the dashboard reads (#675). The dashboard is a plugin fed by events and reads: it never sees
// the whole service or the whole store, only the store reads below and the live, process-local
// state that exists only in the running service (active runs, the scheduler, startup and
// repository health, the GitHub outage). ConveyorService provides one (`dashboardSources()`).

import type { ConveyorConfig } from "../config/load";
import type { StoredIssue } from "../db/store";
import type { AccountStore, ConversationStore, DatabaseStore, EvidenceStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { IssueCriterionViewModel, IssueJourneyViewModel, IssueWaitingViewModel, ManualGateViewModel } from "../web/types";
import type { RepositorySummaries } from "./repository-summary";

/** The store reads the dashboard makes. */
export type DashboardStore =
  & Pick<ItemStore,
    | "getIssue" | "listIssues" | "repositoryPause" | "listDependencies" | "listDependents" | "listChildren"
    | "getActiveWorkspace" | "hasMergedPullRequest" | "countFinishedIssues" | "listRecentActivity">
  & Pick<JournalStore, "executions" | "getStageState" | "currentStopSummary" | "listStageTransitions">
  & Pick<EvidenceStore, "todos" | "listIndicators" | "findings">
  & Pick<RunLogStore,
    | "listActiveIssueRuns" | "costSummary" | "costSummaryByStage" | "getRun" | "listRunsByKind" | "listRunEvents"
    | "listRunEventsPage" | "listIssueRunsPage" | "listHarnessRunEvents">
  & Pick<ConversationStore, "listOpenQuestions" | "listConversationMessages" | "latestConversationMessageIds">
  & Pick<AccountStore, "dashboardAccountByUsername">
  & Pick<DatabaseStore, "dashboardRevision">;

/** An item that is not running but waiting (on a check, a dependency, a GitHub outage) or queued for capacity. */
export type LiveIssueStatus = IssueWaitingViewModel & { kind: "waiting" | "queued" };

/** Per-item reads the scheduler would otherwise make itself; a caller that already holds them passes them in. */
export interface SchedulerLookups {
  stageState: (issueId: string) => ReturnType<JournalStore["getStageState"]>;
  dependencies: (issueId: string) => readonly string[];
  children: (issueId: string) => ReturnType<ItemStore["listChildren"]>;
  issue: (issueId: string) => StoredIssue | null;
}

/** A configuration-only drain, or one that waits for an upgrade. */
export interface DrainState {
  since: string;
  reason: string;
  upgrade: { targetVersion: string; releaseTag: string } | null;
}

/** Everything the dashboard reads: store reads, the configuration and the service's live state. */
export interface DashboardSources {
  readonly config: ConveyorConfig;
  readonly store: DashboardStore;
  /** Each repository's health, startup phase and errors, for `issues` (every item when omitted). */
  repositorySummaries(issues?: readonly StoredIssue[]): RepositorySummaries;
  /** Onboarding errors, then reconciliation errors, by repository id. */
  repositoryErrors(): Array<[repository: string, message: string]>;
  /** When the last pass over every repository finished, or null before the first. */
  lastReconciledAt(): string | null;
  /** The running drain, or null while work is admitted. */
  drain(): DrainState | null;
  /** The running GitHub outage and the items waiting on it, or null. */
  githubOutage(): { since: string; waitingItems: string[] } | null;
  /** What an item waits for after an infrastructure failure, or null. */
  retryWaiting(issueId: string): IssueWaitingViewModel | null;
  /**
   * Reads items' live waiting or queued status. The scheduler's view of `issues` is built once, on
   * the first read, so a caller asking about many items pays for it once.
   */
  liveStatusReader(issues: readonly StoredIssue[], lookups: SchedulerLookups): (issue: StoredIssue) => LiveIssueStatus | null;
  /** Where an item is now: its stage, state, why and since when; null for an unknown item. */
  itemNow(issueId: string): IssueJourneyViewModel["now"] | null;
  /** The recorded reason of the item's latest stop, which survives after its warning is cleared. */
  latestStopReason(issueId: string): string | null;
  /** Whether an item and all of its descendants meet the roll-up completion rule. */
  isRollupSatisfied(issueId: string): boolean;
  /** The item's manual gates in its current stage: whether each is required, waiting or approved. */
  manualGateViews(issue: StoredIssue): readonly ManualGateViewModel[];
  /** The item's acceptance criteria with their durable review approvals and linked tests. */
  criterionApprovalStates(issue: StoredIssue): IssueCriterionViewModel[];
  /** Whether a stopped item can be retried (the same rule the retry command applies). */
  retryableStoppedIssue(issue: StoredIssue, children: number, running: boolean): boolean;
  /** Whether a stopped roll-up parent can go back to waiting for its children. */
  resumableRollupIssue(issue: StoredIssue, children: number, running: boolean, hasOpenQuestion: boolean): boolean;
  /** The stage a retry of the item goes to when it is not the current one, or null. */
  retryTargetStage(issueId: string): string | null;
  /** Calls `listener` when live state the dashboard shows changes without a recorded event; returns the unsubscribe. */
  onLiveStateChange(listener: () => void): () => void;
  /** Calls `listener` once when the service starts closing. */
  onClose(listener: () => void): void;
}
