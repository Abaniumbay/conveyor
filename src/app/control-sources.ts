// What the operator interfaces read and send (#675): the CLI's control socket, the release
// coordinator and the operator MCP. Like the dashboard, they never see the whole service or the
// whole store, only the store reads below, the command bus and the live, process-local state that
// exists only in the running service. ConveyorService provides one (`controlSources()`).

import type { CommandBus } from "../commands/bus";
import type { ConveyorConfig } from "../config/load";
import type { AccountStore, ConversationStore, DatabaseStore, EvidenceStore, ItemStore, JournalStore, ReportStore, RunLogStore } from "../db/ports";
import type { CallSummary } from "../source/calls";
import type { IssueJourneyViewModel } from "../web/types";

/** A repository's place in the startup pass. */
export type StartupRepositoryPhase = "waiting" | "onboarding" | "reconciling";

/** Whether the service has finished starting, and which repository it is on. */
export type StartupStatus =
  | { state: "starting"; repository: string | null; phase: StartupRepositoryPhase | null }
  | { state: "ready"; repository: null; phase: null }
  | { state: "degraded"; repository: string | null; phase: null };

/** What `conveyor doctor` and the dashboard show of the service's GitHub requests. */
export interface GitHubCallReport extends CallSummary {
  /** When counting started; a window reaching further back covers only the time since. */
  countingSince: string;
  windowMs: number;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
}

/** Work in flight: items executing a stage, and steering runs. */
export interface ActiveWork {
  items: Array<{ issueId: string; repositoryId: string; stageId: string }>;
  steering: number;
}

/** The store reads the operator interfaces make (the operator MCP's tools read the item, run and evidence ones). */
export type ControlStore =
  & Pick<ItemStore,
    | "getIssue" | "getIssueByNumber" | "listIssues" | "listRepositories" | "listChildren" | "listDependencies"
    | "getCurrentPullRequest">
  & Pick<JournalStore, "listStageTransitions">
  & Pick<ConversationStore, "getQuestion" | "listOpenQuestions" | "listConversationMessages">
  & Pick<RunLogStore, "listIssueRuns" | "listIssueRunEventsAfter">
  & Pick<EvidenceStore, "listIndicators" | "criterionTestEvidence">
  & Pick<AccountStore, "operatorMcpTokenIsActive">
  & ReportStore
  & Pick<DatabaseStore, "schemaVersion" | "filename" | "backupTo">;

/** Everything the operator interfaces read, and the commands they send: changes go through `commands`. */
export interface ControlSources {
  readonly config: ConveyorConfig;
  readonly store: ControlStore;
  /** The command bus: every change is a command; the control socket also registers the commands only it can carry out. */
  readonly commands: Pick<CommandBus, "dispatch" | "handle" | "has">;
  /** Reconciled at least once, not stopping, and every repository onboarded and reconciling. */
  isReady(): boolean;
  startupStatus(): StartupStatus;
  /** The running drain, or null while work is admitted. */
  draining(): { since: string; reason: string } | null;
  /** The running GitHub outage and the items waiting on it, or null. */
  githubOutage(): { since: string; waitingItems: string[] } | null;
  activeWork(): ActiveWork;
  /** The last hour of GitHub requests and the token's rate limit. */
  githubCallReport(): Promise<GitHubCallReport>;
  /** Where an item is now: its stage, state, why and since when; null for an unknown item. */
  itemNow(issueId: string): IssueJourneyViewModel["now"] | null;
  /** Whether an agent (not a script) is running on the item. */
  hasRunningAgent(issueId: string): boolean;
  /** Whether a stopped roll-up parent can go back to waiting for its children. */
  canResumeRollupParent(issueId: string): boolean;
  /** Whether a stopped item can be retried (the same rule the retry command applies). */
  canRetryIssue(issueId: string): boolean;
  /** The stage a retry of the item goes to when it is not the current one, or null. */
  retryTargetStage(issueId: string): string | null;
  /** Creates and enrolls an issue in an onboarded repository; only the operator MCP offers it. */
  createIssue(input: { repository: string; title: string; body: string; idempotencyKey?: string | undefined }): Promise<{ issueId: string; number: number; url: string }>;
  /** Stops admitting new work for a release switch; running work continues. Idempotent. */
  drain(reason: string, upgrade: { targetVersion: string; releaseTag: string } | null): { since: string; reason: string };
  /** Admits new work again after a drain; false when no drain was in effect. */
  resumeAdmission(): boolean;
}

/** What the release coordinator reads and changes: the database it backs up, running work and admission. */
export type ReleaseSources = Pick<ControlSources, "store" | "activeWork" | "drain" | "resumeAdmission">;
