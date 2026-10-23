import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { freemem, homedir, tmpdir, totalmem, uptime } from "node:os";
import path from "node:path";

import { z } from "zod";

import { redactSecrets } from "../config/compose";
import { INTERNAL, selfCommand } from "../self";
import { log, type LogFields } from "../log/logger";
import { applyRetention, type RetentionPolicy, type RetentionReport } from "./retention";
import type { StageOutcome } from "../engine/stage-executor";
import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import { reconcileRepository } from "../core/reconciler";
import { evaluateIssueState } from "../core/issue-state";
import { inFlightAdmission, inFlightHolders, inFlightInterval, inFlightWaitReason, type InFlightInterval } from "../core/in-flight";
import { RepositoryPausedError } from "../core/repository-pause";
import { capacityBlockers, selectRunnableIssues, type ConcurrencyLimits, type SchedulerCandidate, type SchedulerOccupant } from "../core/scheduler";
import { applyClosedItemOffboarding, applyRollupTransition, applyStageTransition } from "../core/transition";
import { ConveyorStore, type StoredIssue, type StoredQuestion } from "../db/store";
import { claudeCodeHarness } from "../harness/claude-code";
import { codexHarness } from "../harness/codex";
import type { Harness } from "../harness/types";
import { GitHubAdapter, GitHubTransportError, isStatusComment, verifyGitHubSignature } from "../source/github/adapter";
import { followUpsFromBody } from "../source/github/managed-sections";
import { GitHubRepositoryTrust } from "../source/github/trust";
import type { SourceIssue } from "../source/types";
import { GitHubActionsCiProvider, focusGitHubActionsLog, parseGitHubActionsTriggers } from "../source/github/ci-provider";
import type { CiChange, CiProvider, CiRun } from "./ci-provider";
import { CodeHostRegistry } from "../codehost/registry";
import type { ChangeDelivery, CodeHost } from "../codehost/types";
import { changeAction, pushAndEnsureChange, recoverClosedChange } from "../codehost/actions";
import { renderStatusComment } from "../source/github/status-comment";
import { canonicalToolName } from "../tasks/aliases";
import { conveyorToolGuidance } from "../mcp/guidance";
import { dispatchTool } from "../tasks/dispatch";
import { runCodexSteering, type CodexSteeringInput } from "../runner/codex-steering";
import { WorkspaceManager } from "../workspace/manager";
import { formatDuration, formatUsage } from "../web/format";
import type { DashboardPageSelection, DashboardViewModel, FilesystemStatusViewModel, GraphNodeViewModel, GraphRelationshipViewModel, IndicatorViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRelationViewModel, IssueRunEventsViewModel, IssueStageBadgeViewModel, IssueTodosViewModel, IssueTone, IssueWaitingViewModel, QuestionViewModel, RecentActivityEventViewModel, RecentActivityType, RecentActivityViewModel, StageActorViewModel, StageColumnViewModel, SteeringViewModel, SystemStatusViewModel } from "../web/types";
import { readClaudeQuota, readCodexQuota } from "../usage/quota";
import type { WebAuthApi, WebHandlerDependencies } from "../web/server";
import { deliverPushEvents, type PushConfiguration } from "../web/push";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type ScopedMcpLease, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";
import { infrastructureRetry, isUsageLimitError } from "./retry-policy";
import { buildAgentProfiles } from "./agent-profiles";
import { createTaskRegistry } from "../tasks/catalogue";
import { runTask } from "../tasks/contract";
import type { TaskDeps } from "../tasks/deps";
import { criteriaOf } from "../tasks/item";
import { CriterionApprovals, isCriterionApprovedAt } from "../engine/review-records";
import { compilePipeline } from "../tasks/plan";
import { cliGit } from "../workspace/git";
import { removeWorkspace } from "../workspace/lifecycle";
import { AdvisoryCiWatches, DEFAULT_POLL_MS as ADVISORY_POLL_MS } from "../engine/advisory-ci";
import { ItemTodos, summarizeTodos, type TodoItem } from "../engine/todos";
import { buildReport } from "./reports";
import { buildRepositorySummaries, type RepositorySummaries } from "./repository-summary";
import { isLightweightRepositoryStage } from "./stage-capacity";
import { CI_INDICATOR_ID, indicatorView, observeCi, observeCiError, startCiForHead, type StoredIndicator } from "./indicators";
import { createCiGateMemory, evaluateCiGate, parseCiGateOptions, type SourceActionOutcome } from "./ci-gate";
import {
  conversationQuestionAnswer,
  questionConfigurationError,
  questionOptions,
  scheduledQuestionAnswerEvidence,
  validatedQuestionAnswer,
} from "../questions";
import { ManualGateApprovals } from "../engine/manual-gates";
import { CommandBus, CommandForbiddenError, CommandInputError, type CommandActor } from "../commands/bus";
import { EventBus } from "../events/bus";
import { JsonlEventSink, SinkRunner, type EventSink } from "../events/sinks";
import { isEventOf, type EventType, type StoredEvent } from "../events/catalogue";
import { withEventContext } from "../events/context";
import { normalizeGitHubEvent } from "../source/github/events";
import { deliveredIssueChange } from "../source/github/delivery-issue";
import type { WaitKind } from "../events/topics";
import { WaitDispatcher } from "./wait-dispatcher";
import { changesDashboard, DashboardFeed } from "./dashboard-feed";
import { normalizeDashboard } from "../web/model";
import { GITHUB_CALL_SOURCES, GitHubCallMeter, withGitHubCallSource, type GitHubCallSource, type GitHubCallSummary } from "../source/github/call-meter";
import { ReviewFindings, type FindingType } from "../engine/review-findings";
import { BOARD_APPROVAL_TASK_ID, ENTRY_APPROVAL_TASK_ID, type BoardApprovalResolver, type ManualGateResolver, type ManualGateWaitingNotifier } from "../engine/stage-executor";

const FOLLOW_UP_GATE_TASK = "item.followUps";
const CLOSED_ITEM_RECOVERY_AGE_MS = 60 * 60 * 1000;

/** Code host methods that change a change or its branch; each drops what was read about the repository's changes. */
const CODE_HOST_WRITES = new Set([
  "pushBranch", "ensureChange", "mergeChange", "setChangeChecklist", "setChangeDescription",
  "createFinding", "resolveFindingProjection", "resolveNativeFinding", "deleteBranch",
]);

/** GitHub adapter methods that can change a source repository. */
const GITHUB_WRITES = new Set([
  "setIssueType", "setIssueFieldValues", "setTitle", "setParent", "setDependencies",
  "replaceConveyorLabels", "replaceManagedProjectLabels", "upsertStatusComment", "addComment",
  "createComment", "updateComment", "createReviewComment", "deleteBranchRef", "replyToReviewComment",
  "reactToReviewComment", "reactToIssueComment", "replyToReviewThread", "resolveReviewThread",
  "reactToReviewThread", "updateManagedSection", "ensurePullRequest", "setPullRequestChecklist",
  "setPullRequestDescription", "retriggerLabel", "rerunJob", "squashMerge", "closeIssue",
  "createChildIssue", "ensureLabels", "ensureWebhook", "pingHook", "redeliverHookDelivery",
]);


interface ActiveRun {
  repositoryId: string;
  stageId: string;
  controller: AbortController;
  /** Runs no runner process; excluded from global and repository permits. */
  lightweight: boolean;
  interrupted: boolean;
}

type LiveIssueStatus = IssueWaitingViewModel & { kind: "waiting" | "queued" };

type StartupRepositoryPhase = "waiting" | "onboarding" | "reconciling";

export type StartupStatus =
  | { state: "starting"; repository: string | null; phase: StartupRepositoryPhase | null }
  | { state: "ready"; repository: null; phase: null }
  | { state: "degraded"; repository: string | null; phase: null };

interface McpGrant {
  runId: string;
  stageId: string;
  context: RuntimeIssueContext | null;
  allowedTools: Set<string>;
  actor: { id: string; name: string; title: string } | null;
  /** Responses, including in-flight ones, keyed by the client's transport-retry token. */
  calls: Map<string, Promise<unknown>>;
}

/** What `conveyor doctor` and the dashboard show of the service's GitHub requests. */
export interface GitHubCallReport extends GitHubCallSummary {
  /** When counting started; a window reaching further back covers only the time since. */
  countingSince: string;
  windowMs: number;
  rateLimit: { limit: number; remaining: number; resetAt: string } | null;
}

interface ServiceImplementations {
  steering?: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;
  codeHosts?: CodeHostRegistry;
  /** Agent harnesses by runner type; defaults to Codex. */
  harnesses?: Record<string, Harness>;
  /** Counts the GitHub requests of the adapter's transport; a fresh meter when it has none. */
  githubCalls?: GitHubCallMeter;
  /** Event sinks beyond the configured ones (an embedding application's own consumers). */
  eventSinks?: EventSink[];
}

type StatfsReader = (location: string) => Promise<{ blocks: number; bsize: number; bavail: number }>;
type StatReader = (location: string) => Promise<{ dev: number }>;

const recentActivityCandidateLimit = 500;

export async function collectSystemStatus(options: {
  database: string;
  artifacts: string;
  temporaryDirectory: string;
  workspaceScratch: string;
  statfs?: StatfsReader;
  stat?: StatReader;
  memory?: { totalBytes: number; freeBytes: number; processBytes: number; uptimeSeconds: number };
}): Promise<SystemStatusViewModel> {
  const readStatfs: StatfsReader = options.statfs ?? statfs;
  const readStat: StatReader = options.stat ?? stat;
  const filesystem = async (location: string): Promise<{ status: FilesystemStatusViewModel; device: number | null }> => {
    try {
      const stats = await readStatfs(location);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes) || totalBytes <= 0 || availableBytes < 0) {
        return { status: { available: false }, device: null };
      }
      const device = await readStat(location).then(({ dev }) => dev).catch(() => null);
      return { status: { available: true, usedBytes: totalBytes - availableBytes, totalBytes, availableBytes }, device };
    } catch {
      return { status: { available: false }, device: null };
    }
  };
  const [diskMeasurement, artifactsMeasurement, temporaryMeasurement, workspaceScratchMeasurement] = await Promise.all([
    filesystem(options.database), filesystem(options.artifacts), filesystem(options.temporaryDirectory), filesystem(options.workspaceScratch),
  ]);
  const memory = options.memory ?? {
    totalBytes: totalmem(), freeBytes: freemem(), processBytes: process.memoryUsage().rss, uptimeSeconds: Math.floor(uptime()),
  };
  const sharesFilesystem = artifactsMeasurement.device !== null && artifactsMeasurement.device === temporaryMeasurement.device;
  const workspaceScratchSharesFilesystem = artifactsMeasurement.device !== null
    && artifactsMeasurement.device === workspaceScratchMeasurement.device;
  return {
    memory: { usedBytes: memory.totalBytes - memory.freeBytes, totalBytes: memory.totalBytes, processBytes: memory.processBytes },
    disk: diskMeasurement.status,
    storage: {
      artifacts: artifactsMeasurement.status,
      temporaryDirectory: sharesFilesystem
        ? { ...temporaryMeasurement.status, sharesFilesystemWithArtifacts: true }
        : temporaryMeasurement.status,
      workspaceScratch: workspaceScratchSharesFilesystem
        ? { ...workspaceScratchMeasurement.status, sharesFilesystemWithArtifacts: true }
        : workspaceScratchMeasurement.status,
    },
    uptimeSeconds: memory.uptimeSeconds,
  };
}

const SOURCE_GUIDANCE = `GitHub is the source of truth. Use only Conveyor MCP tools for source mutations. Agents never close source issues; Conveyor itself closes only an active completed roll-up parent after its descendant-completion rule passes. Preserve human-authored body text, use managed sections for acceptance criteria, pull-request descriptions, and dependencies, and report blockers with a concrete reason.`;
const DASHBOARD_PAGE_SIZE = 20;
/** The live model holds every current item and the most recent finished ones; older ones are paged. */
const DASHBOARD_SNAPSHOT_SELECTION: DashboardPageSelection = {
  view: "board", repositoryId: null, column: null, page: 1, doneLimit: 50, runId: null, issueId: null,
  repositoryIds: [], q: "", state: null, recentTypes: [], recentCursor: null,
};
const ACTIVITY_RUN_PAGE_SIZE = 1;
const ACTIVITY_EVENT_PAGE_SIZE = 5;
const STOPPED_ISSUE_STATES = new Set(["blocked", "error", "needs-input", "needs-intervention", "rejected"]);
type ScheduledOperatorOutcome = {
  outcome: "retried" | "answered" | "unresolved";
  reason: string;
  evidence?: string;
};
type ScheduledOperatorCheck = {
  targets: Set<string>;
  inspected: Set<string>;
  outcomes: Map<string, ScheduledOperatorOutcome>;
};
/** How long an unchanged issue's sub-issues and blockers are reused before they are read again. */
const RELATIONSHIP_REUSE_MS = 60 * 60_000;
/** The same while the repository's webhooks are healthy and report relationship changes. */
const HEALTHY_RELATIONSHIP_REUSE_MS = 6 * 60 * 60_000;
/** Changes that can make an item runnable; the scheduler runs after them. */
// Reconciles and stage runs schedule as part of the scheduler's own loop; these are the changes a
// person's action makes that can let an item run.
const SCHEDULING_EVENTS: readonly EventType[] = [
  "task.woken", "worker.released", "item.requeued", "gate.requirementChanged", "gate.boardApprovalChanged", "command.accepted",
];
/** How far back missed webhook deliveries are redelivered, and at most how many per pass. */
const REDELIVERY_WINDOW_MS = 24 * 60 * 60_000;
const REDELIVERY_LIMIT = 50;
/** How often each repository's webhook is asked how its deliveries go. */
/** How often Conveyor looks at whether deliveries arrive. */
const WEBHOOK_CHECK_MS = 5 * 60_000;
/** A repository without any delivery for this long gets a ping, to tell a quiet repository from a broken webhook. */
const WEBHOOK_QUIET_MS = 60 * 60_000;
/** A ping that has not arrived after this long means deliveries do not arrive. */
const WEBHOOK_PING_TIMEOUT_MS = 5 * 60_000;
/** How often the GitHub request counts are logged, and the window they cover. */
const GITHUB_CALL_SUMMARY_MS = 60 * 60_000;
/** A partial issue list starts this much before the previous read began, so clock skew and in-flight edits are not missed. */
const ISSUE_LISTING_OVERLAP_MS = 2 * 60_000;

function resultReason(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const direct = (value as { reason?: unknown }).reason;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = (value as { stageResult?: unknown }).stageResult;
  return nested === value ? null : resultReason(nested);
}

/** The durable stop record survives after the transient issue warning is cleared. */
function latestStop(store: ConveyorStore, issueId: string): {
  reason: string | null;
  stoppedAt: string | null;
  sourceSnapshot: { title: string; body: string } | null;
} {
  const latestTransition = [...store.listStageTransitions(issueId)].reverse().find(
    (candidate) => candidate.status === "completed",
  );
  if (latestTransition) {
    return latestTransition.kind === "stopped"
      ? {
          reason: latestTransition.reason,
          stoppedAt: latestTransition.completedAt ?? latestTransition.createdAt,
          sourceSnapshot: latestTransition.sourceSnapshot ?? null,
        }
      : { reason: null, stoppedAt: null, sourceSnapshot: null };
  }
  const latestRun = store.listIssueRuns(issueId)[0];
  return {
    reason: resultReason(latestRun?.result),
    stoppedAt: latestRun?.finishedAt ?? null,
    sourceSnapshot: null,
  };
}

/** The durable stop reason survives after the transient issue warning is cleared. */
function latestStopReason(store: ConveyorStore, issueId: string): string | null {
  return latestStop(store, issueId).reason;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

/** Like `object`, but an absent or malformed value reads as an empty object. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function number(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function displayName(value: string): string {
  const acronyms = new Set(["api", "ci", "qa", "sre", "ui", "ux"]);
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => acronyms.has(part.toLowerCase())
      ? part.toUpperCase()
      : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function itemStageBadge(
  stageId: string | null,
  stageNames: ReadonlyMap<string, string>,
  stageIcons: ReadonlyMap<string, string>,
  position: "backlog" | "done" | "offboarded" | null,
): IssueStageBadgeViewModel {
  if (position === "backlog") return { name: "Backlog", icon: null, offboarded: false };
  if (position === "done") return { name: "Done", icon: null, offboarded: false };
  const name = stageId === null ? "Unknown stage" : stageNames.get(stageId) ?? displayName(stageId);
  return { name, icon: stageId === null ? null : stageIcons.get(stageId) ?? null, offboarded: position === "offboarded" };
}

function userFacingSteeringEvent(event: {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}): { sequence: number; type: string; text: string; createdAt: string } | null {
  try {
    const payload = object(event.payload);
    let text: string | null = null;
    if (["user", "report", "error"].includes(event.type)) {
      text = typeof payload.text === "string" ? payload.text : null;
    } else if (["report_progress", "report_milestone", "report_blocker"].includes(event.type)) {
      text = typeof payload.message === "string"
        ? payload.message
        : typeof payload.summary === "string"
          ? payload.summary
          : typeof payload.reason === "string"
            ? payload.reason
            : null;
    }
    return text
      ? { sequence: event.sequence, type: event.type, text, createdAt: event.createdAt }
      : null;
  } catch {
    return null;
  }
}

function listenPort(listen: string): number {
  const separator = listen.lastIndexOf(":");
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid web listen address: ${listen}`);
  }
  return port;
}

function labelDefinitions(config: ConveyorConfig, repositoryId: string) {
  const repository = config.repositories[repositoryId]!;
  const pipeline = config.pipelines[repository.pipeline]!;
  const labels = [
    { name: config.labels.enrollment, color: "2563eb", description: "Enrolled in Conveyor" },
    ...pipeline.stages.map((stage) => ({
      name: config.labels.stageTemplate.replace("{stage}", stage.id),
      color: "0ea5e9",
      description: `Conveyor stage: ${stage.id}`,
    })),
    ...Object.entries(config.labels.states).map(([state, name]) => ({
      name,
      color: state === "done" ? "16a34a" : state === "rejected" ? "6b7280" : "d97706",
      description: `Conveyor state: ${state}`,
    })),
    { name: config.labels.metadata.closable, color: "8b5cf6", description: "Conveyor considers this issue closable" },
    { name: config.labels.metadata.noSplit, color: "0f766e", description: "Conveyor will not split this issue" },
    ...repository.systemLabels.map((name) => ({
      name,
      color: "64748b",
      description: "Project system area",
    })),
  ];
  return [...new Map(labels.map((label) => [label.name, label])).values()];
}

function metadataLabels(sourceLabels: readonly string[], config: ConveyorConfig): string[] {
  const orderPrefix = config.labels.metadata.orderTemplate.split("{number}")[0]!;
  return sourceLabels.filter((label) =>
    label === config.labels.metadata.closable ||
    label === config.labels.metadata.noSplit ||
    label.startsWith(orderPrefix),
  );
}

function questionAnswerText(answer: unknown): string | null {
  if (typeof answer === "string") return answer;
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { answer?: unknown }).answer;
  return typeof value === "string" ? value : null;
}

function questionAnswerEvidence(answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return null;
  const value = (answer as { evidence?: unknown }).evidence;
  return typeof value === "string" ? value : null;
}

/** The run-scoped MCP server: this executable's internal `__mcp` subcommand. */
function mcpServerCommand(contextFile: string): { command: string; args: string[] } {
  const [command, ...args] = selfCommand(INTERNAL.mcp, "--context", contextFile);
  return { command: command!, args };
}

export class ConveyorService {
  readonly store: ConveyorStore;
  readonly github: GitHubAdapter;
  readonly #codeHosts: CodeHostRegistry;
  readonly workspaceManager: WorkspaceManager;
  readonly #active = new Map<string, ActiveRun>();
  /** Live answer mirrors are guarded in memory; persisted pending mutations can be retried after a restart. */
  readonly #answerMirrorsInFlight = new Set<string>();
  readonly #statusCommentUpdates = new Set<Promise<void>>();
  readonly #statusCommentUpdatesByIssue = new Map<string, Promise<void>>();
  /** The status-comment digest last written by this process, so a revert to older content is still written. */
  readonly #statusCommentDigests = new Map<string, string>();
  /** The status comment of each issue, as last written, so an update goes straight to it without listing comments. */
  readonly #statusCommentIds = new Map<string, number>();
  /** The live head of an open change, as last read from the code host; newer than the persisted context. */
  readonly #liveChangeHeads = new Map<string, string>();
  /** The live dashboard model, rebuilt once per burst of changes for every open dashboard. */
  readonly #dashboardFeed = new DashboardFeed({
    build: () => normalizeDashboard(this.dashboard("", { ...DASHBOARD_SNAPSHOT_SELECTION }), {
      conversations: this.store.latestConversationMessageIds(),
    }),
    status: () => this.systemStatus(),
  });
  /** Sub-issues and blockers last read per issue, reused while the issue is unchanged (see `relationshipsOf`). */
  readonly #relationships = new Map<string, { updatedAt: string; readAt: number; children: SourceIssue[]; dependencies: SourceIssue[] }>();
  /** Per repository: the time the next listing of changed issues may start from. */
  readonly #issueListings = new Map<string, { since: string }>();
  /** Webhook reconciles per repository: the one running or queued last, and one not yet started that later deliveries join. */
  readonly #webhookReconciles = new Map<string, Promise<void>>();
  readonly #queuedWebhookReconciles = new Map<string, { issueNumbers: Set<number> | null; done: Promise<void> }>();
  /** Webhook deliveries accepted but not yet processed. */
  readonly #webhookWork = new Set<Promise<void>>();
  readonly #retrying = new Set<string>();
  readonly #resumingRollups = new Set<string>();
  readonly #steeringActive = new Map<string, AbortController>();
  readonly #steeringCompletions = new Map<string, Promise<void>>();
  /** A scheduled check may act only on these snapshots; history reads are tracked per run. */
  readonly #scheduledOperatorChecks = new Map<string, ScheduledOperatorCheck>();
  readonly #mcpGrants = new Map<string, McpGrant>();
  /** Consecutive infrastructure failures per issue, for the stage they happened in. */
  readonly #infrastructureFailures = new Map<string, {
    stageId: string;
    count: number;
    waiting?: IssueWaitingViewModel;
  }>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  /** Repositories not yet admitted to scheduling during the first startup pass. */
  readonly #startupRepositories = new Map<string, StartupRepositoryPhase>();
  #startupStarted = false;
  #startupRunning = false;
  #startupCompleted = false;
  #startupFailed = false;
  /** Delayed infrastructure retries that must not outlive the service store. */
  readonly #retryTimers = new Set<ReturnType<typeof setTimeout>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #periodicOperatorTimer: ReturnType<typeof setInterval> | null = null;
  readonly #ciMemory = createCiGateMemory();
  readonly #ciProviders = new Map<string, CiProvider>();
  /** Fires a schedule pass at the earliest persisted wake-up of a parked item. */
  #wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires an advisory CI poll at the earliest wake-up of an active watch. */
  #advisoryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #advisoryWatches: AdvisoryCiWatches;
  #advisoryPolling = false;
  #lastReconciledAt: string | null = null;
  #shuttingDown = false;
  #tickRunning = false;
  /** While set, no new work is admitted; work already running finishes. */
  #drain: { since: string; reason: string; upgrade: { targetVersion: string; releaseTag: string } | null } | null = null;
  #retentionTimer: ReturnType<typeof setInterval> | null = null;
  #retentionActive = 0;
  #githubCallTimer: ReturnType<typeof setInterval> | null = null;
  /** Counts every GitHub request this service makes, by why it was made. */
  readonly githubCalls: GitHubCallMeter;
  /** Every committed change, published in order after its transaction; subscribers react to them. */
  readonly events: EventBus;
  /** The only way the dashboard and the CLI change anything. */
  readonly commands: CommandBus;
  /** Configured event sinks, delivered from their own cursors while the service runs. */
  readonly #sinks: SinkRunner[];
  /** Per repository: whether its webhook delivers, as last checked or shown by a delivery. */
  readonly #webhookHealth = new Map<string, boolean>();
  /** When each repository last received a delivery, and when Conveyor last pinged its webhook. */
  readonly #webhookDeliveredAt = new Map<string, number>();
  readonly #webhookPingedAt = new Map<string, number>();
  readonly #webhookIds = new Map<string, number>();
  /** Repositories whose deliveries Conveyor may not list; warned about once. */
  readonly #redeliveryDenied = new Set<string>();
  /** Operator syncs in progress, by repository. */
  readonly #repositorySyncs = new Map<string, Promise<{ issues: number; failed: boolean }>>();
  /** When each repository was last read by a pass of the periodic tick, startup or a sync. */
  readonly #repositoryReconciledAt = new Map<string, number>();
  #webhookHealthTimer: ReturnType<typeof setInterval> | null = null;
  readonly #waitDispatcher: WaitDispatcher;
  #scheduleRequested = false;
  /** Parked items made due by an answer, approval or other event, not by their wake-up time. */
  readonly #wokenEarly = new Set<string>();
  readonly #harnesses: Record<string, Harness>;
  readonly #runSteering: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;
  readonly #manualGateApprovals: ManualGateApprovals;
  readonly #issueTrust: GitHubRepositoryTrust;

  constructor(
    readonly config: ConveyorConfig,
    store: ConveyorStore,
    github: GitHubAdapter,
    implementations: ServiceImplementations = {},
  ) {
    this.store = store;
    this.github = github;
    this.#issueTrust = new GitHubRepositoryTrust(github);
    this.#codeHosts = implementations.codeHosts ?? new CodeHostRegistry();
    this.githubCalls = implementations.githubCalls ?? new GitHubCallMeter();
    this.events = new EventBus();
    store.events().attach(this.events);
    this.commands = new CommandBus(store.events());
    this.#waitDispatcher = new WaitDispatcher({
      journal: store.executions(),
      addressOf: (repositoryId) => config.repositories[repositoryId]?.address ?? null,
      numberOf: (issueId) => store.getIssue(issueId)?.sourceNumber ?? null,
      wake: (issueId) => { this.wakeParked(issueId); },
    });
    this.registerCommands();
    this.subscribeToEvents();
    const logging = config.settings.logging;
    const sinks: EventSink[] = [
      ...(config.settings.events?.sinks ?? []).map((sink) => new JsonlEventSink(sink.path, {
        maxBytes: (logging?.maxFileMegabytes ?? 10) * 1024 * 1024, keepFiles: logging?.keepFiles ?? 5,
      })),
      ...(implementations.eventSinks ?? []),
    ];
    this.#sinks = sinks.map((sink) => new SinkRunner(store.events(), sink));
    this.workspaceManager = new WorkspaceManager(config.settings.workspaces);
    this.#runSteering = implementations.steering ?? runCodexSteering;
    this.#harnesses = implementations.harnesses ?? { codex: codexHarness, "claude-code": claudeCodeHarness };
    this.#manualGateApprovals = new ManualGateApprovals(store.sqlite());
    this.#advisoryWatches = new AdvisoryCiWatches(store.sqlite(), store.executions(), {
      resolve: (repositoryId) => ({
        provider: this.ciProvider(repositoryId),
        address: this.config.repositories[repositoryId]?.address ?? "",
        ignoreChecks: this.config.repositories[repositoryId]?.ci.ignoreChecks ?? [],
      }),
      post: (itemId, stage, message) => {
        this.store.appendConversationMessage({
          issueId: itemId, runId: null, stageId: stage, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator", message,
        });
      },
      observe: (watch, observation) => {
        const base = {
          issueId: watch.itemId, headSha: watch.headSha, changeUrl: watch.changeUrl,
          ignoreChecks: this.config.repositories[watch.repositoryId]?.ci?.ignoreChecks ?? [], now: new Date(), authoritative: false,
        };
        if ("runs" in observation) observeCi(this.store, { ...base, runs: observation.runs });
        else observeCiError(this.store, { ...base, error: observation.error });
      },
      onError: (watch, error) => log.warn("Advisory CI watch failed", { ...this.itemFields(watch.itemId), commit: watch.headSha.slice(0, 7) }, error),
      // A finished run wakes a watch; while webhooks deliver, reading CI on a timer is only the fallback.
      pollMs: (repositoryId) => this.waitFallbackMs(repositoryId, "ci") ?? ADVISORY_POLL_MS,
    });
  }

  static async create(
    config: ConveyorConfig,
    github: GitHubAdapter,
    codeHosts: CodeHostRegistry,
    githubCalls?: GitHubCallMeter,
  ): Promise<ConveyorService> {
    await ensureRuntimeDirectories(config);
    const store = await ConveyorStore.open(config.settings.database);
    const removedRepositories = store.removeRepositoriesExcept(Object.keys(config.repositories));
    if (removedRepositories.length > 0) {
      log.info("Removed unconfigured repositories from the local index", { repositories: removedRepositories });
    }
    // The snapshot is history, not a credential store: values that came from !secret are redacted.
    store.recordConfigSnapshot(config.hash, redactSecrets(config, config.secrets ?? []));
    // The copy of GitHub lives in the database, so a restart does not read it all again.
    github.useMirror?.(store.githubMirror(), config.settings.githubCache);
    const service = new ConveyorService(
      config,
      store,
      github,
      { codeHosts, ...(githubCalls ? { githubCalls } : {}) },
    );
    const recovered = store.recoverInterruptedExecutions(config.hash);
    if (recovered.runs > 0 || recovered.stages > 0) {
      log.warn("Recovered interrupted work after restart", { runs: recovered.runs, stages: recovered.stages });
      for (const stage of recovered.recoveredStages) {
        log.info("Stage queued after restart", { ...service.itemFields(stage.issueId), stage: stage.stageId });
      }
    }
    service.prepareStartupPass();
    return service;
  }

  /** The process-local state of the first pass, for the control socket and dashboard. */
  startupStatus(): StartupStatus {
    if (this.#startupRunning || (this.#startupStarted && !this.#startupCompleted)) {
      const current = [...this.#startupRepositories.entries()].find(([, phase]) => phase !== "waiting")
        ?? (!this.#startupRunning ? this.#startupRepositories.entries().next().value ?? null : null);
      return { state: "starting", repository: current?.[0] ?? null, phase: current?.[1] ?? null };
    }
    const failed = [...this.#onboardingErrors.keys(), ...this.#repositoryErrors.keys()][0] ?? null;
    if (this.#startupFailed && failed === null) return { state: "degraded", repository: null, phase: null };
    return failed === null ? { state: "ready", repository: null, phase: null } : { state: "degraded", repository: failed, phase: null };
  }

  async onboardRepositories(): Promise<void> {
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      await this.onboardRepository(id, repository);
    }
  }

  /** The URL GitHub delivers a repository's webhook events to, when Conveyor manages its webhook. */
  private webhookUrl(repositoryId: string): string | null {
    const repository = this.config.repositories[repositoryId];
    const source = repository ? this.config.sources?.[repository.source] : undefined;
    if (source?.type !== "github" || !source.autoConfigureWebhook || !this.config.web?.publicUrl) return null;
    return new URL(source.webhookPath, this.config.web.publicUrl).href;
  }

  /** Whether a repository's webhook delivers events, so waits may rely on them. */
  /** Whether the repository's deliveries are known to arrive; false only after a ping went undelivered. */
  webhooksHealthy(repositoryId: string): boolean {
    return this.#webhookHealth.get(repositoryId) !== false;
  }

  /**
   * Asks GitHub to send the repository's webhook a ping; its arrival shows deliveries work. A failed
   * request (an outage, the rate limit) changes nothing: health is decided by deliveries alone.
   */
  async pingWebhook(repositoryId: string): Promise<boolean> {
    if (this.store.repositoryPause(repositoryId)) return false;
    const address = this.config.repositories[repositoryId]?.address;
    const hookId = this.#webhookIds.get(repositoryId);
    if (!this.webhookUrl(repositoryId) || !address || hookId === undefined) return false;
    try {
      await this.executionGitHub(repositoryId).pingHook(address, hookId);
      this.#webhookPingedAt.set(repositoryId, Date.now());
      return true;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return false;
      log.warn("Could not ask GitHub to ping the webhook", { repository: repositoryId }, error);
      return false;
    }
  }

  /**
   * Webhook health from deliveries: a repository quiet for an hour gets a ping, and only a ping that
   * does not arrive marks it unhealthy, for an admin to investigate. Nothing else changes with it.
   */
  async superviseWebhooks(now = Date.now()): Promise<void> {
    for (const repositoryId of Object.keys(this.config.repositories)) {
      if (!this.webhookUrl(repositoryId)) continue;
      const delivered = this.#webhookDeliveredAt.get(repositoryId) ?? 0;
      const pinged = this.#webhookPingedAt.get(repositoryId);
      const awaitingPing = pinged !== undefined && delivered < pinged;
      if (awaitingPing && now - pinged >= WEBHOOK_PING_TIMEOUT_MS) this.setWebhookHealth(repositoryId, false);
      if (now - Math.max(delivered, pinged ?? 0) >= WEBHOOK_QUIET_MS) await this.pingWebhook(repositoryId);
    }
  }

  /** A delivery arrived: the webhook works. One after an outage also asks for what was missed. */
  private webhookDelivered(repositoryId: string): void {
    this.#webhookDeliveredAt.set(repositoryId, Date.now());
    const recovered = this.#webhookHealth.get(repositoryId) === false;
    this.setWebhookHealth(repositoryId, true);
    if (recovered) void this.redeliverMissed(repositoryId);
  }

  /**
   * Asks GitHub to send again the recent deliveries Conveyor never received: those of the last day
   * that no attempt delivered and that are not stored. At most REDELIVERY_LIMIT per pass. Without the
   * permission to list deliveries it warns once and leaves them to the safety-net reconcile.
   */
  async redeliverMissed(repositoryId: string): Promise<number> {
    if (this.store.repositoryPause(repositoryId)) return 0;
    const address = this.config.repositories[repositoryId]?.address;
    const hookId = this.#webhookIds.get(repositoryId);
    if (!address || hookId === undefined || this.#redeliveryDenied.has(repositoryId)) return 0;
    let deliveries: Awaited<ReturnType<GitHubAdapter["listHookDeliveries"]>>;
    try {
      deliveries = await this.github.listHookDeliveries(address, hookId);
    } catch (error) {
      if (error instanceof GitHubTransportError && /\(HTTP 40[34]\)/.test(`${error.stderr} ${error.message}`)) {
        this.#redeliveryDenied.add(repositoryId);
        log.warn("Cannot list webhook deliveries; missed deliveries are not redelivered", { repository: repositoryId }, error);
      } else {
        log.warn("Could not list webhook deliveries", { repository: repositoryId }, error);
      }
      return 0;
    }
    const cutoff = Date.now() - REDELIVERY_WINDOW_MS;
    const attempts = new Map<string, typeof deliveries>();
    for (const delivery of deliveries) attempts.set(delivery.guid, [...(attempts.get(delivery.guid) ?? []), delivery]);
    const missed = [...attempts.entries()].flatMap(([guid, tries]) => {
      const delivered = tries.some((attempt) => attempt.statusCode >= 200 && attempt.statusCode < 300);
      const latest = tries.reduce((newest, attempt) => (Date.parse(attempt.deliveredAt) > Date.parse(newest.deliveredAt) ? attempt : newest));
      return delivered || Date.parse(latest.deliveredAt) < cutoff || this.store.hasSourceEvent("github", guid) ? [] : [latest];
    }).slice(0, REDELIVERY_LIMIT);
    let redelivered = 0;
    for (const delivery of missed) {
      try {
        await this.executionGitHub(repositoryId).redeliverHookDelivery(address, hookId, delivery.id);
        redelivered += 1;
      } catch (error) {
        if (error instanceof RepositoryPausedError) break;
        log.warn("Could not ask GitHub to redeliver a webhook delivery", { repository: repositoryId, delivery: delivery.guid }, error);
      }
    }
    if (redelivered > 0) log.info("Asked GitHub to redeliver missed webhook deliveries", { repository: repositoryId, deliveries: redelivered });
    return redelivered;
  }

  private setWebhookHealth(repositoryId: string, healthy: boolean): void {
    if (this.#webhookHealth.get(repositoryId) === healthy) return;
    this.#webhookHealth.set(repositoryId, healthy);
    this.store.events().append("webhook.healthChanged", { healthy }, { repositoryId });
    if (healthy) log.info("Webhook deliveries arrive", { repository: repositoryId });
    else log.warn("Webhook deliveries stop arriving: a ping was not delivered; check the repository's webhook", { repository: repositoryId });
  }

  /** How long an event wait sleeps without its event: its fallback where Conveyor manages a webhook, else null (poll). */
  waitFallbackMs(repositoryId: string, kind: WaitKind): number | null {
    if (!this.webhookUrl(repositoryId)) return null;
    return this.config.settings.events?.fallbackMs[kind] ?? null;
  }

  /** Records source visibility for operators without changing any trust decision. */
  private async recordRepositoryTrustStatus(id: string, address: string): Promise<void> {
    const checkedAt = new Date().toISOString();
    try {
      const visibility = await this.github.repositoryVisibility(address);
      this.store.setRepositoryTrustStatus({ repositoryId: id, visibility, checkedAt, warning: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setRepositoryTrustStatus({
        repositoryId: id,
        visibility: "unknown",
        checkedAt,
        warning: `Could not determine repository visibility: ${message}`,
      });
      log.warn("Repository trust status could not be determined", { repository: id }, error);
    }
  }

  /**
   * Reads every repository. A repository whose webhook Conveyor manages is read only at startup, and
   * then only the issues changed since Conveyor last saw it: its deliveries keep it current from there.
   * A repository without one (polling) is read in full at startup and on every periodic tick.
   */
  async reconcileAll(options: { skipFresh?: boolean } = {}): Promise<void> {
    let read = 0;
    for (const id of Object.keys(this.config.repositories)) {
      const managed = this.webhookUrl(id) !== null;
      if (options.skipFresh && managed) continue;
      await this.reconcileOne(id, managed ? "changed" : "full");
      read += 1;
    }
    // A tick that read nothing changed nothing; startup always completes, even with no repository to read.
    if (options.skipFresh && read === 0) return;
    this.#lastReconciledAt = new Date().toISOString();
    this.store.events().append("service.reconciled", { failed: this.#repositoryErrors.size });
    this.interruptIneligibleRuns();
    this.#recoverPendingScheduledAnswers();
  }

  /**
   * Reads one repository. A full pass lists every issue; a `changed` pass lists only the issues
   * changed since Conveyor last saw the repository and reads relationships for those alone.
   */
  private async reconcileOne(id: string, kind: "full" | "changed", options: { verifyTrust?: boolean } = {}): Promise<number> {
    const repository = this.config.repositories[id];
    if (!repository) return 0;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    const startedAt = Date.now();
    this.#repositoryReconciledAt.set(id, startedAt);
    try {
      // What Conveyor held before the read, so a `changed` pass re-reads relationships only for issues
      // GitHub reports changed (the listing overlaps the last read and returns some unchanged ones).
      const before = new Map(this.store.listIssues(id).map((issue) => [issue.id, { body: issue.body, sourceUpdatedAt: issue.sourceUpdatedAt }]));
      const listing = this.issueListing(id, kind);
      const result = await reconcileRepository({
        store: this.store,
        configHash: this.config.hash,
        repository: {
          id,
          configName: id,
          source: repository.source,
          address: repository.address,
          folder: repository.folder,
        },
        stages: pipeline.stages.map((stage) => stage.id),
        labels: this.config.labels,
        source: this.executionGitHub(id),
        trust: this.#issueTrust,
        extraTrustedLogins: repository.extraTrustedLogins ?? [],
        expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
        ...(options.verifyTrust ? { verifyTrust: true } : {}),
        ...(listing.since !== undefined ? { since: listing.since } : {}),
      });
      listing.finish();
      const since = listing.since;
      const scope = since === undefined
        ? null
        : new Set(this.store.listIssues(id).filter((issue) => issue.sourceUpdatedAt >= since && before.get(issue.id)?.sourceUpdatedAt !== issue.sourceUpdatedAt).map((issue) => issue.sourceNumber));
      // A paused repository may refresh its projection, but cannot reconcile work that would
      // mutate source state or discard a worktree.
      if (this.store.repositoryPause(id)) return result.seen;
      await this.reconcileRelationships(id, repository.address, scope);
      if (scope !== null) await this.backfillCiIndicators(id, scope);
      await this.syncIssueFields(id, repository);
      this.wakeClearedFollowUps(id, new Map([...before].map(([issueId, previous]) => [issueId, previous.body])));
      this.restorePendingStatus(id);
      if (this.#repositoryErrors.delete(id)) this.store.events().append("repository.healthChanged", { check: "reconcile", healthy: true }, { repositoryId: id });
      this.store.events().append("repository.reconciled", { issueNumbers: scope === null ? null : [...scope] }, { repositoryId: id });
      return result.seen;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return 0;
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#repositoryErrors.has(id)) this.store.events().append("repository.healthChanged", { check: "reconcile", healthy: false }, { repositoryId: id });
      this.#repositoryErrors.set(id, message);
      log.error("Repository reconciliation failed", { repository: id }, error);
      return 0;
    } finally {
      // Visibility only informs operators, so a light pass leaves it to the next full one.
      if (kind === "full") await this.recordRepositoryTrustStatus(id, repository.address);
    }
  }

  /**
   * Reads one repository afresh, now: every issue, every enrolled item's provenance and author
   * permissions, relationships, pull request heads and CI, and the webhook's health. For an operator
   * who changed something GitHub sends no event for, such as a collaborator's permission.
   */
  syncRepository(repositoryId: string): Promise<{ issues: number; failed: boolean }> {
    this.assertRepositoryActive(repositoryId);
    // A second click while a sync runs joins it rather than reading everything twice.
    const running = this.#repositorySyncs.get(repositoryId);
    if (running) return running;
    const sync = this.runRepositorySync(repositoryId).finally(() => this.#repositorySyncs.delete(repositoryId));
    this.#repositorySyncs.set(repositoryId, sync);
    return sync;
  }

  private async runRepositorySync(repositoryId: string): Promise<{ issues: number; failed: boolean }> {
    // A sync reads everything again: nothing held about the repository is reused.
    this.github.forgetRepository?.(this.config.repositories[repositoryId]!.address);
    this.forgetRelationships(repositoryId, this.store.listIssues(repositoryId).map((issue) => issue.sourceNumber));
    await this.reconcileOne(repositoryId, "full", { verifyTrust: true });
    await this.backfillCiIndicators(repositoryId);
    if (this.webhookUrl(repositoryId)) {
      await this.redeliverMissed(repositoryId);
      await this.pingWebhook(repositoryId);
    }
    this.interruptIneligibleRuns();
    this.schedule();
    const issues = this.store.listIssues(repositoryId);
    this.refreshStatusComments(issues.map((issue) => issue.id));
    const failed = this.#repositoryErrors.has(repositoryId);
    log.info("Repository synced", { repository: repositoryId, issues: issues.length, failed });
    return { issues: issues.length, failed };
  }

  private issueFieldValues(issue: StoredIssue): Array<{ name: string; value: string }> {
    const configured = this.config.repositories[issue.repositoryId]?.refinement?.fields ?? [];
    return configured.flatMap((name) => {
      const entry = Object.entries(issue.metadata.fields).find(([field]) => field.toLocaleLowerCase() === name.toLocaleLowerCase());
      return entry ? [{ name: entry[0], value: entry[1] }] : [];
    });
  }

  /** Read the configured issue-field values of enrolled issues that changed since they were last read. */
  private async syncIssueFields(repositoryId: string, repository: ConveyorConfig["repositories"][string]): Promise<void> {
    const refinement = repository.refinement;
    if (!refinement || refinement.fields.length === 0) return;
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.sourceState !== "open" || !issue.labels.includes(this.config.labels.enrollment)) continue;
      if (issue.metadata.fieldsSyncedAt === issue.sourceUpdatedAt) continue;
      try {
        const values = await this.github.getIssueFieldValues(repository.address, issue.sourceNumber);
        const configured = Object.fromEntries(Object.entries(values).filter(([name]) =>
          refinement.fields.some((field) => field.toLocaleLowerCase() === name.toLocaleLowerCase())));
        this.store.setIssueMetadata(issue.id, { fields: configured, fieldsSyncedAt: issue.sourceUpdatedAt });
      } catch (error) {
        log.warn("Issue field sync failed", this.itemFields(issue.id), error);
        continue;
      }
    }
  }

  start(): void {
    if (this.#timer) return;
    this.beginStartupPass();
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.config.settings.reconcileIntervalMs);
    const periodic = this.config.web?.steering?.periodic;
    if (periodic) {
      this.#periodicOperatorTimer = setInterval(() => {
        void this.runScheduledOperatorCheck().catch((error) => log.warn("Scheduled Operator check failed", {}, error));
      }, periodic.intervalMs);
    }
    const prune = () => {
      this.#retentionActive += 1;
      void this.applyRetention()
        .catch((error: unknown) => log.error("Retention failed", {}, error))
        .finally(() => { this.#retentionActive -= 1; });
    };
    prune();
    this.#retentionTimer = setInterval(prune, 24 * 60 * 60_000);
    this.#githubCallTimer = setInterval(() => void this.logGitHubCalls(), GITHUB_CALL_SUMMARY_MS);
    for (const sink of this.#sinks) sink.start(this.events);
    // The server listens from here on: ask for the deliveries GitHub could not make while Conveyor was
    // starting or stopped, and ping each webhook so its arrival shows deliveries work.
    for (const repositoryId of Object.keys(this.config.repositories)) {
      if (this.webhookUrl(repositoryId)) void this.redeliverMissed(repositoryId).then(() => this.pingWebhook(repositoryId));
    }
    this.#webhookHealthTimer = setInterval(() => void this.superviseWebhooks(), WEBHOOK_CHECK_MS);
  }

  private beginStartupPass(): void {
    this.#startupStarted = true;
    this.#startupRunning = true;
    this.#startupCompleted = false;
    this.#startupFailed = false;
    for (const id of Object.keys(this.config.repositories)) this.#startupRepositories.set(id, "waiting");
    void withGitHubCallSource("startup", async () => {
      await this.recoverWorkspaceScratch();
      await Promise.all(Object.entries(this.config.repositories).map(async ([id, repository]) => {
        const startedAt = Date.now();
        let issues = 0;
        let failed = false;
        this.#startupRepositories.set(id, "onboarding");
        log.info("Startup repository reconciliation started", { repository: id });
        try {
          await this.onboardRepository(id, repository);
          failed = this.#onboardingErrors.has(id);
          if (!failed) {
            this.#startupRepositories.set(id, "reconciling");
            issues = await this.reconcileOne(id, this.webhookUrl(id) ? "changed" : "full");
            failed = this.#repositoryErrors.has(id);
          }
        } catch (error) {
          failed = true;
          this.#repositoryErrors.set(id, error instanceof Error ? error.message : String(error));
          log.error("Startup repository reconciliation failed", { repository: id }, error);
        } finally {
          log.info("Startup repository reconciliation completed", {
            repository: id,
            issues,
            durationMs: Date.now() - startedAt,
            success: !failed,
          });
          this.#startupRepositories.delete(id);
          // A repository can safely resume as soon as its own projection is checked.
          if (!failed) this.schedule();
        }
      }));
      this.#lastReconciledAt = new Date().toISOString();
      this.store.events().append("service.reconciled", { failed: this.#repositoryErrors.size + this.#onboardingErrors.size });
      this.interruptIneligibleRuns();
      this.#recoverPendingScheduledAnswers();
    }).catch((error) => {
      this.#startupFailed = true;
      log.error("Startup reconciliation failed", {}, error);
    }).finally(() => {
      this.#startupRunning = false;
      this.#startupCompleted = true;
      this.schedule();
    });
  }

  /** Marks creation as pending before listeners are opened; provider work begins from start(). */
  private prepareStartupPass(): void {
    this.#startupStarted = true;
    this.#startupCompleted = false;
    for (const id of Object.keys(this.config.repositories)) this.#startupRepositories.set(id, "waiting");
  }

  private async onboardRepository(id: string, repository: ConveyorConfig["repositories"][string]): Promise<void> {
    this.store.upsertRepository({ id, configName: id, source: repository.source, address: repository.address, folder: repository.folder, configHash: this.config.hash });
    await this.recordRepositoryTrustStatus(id, repository.address);
    if (this.store.repositoryPause(id)) return;
    try {
      await this.executionGitHub(id).ensureLabels(repository.address, labelDefinitions(this.config, id));
      const source = this.config.sources[repository.source];
      if (source?.type === "github" && source.autoConfigureWebhook && this.config.web.publicUrl) {
        const secret = this.webhookSecretFor(repository.source);
        if (!secret) throw new Error("a webhook secret is required for webhooks: set webhookSecret on the GitHub items provider (or CONVEYOR_GITHUB_WEBHOOK_SECRET)");
        const url = new URL(source.webhookPath, this.config.web.publicUrl).href;
        this.#webhookIds.set(id, await this.executionGitHub(id).ensureWebhook({ address: repository.address, url, secret }));
      }
      if (this.#onboardingErrors.delete(id)) this.store.events().append("repository.healthChanged", { check: "onboarding", healthy: true }, { repositoryId: id });
    } catch (error) {
      if (error instanceof RepositoryPausedError) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!this.#onboardingErrors.has(id)) this.store.events().append("repository.healthChanged", { check: "onboarding", healthy: false }, { repositoryId: id });
      this.#onboardingErrors.set(id, message);
      log.error("Repository onboarding failed", { repository: id }, error);
    }
  }

  /** Resolves once every event sink has received every recorded event (or a delivery failed). */
  async sinksIdle(): Promise<void> {
    await this.eventsSettled();
    await Promise.all(this.#sinks.map((sink) => sink.idle()));
  }

  /** The last hour of GitHub requests by source and repository, with the token's remaining rate limit. */
  async githubCallReport(): Promise<GitHubCallReport> {
    let rateLimit: GitHubCallReport["rateLimit"] = null;
    try { rateLimit = (await this.github.rateLimit()).core; }
    catch { rateLimit = null; }
    return { countingSince: this.githubCalls.startedAt, windowMs: GITHUB_CALL_SUMMARY_MS, ...this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS), rateLimit };
  }

  /**
   * Logs the last hour of GitHub requests per source, overall and per repository, with the token's
   * remaining rate limit; warns when less than a fifth of it is left.
   */
  async logGitHubCalls(): Promise<void> {
    const summary = this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS);
    const counts = (bySource: Partial<Record<GitHubCallSource, number>>) =>
      Object.fromEntries(GITHUB_CALL_SOURCES.filter((source) => bySource[source]).map((source) => [source, bySource[source]!]));
    let limits: Awaited<ReturnType<GitHubAdapter["rateLimit"]>> | null = null;
    try { limits = await this.github.rateLimit(); }
    catch (error) { log.warn("Could not read the GitHub rate limit", {}, error); }
    const core = limits?.core ?? null;
    log.info("GitHub calls in the last hour", {
      total: summary.total, ...counts(summary.bySource),
      ...(core ? { remaining: core.remaining, limit: core.limit, resetAt: core.resetAt } : {}),
      ...(Date.parse(this.githubCalls.startedAt) > Date.now() - GITHUB_CALL_SUMMARY_MS ? { since: this.githubCalls.startedAt } : {}),
    });
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      const bySource = summary.byRepository[repository.address.toLowerCase()];
      if (bySource) log.info("GitHub calls in the last hour for a repository", { repository: id, ...counts(bySource) });
    }
    if (core && core.remaining < core.limit * 0.2) {
      log.warn("GitHub rate limit is running low", { remaining: core.remaining, limit: core.limit, resetAt: core.resetAt });
    }
  }

  private async recoverWorkspaceScratch(): Promise<void> {
    try {
      const removed = await this.workspaceManager.removeOrphanedScratch(
        this.store.listActiveWorkspaces().map((workspace) => workspace.path),
      );
      if (removed > 0) log.info("Removed orphaned item scratch directories", { directories: removed });
    } catch (error) {
      log.error("Workspace scratch recovery failed", {}, error);
    }
  }

  /** Prunes finished work past the retention policy (the configured one by default). */
  async applyRetention(options: { dryRun?: boolean; policy?: RetentionPolicy } = {}): Promise<RetentionReport> {
    const report = await applyRetention({
      store: this.store,
      artifacts: this.config.settings.artifacts,
      policy: options.policy ?? this.config.settings.retention,
      eventsMs: this.config.settings.events?.retentionMs ?? null,
      dryRun: options.dryRun === true,
    });
    if (!report.dryRun && (report.runHistory.events > 0 || report.artifacts.directories > 0 || report.homes.directories > 0 || report.eventLog.events > 0)) {
      log.info("Pruned finished work past retention", { runs: report.runHistory.runs, events: report.runHistory.events, artifactDirectories: report.artifacts.directories, artifactBytes: report.artifacts.bytes, homes: report.homes.directories, homeBytes: report.homes.bytes, eventLog: report.eventLog.events });
    }
    if (!report.dryRun && report.homes.failures.length > 0) {
      log.warn("Could not reclaim some terminal run homes", { homeFailures: report.homes.failures.length, failures: report.homes.failures });
    }
    return report;
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    this.#dashboardFeed.close();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#periodicOperatorTimer) clearInterval(this.#periodicOperatorTimer);
    this.#periodicOperatorTimer = null;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = null;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
    if (this.#advisoryTimer) clearTimeout(this.#advisoryTimer);
    this.#advisoryTimer = null;
    if (this.#githubCallTimer) clearInterval(this.#githubCallTimer);
    this.#githubCallTimer = null;
    if (this.#webhookHealthTimer) clearInterval(this.#webhookHealthTimer);
    this.#webhookHealthTimer = null;
    await Promise.all(this.#sinks.map((sink) => sink.stop()));
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#retryTimers.clear();
    for (const [issueId, active] of this.#active) {
      active.interrupted = true;
      log.warn("Stage interrupted during shutdown", { ...this.itemFields(issueId), stage: active.stageId });
      active.controller.abort();
    }
    for (const controller of this.#steeringActive.values()) controller.abort();
    // An in-flight reconcile or advisory-CI poll still uses the database; let it finish first.
    while (this.#active.size > 0 || this.#steeringActive.size > 0 || this.#statusCommentUpdates.size > 0 || this.#webhookWork.size > 0 || this.#answerFollowUps.size > 0 || this.#startupRunning || this.#tickRunning || this.#advisoryPolling || this.#retentionActive > 0) {
      await Bun.sleep(25);
    }
    this.store.close();
  }

  async tick(): Promise<void> {
    if (this.#shuttingDown || this.#startupRunning || this.#tickRunning) return;
    this.#tickRunning = true;
    try {
      await withGitHubCallSource("tick", async () => {
        await this.reconcileAll({ skipFresh: true });
        await this.recoverClosedItems();
      });
      this.schedule();
    } finally {
      this.#tickRunning = false;
    }
    // Not awaited: a slow CI provider must not stall reconcile and scheduling.
    void this.pollAdvisoryCi().catch((error) => log.warn("Advisory CI poll failed", {}, error));
  }

  /** Reconcile long-lived non-runnable projections that webhook delivery may have missed. */
  private async recoverClosedItems(): Promise<void> {
    const before = new Date(Date.now() - CLOSED_ITEM_RECOVERY_AGE_MS).toISOString();
    for (const repositoryId of Object.keys(this.config.repositories)) {
      for (const issue of this.store.listRecoveryCandidates(repositoryId, before)) {
        await this.recoverClosedItem(repositoryId, issue);
      }
    }
  }

  /** Resolve one closed source item without treating a failed read as evidence of closure or merge. */
  private async recoverClosedItem(
    repositoryId: string,
    issue: StoredIssue,
    deliveredIssue?: SourceIssue,
  ): Promise<void> {
    if (issue.projectedState === "done" || issue.projectedState === "offboarded") return;
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    let sourceIssue: SourceIssue;
    try {
      sourceIssue = deliveredIssue ?? await this.executionGitHub(repositoryId).getIssue(repository.address, issue.sourceNumber);
    } catch (error) {
      log.warn("Could not read an item for closed-item recovery", this.itemFields(issue.id), error);
      return;
    }
    if (sourceIssue.state !== "closed") return;

    const current = this.store.getCurrentPullRequest(issue.id);
    if (current) {
      const host = this.executionCodeHost(issue.id, this.codeHostFor(repositoryId));
      if (!host) {
        log.warn("Could not read a current change for closed-item recovery", this.itemFields(issue.id));
        return;
      }
      let delivery: ChangeDelivery;
      try {
        delivery = await host.getChangeDelivery({ address: repository.address, id: current.id });
      } catch (error) {
        log.warn("Could not read a current change for closed-item recovery", this.itemFields(issue.id), error);
        return;
      }
      const mergedAt = delivery.change.mergedAt ?? current.mergedAt ??
        (delivery.change.state === "merged" ? new Date().toISOString() : null);
      this.store.upsertPullRequest({
        issueId: issue.id,
        id: current.id,
        number: delivery.change.number,
        url: delivery.change.url,
        state: delivery.change.state,
        ...(mergedAt ? { mergedAt } : {}),
      });
      if (mergedAt) {
        await this.continueExternalMerge(repositoryId, issue, sourceIssue, current.id);
        return;
      }
    }
    try {
      const enrollment = this.store.getActiveEnrollment(issue.id);
      await applyClosedItemOffboarding({
        store: this.store,
        source: this.executionGitHub(repositoryId),
        sourceName: repository.source,
        address: repository.address,
        transitionId: `closed-item-offboard:${issue.id}:${enrollment?.generation ?? "untracked"}`,
        issue,
      });
    } catch (error) {
      if (error instanceof RepositoryPausedError) {
        this.store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState,
          warning: "Closed-item cleanup will resume when the repository resumes.",
        });
        return;
      }
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: issue.projectedState,
        warning: "Closed-item cleanup is pending after a source update failure.",
      });
      log.warn("Could not remove controls from a closed item", this.itemFields(issue.id), error);
    }
  }

  /** Records a person-merged current change and continues at the stage after Conveyor's merge task. */
  private async continueExternalMerge(
    repositoryId: string,
    issue: StoredIssue,
    sourceIssue: SourceIssue,
    changeId: string,
  ): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const stages = this.config.pipelines[repository.pipeline]!.stages;
    const mergeIndex = stages.findIndex((stage) => isNativeStage(stage) && stage.actions.some((action) => action.task === "change.merge"));
    const currentStage = issue.projectedStage;
    const currentIndex = currentStage ? stages.findIndex((stage) => stage.id === currentStage) : -1;
    try {
      if (!currentStage || mergeIndex < 0 || currentIndex < 0 || currentIndex > mergeIndex) {
        await this.reconcileClosedItem(repositoryId, sourceIssue);
        return;
      }
      const applied = await applyStageTransition({
        store: this.store,
        source: this.executionGitHub(repositoryId),
        sourceName: repository.source,
        address: repository.address,
        configHash: this.config.hash,
        transitionId: `external-merge:${issue.id}:${changeId}`,
        issue,
        stages: stages.map((stage) => stage.id),
        labels: this.config.labels,
        result: {
          kind: "advance",
          stageId: currentStage,
          nextStageId: stages[mergeIndex + 1]?.id ?? null,
          feedbackCycles: this.store.getStageState(issue.id)?.feedbackCycle ?? 0,
          result: null,
        },
        actor: { name: "GitHub", title: "External merge" },
      });
      if ("waitingForInFlight" in applied) return;
      const conveyorLabels = sourceIssue.labels.filter((label) =>
        label === this.config.labels.enrollment || label.startsWith(`${this.config.labels.enrollment}:`));
      const projected = {
        ...sourceIssue,
        labels: [...sourceIssue.labels.filter((label) => !conveyorLabels.includes(label)), ...applied.labels],
      };
      await this.reconcileClosedItem(repositoryId, projected);
    } catch (error) {
      if (error instanceof RepositoryPausedError) {
        this.store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState,
          warning: "Post-merge continuation will resume when the repository resumes.",
        });
        return;
      }
      log.warn("Could not continue an externally merged change", this.itemFields(issue.id), error);
    }
  }

  /** Reconciles one supplied source snapshot without issuing another source read. */
  private async reconcileClosedItem(repositoryId: string, issue: SourceIssue): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    await reconcileRepository({
      store: this.store,
      configHash: this.config.hash,
      repository: { id: repositoryId, configName: repositoryId, source: repository.source, address: repository.address, folder: repository.folder },
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      source: this.executionGitHub(repositoryId),
      trust: this.#issueTrust,
      extraTrustedLogins: repository.extraTrustedLogins ?? [],
      expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
      issues: [issue],
    });
  }

  private repositoryInFlight(repositoryId: string): {
    stages: readonly { id: string }[];
    interval: InFlightInterval;
  } | null {
    const repository = this.config.repositories[repositoryId];
    if (!repository?.inFlight) return null;
    const pipeline = this.config.pipelines[repository.pipeline];
    if (!pipeline) return null;
    const mergeIndex = pipeline.stages.findIndex(
      (stage) => isNativeStage(stage) && stage.actions.some((action) => action.task === "change.merge"),
    );
    const interval = inFlightInterval(pipeline.stages, repository.inFlight, mergeIndex);
    return interval ? { stages: pipeline.stages, interval } : null;
  }

  private repositoryInFlightHolders(repositoryId: string): StoredIssue[] {
    const configured = this.repositoryInFlight(repositoryId);
    return configured
      ? inFlightHolders({ store: this.store, repositoryId, ...configured })
      : [];
  }

  /** Checks the durable holder set immediately before an item writes its stage checkpoint. */
  private inFlightAdmission(issue: StoredIssue, targetStageId: string): string | null {
    const configured = this.repositoryInFlight(issue.repositoryId);
    if (!configured) return null;
    return inFlightAdmission({
      store: this.store,
      repositoryId: issue.repositoryId,
      issueId: issue.id,
      targetStageId,
      ...configured,
    });
  }

  private inFlightWaitingReason(issue: StoredIssue): string | null {
    if (!this.repositoryInFlight(issue.repositoryId)) return null;
    const state = this.store.getStageState(issue.id);
    if (state?.status !== "waiting-in-flight") return null;
    const holders = this.repositoryInFlightHolders(issue.repositoryId)
      .filter((holder) => holder.id !== issue.id);
    return holders.length > 0 ? inFlightWaitReason(issue.repositoryId, holders) : issue.warning;
  }

  /** Promotes waiting prior-stage completions in queue order when code-pipeline capacity is free. */
  private promoteInFlightWaiters(): string[] {
    const promoted: string[] = [];
    for (const repositoryId of Object.keys(this.config.repositories)) {
      const configured = this.repositoryInFlight(repositoryId);
      if (!configured) continue;
      const available = configured.interval.limit - this.repositoryInFlightHolders(repositoryId).length;
      if (available <= 0) continue;
      const waiters = this.store.listIssues(repositoryId).filter((issue) => {
        const state = this.store.getStageState(issue.id);
        const stageIndex = state ? configured.stages.findIndex((stage) => stage.id === state.stageId) : -1;
        return issue.projectedState === "active" &&
          state?.status === "waiting-in-flight" &&
          stageIndex + 1 === configured.interval.fromIndex;
      });
      for (const issue of waiters.slice(0, available)) {
        const state = this.store.getStageState(issue.id)!;
        this.store.setStageState({ ...state, status: "ready", configHash: this.config.hash });
        this.store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState ?? "active",
          warning: null,
        });
        promoted.push(issue.id);
      }
    }
    return promoted;
  }

  private schedule(): void {
    if (this.#shuttingDown || this.#drain) return;
    const promotedIds = this.promoteInFlightWaiters();
    const candidates = this.schedulerCandidates();
    const limits = this.concurrencyLimits();
    const occupants = this.schedulerOccupants();
    const stageUsage: Record<string, number> = {};
    const repositoryUsage: Record<string, number> = {};
    let processUsage = 0;
    for (const active of occupants) {
      stageUsage[active.stageId] = (stageUsage[active.stageId] ?? 0) + 1;
      if (active.lightweight) continue;
      processUsage += 1;
      repositoryUsage[active.repositoryId] = (repositoryUsage[active.repositoryId] ?? 0) + 1;
    }
    const selected = selectRunnableIssues(
      candidates,
      limits,
      {
        global: processUsage,
        stages: stageUsage,
        repositories: repositoryUsage,
      },
    );
    const startedIds = new Set<string>();
    for (const candidate of selected) {
      const issue = this.store.getIssue(candidate.id);
      if (!issue) continue;
      // A pause can land between candidate collection and admission. Recheck
      // at the boundary so every wake path observes the durable pause.
      if (this.store.repositoryPause(issue.repositoryId)) continue;
      // Relationship reconciliation can add children after this scheduling
      // pass built its candidates. Recheck at the admission boundary so an
      // item never starts a new run after becoming a roll-up parent.
      if (
        this.store.listChildren(issue.id).length > 0 &&
        !this.hasResumableQuestionExecution(issue.id) &&
        !this.childCreationRetryQueued(issue, candidate.stageId)
      ) continue;
      // The retry marker is only an admission permit. Restore the executor's
      // ordinary ready state immediately before it claims the stage.
      const stage = this.store.getStageState(issue.id);
      if (stage?.status === "retry-ready" && stage.stageId === candidate.stageId) {
        this.store.setStageState({ ...stage, status: "ready" });
      }
      this.#active.set(issue.id, {
        repositoryId: issue.repositoryId,
        stageId: candidate.stageId,
        controller: new AbortController(),
        lightweight: candidate.lightweight === true,
        interrupted: false,
      });
      startedIds.add(issue.id);
      const active = this.#active.get(issue.id)!;
      log.info("Stage started", { ...this.itemFields(issue.id), stage: candidate.stageId });
      void withGitHubCallSource(this.executionCallSource(issue.id), () => this.execute(issue, active.controller.signal)).finally(() => {
        this.#active.delete(issue.id);
        this.store.events().append("worker.released", { stageId: candidate.stageId }, { issueId: issue.id });
        if (this.#drain && !active.interrupted) {
          log.info("Stage finished during drain", { ...this.itemFields(issue.id), stage: candidate.stageId });
        }
      });
    }
    const selectedIds = startedIds;
    this.refreshStatusComments([
      ...promotedIds,
      ...selectedIds,
      ...candidates
        .filter((candidate) => candidate.eligible && candidate.dependenciesSatisfied && !candidate.rollupOnly && !selectedIds.has(candidate.id))
        .map((candidate) => candidate.id),
    ]);
    this.armWakeTimer();
  }

  private schedulerCandidates(
    issues: readonly StoredIssue[] = this.store.listIssues(),
    lookups?: {
      stageState: (issueId: string) => ReturnType<ConveyorStore["getStageState"]>;
      dependencies: (issueId: string) => readonly string[];
      children: (issueId: string) => ReturnType<ConveyorStore["listChildren"]>;
      issue: (issueId: string) => StoredIssue | null;
    },
  ): SchedulerCandidate[] {
    const stageState = lookups?.stageState ?? ((issueId: string) => this.store.getStageState(issueId));
    const dependencies = lookups?.dependencies ?? ((issueId: string) => this.store.listDependencies(issueId));
    const children = lookups?.children ?? ((issueId: string) => this.store.listChildren(issueId));
    const getIssue = lookups?.issue ?? ((issueId: string) => this.store.getIssue(issueId));
    return issues.flatMap((issue) => {
      const state = stageState(issue.id);
      if (!state?.stageId || issue.queueRank === null) return [];
      const dependenciesSatisfied = dependencies(issue.id).every((id) => {
        const blocker = getIssue(id);
        return Boolean(blocker && (blocker.sourceState === "closed" || blocker.projectedState === "done"));
      });
      return [{
        id: issue.id,
        repositoryId: issue.repositoryId,
        stageId: state.stageId,
        queueRank: issue.queueRank,
        siblingOrder: null,
        eligible:
          issue.projectedState === "active" &&
          (state.status === "ready" || state.status === "retry-ready") &&
          !this.#active.has(issue.id) &&
          this.wakeupReached(issue.id) &&
          this.store.repositoryPause(issue.repositoryId) === null &&
          !this.#startupRepositories.has(issue.repositoryId) &&
          !this.#onboardingErrors.has(issue.repositoryId) &&
          !this.#repositoryErrors.has(issue.repositoryId),
        dependenciesSatisfied,
        rollupOnly:
          children(issue.id).length > 0 &&
          !this.hasResumableQuestionExecution(issue.id) &&
          !this.childCreationRetryQueued(issue, state.stageId),
        lightweight: this.isLightweightStage(issue.repositoryId, state.stageId),
      }];
    });
  }

  private hasRollupStopLabel(issue: StoredIssue): boolean {
    // A source refresh can lag the recorded result. Keep any configured
    // stopped state intact until the ordinary item path has cleared it. A
    // stale done label is the exception: an unfinished descendant repairs it.
    const stoppedStates = new Set(Object.keys(this.config.labels.states).filter((state) => state !== "done"));
    const stopLabels = new Set(Object.entries(this.config.labels.states)
      .flatMap(([state, label]) => state === "done" ? [] : [label]));
    return (issue.projectedState !== null && stoppedStates.has(issue.projectedState)) ||
      issue.labels.some((label) => stopLabels.has(label));
  }

  private concurrencyLimits(): ConcurrencyLimits {
    const stages: Record<string, number> = {};
    for (const pipeline of Object.values(this.config.pipelines)) {
      for (const stage of pipeline.stages) {
        stages[stage.id] = Math.min(stages[stage.id] ?? Infinity, stage.concurrency);
      }
    }
    return {
      global: this.config.settings.runners,
      stages,
      repositories: Object.fromEntries(
        Object.entries(this.config.repositories).map(([id, repository]) => [id, repository.concurrency]),
      ),
    };
  }

  private schedulerOccupants(): SchedulerOccupant[] {
    const occupants = new Map<string, SchedulerOccupant>();
    for (const run of this.store.listActiveIssueRuns()) {
      occupants.set(run.issueId, {
        id: run.issueId,
        repositoryId: run.repository,
        stageId: run.stageId,
        lightweight: this.isLightweightStage(run.repository, run.stageId),
      });
    }
    for (const [id, active] of this.#active) {
      occupants.set(id, { id, repositoryId: active.repositoryId, stageId: active.stageId, lightweight: active.lightweight });
    }
    return [...occupants.values()];
  }

  private refreshStatusComments(issueIds: readonly string[]): void {
    for (const issueId of new Set(issueIds)) {
      void this.updateStatusComment(issueId)
        .catch((error) => log.warn("Status comment refresh failed", this.itemFields(issueId), error))
        .catch(() => {});
    }
  }

  /** The current presentation status, derived from durable gate state and live scheduler facts. */
  /**
   * `queue` is the scheduler's view of every item. Reading it costs a pass over all of them, so a
   * caller that asks about many items builds it once and passes it along.
   */
  private schedulerQueue(
    issues?: readonly StoredIssue[],
    lookups?: Parameters<ConveyorService["schedulerCandidates"]>[1],
  ): () => { candidates: SchedulerCandidate[]; occupants: SchedulerOccupant[] } {
    let queue: { candidates: SchedulerCandidate[]; occupants: SchedulerOccupant[] } | undefined;
    return () => queue ??= { candidates: this.schedulerCandidates(issues, lookups), occupants: this.schedulerOccupants() };
  }

  private currentIssueStatus(issue: StoredIssue, queue = this.schedulerQueue()): LiveIssueStatus | null {
    if (this.store.listActiveIssueRuns().some((run) => run.issueId === issue.id)) return null;
    const inFlightReason = this.inFlightWaitingReason(issue);
    if (inFlightReason) {
      return {
        kind: "waiting",
        reason: inFlightReason,
        since: this.store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: null,
        deadline: null,
      };
    }
    const cursor = this.store.executions().getCursor(issue.id);
    const pending = cursor?.state === "pending" ? this.store.executions().pendingMessage(issue.id) : null;
    const wakeAt = cursor?.state === "pending" ? cursor.wakeAt : null;
    const wakeInFuture = wakeAt !== null && Date.parse(wakeAt) > Date.now();
    if (cursor?.state === "pending" && wakeInFuture) {
      return {
        kind: "waiting",
        reason: (cursor.taskInstanceId ? this.currentCiWaitingReason(issue, cursor.taskInstanceId, pending) : null) ?? pending ?? issue.warning ?? "Waiting for the next check",
        since: cursor.pendingSince ?? this.store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: wakeAt,
        deadline: cursor.deadlineAt,
      };
    }

    const candidate = queue().candidates.find((item) => item.id === issue.id);
    if (!candidate || !candidate.eligible || candidate.rollupOnly) return null;
    if (!candidate.dependenciesSatisfied) {
      const dependencies = this.store.listDependencies(issue.id)
        .map((dependencyId) => this.store.getIssue(dependencyId))
        .filter((dependency): dependency is StoredIssue => dependency !== null)
        .filter((dependency) => dependency.sourceState !== "closed" && dependency.projectedState !== "done")
        .map((dependency) => `#${dependency.sourceNumber}`);
      return {
        kind: "waiting",
        reason: `Waiting for dependencies: ${dependencies.join(", ")}`,
        since: this.store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: null,
        deadline: null,
      };
    }
    const blockers = capacityBlockers(candidate, this.concurrencyLimits(), queue().occupants);
    if (blockers.length === 0) return null;
    const reason = blockers.map((blocker) => {
      const holderNumbers = blocker.occupants
        .map((id) => this.store.getIssue(id)?.sourceNumber)
        .filter((number): number is number => number !== undefined)
        .map((number) => `#${number}`)
        .join(", ");
      const name = blocker.scope === "global"
        ? "global runner slots"
        : blocker.scope === "stage"
          ? `${candidate.stageId} slots`
          : `${candidate.repositoryId} slots`;
      return `${name} ${blocker.used}/${blocker.limit} busy: ${holderNumbers || "unknown item"}`;
    }).join("; ");
    return {
      kind: "queued",
      reason,
      since: wakeAt ?? this.store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
      nextCheckAt: null,
      deadline: null,
    };
  }

  /** The live scheduler status for an item, when it is waiting or queued rather than running. */
  liveIssueStatus(issueId: string): LiveIssueStatus | null {
    const issue = this.store.getIssue(issueId);
    return issue ? this.currentIssueStatus(issue) : null;
  }

  private currentCiWaitingReason(issue: StoredIssue, taskInstanceId: string, pending: string | null): string | null {
    if (!pending?.startsWith("Waiting for CI")) return null;
    const indicator = this.store.listIndicators(issue.id).find((item) => item.id === CI_INDICATOR_ID);
    if (!indicator) return null;
    const head = indicator.headSha.slice(0, 7);
    const unfinished = indicator.entries
      .filter((entry) => entry.state === "queued" || entry.state === "running")
      .map((entry) => entry.name);
    if (unfinished.length > 0 || indicator.state === "running" || indicator.state === "unknown") {
      return `Waiting for CI at ${head}: ${unfinished.join(", ") || indicator.detail}.`;
    }
    if (indicator.state === "failed") return `CI failed at ${head}: ${indicator.detail}.`;
    const settleEnd = this.ciSettleEnd(issue, taskInstanceId, indicator);
    return settleEnd !== null
      ? `CI passed at ${head}; settling until ${settleEnd}.`
      : `CI passed at ${head}; ready for the next gate evaluation.`;
  }

  private ciSettleEnd(issue: StoredIssue, taskInstanceId: string, indicator: StoredIndicator): string | null {
    const plan = this.config.plans.find((candidate) => candidate.repositoryId === issue.repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId: issue.repositoryId, registry: createTaskRegistry() });
    const stage = plan.stages.find((candidate) => candidate.id === this.store.getStageState(issue.id)?.stageId);
    const task = stage && [...stage.actions, ...stage.exitGate].find((candidate) => candidate.id === taskInstanceId);
    if (task?.task !== "ci.passed" && task?.task !== "ci.settled") return null;
    const seconds = typeof task.with.settleSeconds === "number" ? task.with.settleSeconds : 120;
    const firstSeen = this.store.executions().ciMarkAt(issue.id, indicator.headSha, "first-seen") ?? indicator.observedAt;
    const settleEnd = new Date(Date.parse(firstSeen) + seconds * 1_000).toISOString();
    return Date.parse(settleEnd) > Date.now() ? settleEnd : null;
  }

  /** Polls due advisory CI watches (no permits, no stage state) and re-arms the timer for the next one. */
  private async pollAdvisoryCi(): Promise<void> {
    if (this.#shuttingDown || this.#advisoryPolling) return;
    this.#advisoryPolling = true;
    try { await withGitHubCallSource("advisory", () => this.#advisoryWatches.pollDueWatches(Date.now())); }
    finally { this.#advisoryPolling = false; }
    if (this.#advisoryTimer) clearTimeout(this.#advisoryTimer);
    this.#advisoryTimer = null;
    const next = this.#advisoryWatches.nextWakeAt();
    if (next === null || this.#shuttingDown) return;
    this.#advisoryTimer = setTimeout(() => {
      this.#advisoryTimer = null;
      void this.pollAdvisoryCi().catch(() => {});
    }, Math.max(0, Date.parse(next) - Date.now()) + 50);
  }

  /** Why a stage run starts: an early wake of a parked task, its wake-up time passing, or other stage work. */
  private executionCallSource(issueId: string): GitHubCallSource {
    const woken = this.#wokenEarly.delete(issueId);
    if (this.store.executions().getCursor(issueId)?.state !== "pending") return "stage";
    return woken ? "wait" : "fallback";
  }

  /** Registers the handler of every service command; release and restart are registered by the control socket. */
  private registerCommands(): void {
    const own = (actor: CommandActor, accountId: string) => {
      if (actor.role !== "superuser" && actor.id !== accountId) throw new CommandForbiddenError("an account may change only itself");
    };
    const account = (actor: CommandActor) => ({ id: actor.id ?? actor.name, username: actor.name });
    const commands = this.commands;
    commands.handle("item.retry", (input, actor) => this.retryIssue(input.issueId, input.note, actor.name));
    commands.handle("item.resumeRollup", (input) => this.resumeRollupParent(input.issueId));
    commands.handle("item.pause", (input, actor) => this.pauseIssue(input.issueId, actor.name));
    commands.handle("item.resume", (input, actor) => this.resumeIssue(input.issueId, actor.name));
    commands.handle("repository.pause", (input, actor) => this.pauseRepository(input.repositoryId, input.reason, actor.name));
    commands.handle("repository.resume", (input) => this.resumeRepository(input.repositoryId));
    commands.handle("item.postMessage", (input, actor) => this.postIssueMessage(input.issueId, input.message, actor.name));
    commands.handle("question.answer", (input, actor) => this.answerQuestion(input.questionId, input.answer, actor.name));
    commands.handle("gate.approve", (input, actor) => this.approveManualGate(input.issueId, input.stageId, input.gateId, account(actor)));
    commands.handle("gate.setItemApproval", (input) => this.setBoardApprovalRequirement(input.issueId, input.stageId, input.required));
    commands.handle("finding.dismiss", (input, actor) => this.dismissFinding(input.issueId, input.findingId, input.reason, actor.name));
    commands.handle("finding.reclassify", (input, actor) => this.reclassifyFinding(input.issueId, input.findingId, input.type, actor.name));
    commands.handle("backlog.reorder", (input) => this.reorderBacklog(input.issueId, input.direction));
    commands.handle("backlog.move", (input) => this.moveBacklogIssue(input.issueId, input.beforeIssueId));
    commands.handle("steering.start", (input) => this.startSteering(input.prompt));
    commands.handle("account.create", (input) => {
      const created = this.store.createDashboardUser(input.username, input.passwordHash);
      return { id: created.id, username: created.username, role: created.role, avatar: created.avatar };
    });
    commands.handle("account.setPassword", (input, actor) => {
      own(actor, input.accountId);
      this.store.changeDashboardPassword(input.accountId, input.passwordHash);
    });
    commands.handle("account.delete", (input) => this.store.deleteDashboardAccount(input.accountId));
    commands.handle("account.setAvatar", (input, actor) => {
      own(actor, input.accountId);
      this.store.changeDashboardAvatar(input.accountId, input.avatar);
    });
    commands.handle("notifications.updateSettings", (input, actor) => {
      own(actor, input.accountId);
      this.store.setPushPreferences(input.accountId, input.preferences);
    });
    commands.handle("notifications.subscribe", (input, actor) => {
      own(actor, input.accountId);
      this.store.putPushSubscription(input.accountId, input.endpoint, input.keys);
    });
    commands.handle("notifications.unsubscribe", (input, actor) => {
      own(actor, input.accountId);
      this.store.deletePushSubscription(input.accountId, input.endpoint);
    });
    commands.handle("repository.sync", (input) => {
      if (!this.config.repositories[input.repositoryId]) throw new CommandInputError(`unknown repository ${input.repositoryId}`);
      return this.syncRepository(input.repositoryId);
    });
    commands.handle("admission.drain", (input, actor) => this.drain(input.reason || `requested by ${actor.name}`));
    commands.handle("admission.resume", () => this.resumeAdmission());
    commands.handle("service.cleanup", (input) => {
      const configured = this.config.settings.retention;
      return this.applyRetention({
        dryRun: input.dryRun,
        policy: { runHistoryMs: input.runHistoryMs ?? configured.runHistoryMs, artifactsMs: input.artifactsMs ?? configured.artifactsMs },
      });
    });
  }

  /** Reactions to committed changes: waking parked items and scheduling. */
  private subscribeToEvents(): void {
    // Anything the board shows may have changed; the feed rebuilds once the burst settles.
    this.events.subscribe("*", "dashboard feed", (event) => {
      if (changesDashboard(event.type)) this.#dashboardFeed.invalidate();
    });
    // A parked configured gate re-evaluates as soon as a person changes what it waits on.
    const wakeParkedGate = (issueId: string | null, stageId: string, gateId: string | null, visit?: { stageEpoch: number; attempt: number }) => {
      if (!issueId) return;
      const cursor = this.store.executions().getCursor(issueId);
      const waitingForGate = cursor?.list === "exit-gate" ||
        (cursor?.list === "actions" && gateId === ENTRY_APPROVAL_TASK_ID && cursor.taskInstanceId === ENTRY_APPROVAL_TASK_ID);
      if (cursor?.state !== "pending" || cursor.stage !== stageId || !waitingForGate || (gateId !== null && cursor.taskInstanceId !== gateId)) return;
      // An approval belongs to one visit of the gate; a later visit waits for its own.
      if (visit && (cursor.stageEpoch !== visit.stageEpoch || cursor.attempt !== visit.attempt)) return;
      this.wakeParked(issueId);
    };
    this.events.subscribe("gate.approved", "wake the approved gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, event.payload.gateId, { stageEpoch: event.payload.stageEpoch, attempt: event.payload.attempt }));
    this.events.subscribe("gate.requirementChanged", "wake the changed gate", (event) => wakeParkedGate(event.issueId, event.payload.stageId, event.payload.gateId));
    this.events.subscribe("gate.boardApproved", "wake the approved board gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, BOARD_APPROVAL_TASK_ID, { stageEpoch: event.payload.stageEpoch, attempt: event.payload.attempt }));
    this.events.subscribe("gate.boardApprovalChanged", "wake the changed board gate", (event) =>
      wakeParkedGate(event.issueId, event.payload.stageId, BOARD_APPROVAL_TASK_ID));
    this.events.subscribe("finding.changed", "wake the review gate", (event) => {
      if (event.payload.change === "dismissed") {
        const cursor = event.issueId ? this.store.executions().getCursor(event.issueId) : null;
        if (cursor) wakeParkedGate(event.issueId, cursor.stage, null);
      }
    });
    for (const type of SCHEDULING_EVENTS) this.events.subscribe(type, "schedule", () => this.requestSchedule());
    this.events.subscribe("criterion.approvalChanged", "refresh criterion approval status", (event) => {
      if (event.issueId) this.refreshStatusComments([event.issueId]);
    });
    for (const type of ["github.issueUpdated", "github.relationshipChanged", "github.changeUpdated", "github.ciUpdated"] as const) {
      this.events.subscribe(type, "webhook projection", (event) => this.reactToGitHubEvent(event));
    }
    for (const type of ["github.ciUpdated", "github.changeUpdated", "item.updated", "item.stageChanged"] as const) {
      this.events.subscribe(type, "wake waiting tasks", (event) => this.#waitDispatcher.handle(event));
    }
    this.events.subscribe("github.ciUpdated", "wake advisory CI watches", (event) => {
      if (!event.payload.completed || !event.repositoryId) return;
      if (this.#advisoryWatches.wakeHead(event.repositoryId, event.payload.sha, Date.now()) > 0) {
        void this.pollAdvisoryCi().catch((error) => log.warn("Advisory CI poll failed", {}, error));
      }
    });
    // A delivery that arrives shows the webhook works.
    this.events.subscribe("webhook.received", "webhook health", (event) => {
      if (event.repositoryId && this.webhookUrl(event.repositoryId)) this.webhookDelivered(event.repositoryId);
    });
  }

  /** Schedules once after the current burst of events instead of once per event. */
  private requestSchedule(): void {
    if (this.#scheduleRequested) return;
    this.#scheduleRequested = true;
    queueMicrotask(() => this.flushSchedule());
  }

  private flushSchedule(): void {
    if (!this.#scheduleRequested) return;
    this.#scheduleRequested = false;
    // It runs after the event that asked for it, so nothing awaits it to report a failure.
    try {
      this.schedule();
    } catch (error) {
      log.error("Scheduling after an event failed", {}, error);
    }
  }

  /**
   * Resolves once every committed event has been published and the scheduling it asked for ran:
   * a command that reports whether its item started reads that only after this.
   */
  async eventsSettled(): Promise<void> {
    await this.store.events().settled();
    this.#waitDispatcher.flush();
    await this.store.events().settled();
    this.flushSchedule();
  }

  /** Makes a parked item due now and remembers that an event, not its wake-up time, woke it. */
  private wakeParked(issueId: string): boolean {
    const issue = this.store.getIssue(issueId);
    if (issue && this.store.repositoryPause(issue.repositoryId)) return false;
    const woken = this.store.executions().wakeNow(issueId);
    if (woken) this.#wokenEarly.add(issueId);
    return woken;
  }

  /** A parked item is schedulable only once its persisted wake-up time has passed. */
  private wakeupReached(issueId: string): boolean {
    const cursor = this.store.executions().getCursor(issueId);
    // Manual exit gates and configured entry approvals have no clock wake-up.
    // Their receipt event must explicitly wake the persisted cursor first.
    if (!cursor) return true;
    if (cursor.state === "pending" && cursor.wakeAt === null &&
      (cursor.list === "exit-gate" ||
        (cursor.list === "actions" && cursor.taskInstanceId === ENTRY_APPROVAL_TASK_ID))) return false;
    return cursor.wakeAt === null || Date.parse(cursor.wakeAt) <= Date.now();
  }

  /** Whether a parked agent question belongs to this item's current execution. */
  private hasResumableQuestionExecution(issueId: string): boolean {
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const issue = this.store.getIssue(issueId);
    if (!cursor || cursor.state !== "pending" || cursor.list !== "actions" || cursor.taskInstanceId === null || !issue) {
      return false;
    }
    const plan = this.config.plans.find((candidate) => candidate.repositoryId === issue.repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId: issue.repositoryId, registry: createTaskRegistry() });
    const stage = plan.stages.find((candidate) => candidate.id === cursor.stage);
    const task = stage?.actions.find((candidate) => candidate.id === cursor.taskInstanceId);
    if (stage === undefined || stage.legacy || task?.task !== "agent.run") return false;
    const executionKey = journal.idempotencyKey({
      issueId,
      stage: cursor.stage,
      stageEpoch: cursor.stageEpoch,
      attempt: cursor.attempt,
      taskInstanceId: cursor.taskInstanceId,
    });
    return this.store.listRunsForExecution(issueId, cursor.stage, "producer", executionKey)
      .some((run) => this.store.getQuestionForRun(run.id) !== null);
  }

  /** Schedules one pass for the earliest future wake-up; past-due items are picked up by ordinary passes. */
  private armWakeTimer(): void {
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
    if (this.#shuttingDown) return;
    const next = this.store.executions().nextWakeupAfter(new Date());
    if (next === null) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null;
      this.schedule();
    }, Math.max(0, Date.parse(next) - Date.now()) + 50);
  }

  /** What native-stage tasks and MCP tools receive. */
  private taskDeps(issueId: string, repository: TaskDeps["repository"], signal?: AbortSignal): TaskDeps {
    return {
      store: this.store,
      config: this.config,
      items: this.executionGitHub(repository.id),
      repository,
      issueId,
      sourceGuidance: SOURCE_GUIDANCE,
      git: cliGit,
      workspaces: this.workspaceManager,
      mcp: this.mcpFactory(),
      harnesses: this.#harnesses,
      delivery: () => this.loadDeliveryState(issueId, repository.address),
      codeHost: this.executionCodeHost(issueId, this.codeHostFor(repository.id)),
      ci: {
        provider: () => this.executionCiProvider(repository.id),
        watchAdvisory: (input) => {
          this.#advisoryWatches.ensureWatch({
            repositoryId: repository.id, itemId: input.itemId, headSha: input.headSha, stage: input.stage,
            change: { changeId: input.changeId, url: input.changeUrl }, now: Date.now(),
          });
          void this.pollAdvisoryCi().catch(() => {});
        },
      },
      notify: (message, stageId) => {
        this.store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator", message,
        });
      },
      ...(signal ? { signal } : {}),
    };
  }

  private manualGatePlan(issue: StoredIssue) {
    const repositoryId = Object.entries(this.config.repositories).find(
      ([id, repository]) => id === issue.repositoryId || repository.address === issue.repositoryId,
    )?.[0];
    if (!repositoryId) throw new Error("issue repository is not configured");
    return this.config.plans.find((plan) => plan.repositoryId === repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId, registry: createTaskRegistry() });
  }

  /** A board approval belongs to a current or later native stage. */
  private boardApprovalCandidate(issue: StoredIssue, stageId: string) {
    if (!issue.labels.includes(this.config.labels.enrollment)) throw new Error("issue is not enrolled");
    if (issue.projectedState === "done" || issue.projectedState === "completed") {
      throw new Error("manual approval cannot be changed for a completed item");
    }
    const currentStage = issue.projectedStage;
    if (!currentStage) throw new Error("issue has no current stage");
    const plan = this.manualGatePlan(issue);
    const currentIndex = plan.stages.findIndex((stage) => stage.id === currentStage);
    const stageIndex = plan.stages.findIndex((stage) => stage.id === stageId);
    if (currentIndex < 0 || stageIndex < currentIndex) throw new Error("manual approval can be changed only for a current or future stage");
    const stage = plan.stages[stageIndex];
    if (!stage || stage.legacy) throw new Error("board approval is available only for native stages");
    return stage;
  }

  /** A configured manual gate is selected by its native stage entry or exit-gate task. */
  private manualGateCandidate(issue: StoredIssue, stageId: string, gateId: string) {
    const stage = this.boardApprovalCandidate(issue, stageId);
    if (gateId === ENTRY_APPROVAL_TASK_ID && stage.approval === "manual") {
      return { stageId, gateId, configured: true, task: ENTRY_APPROVAL_TASK_ID };
    }
    const task = stage.exitGate.find((candidate) => candidate.id === gateId);
    if (!task?.manual) throw new Error("manual approval is available only for configured manual gates");
    return { stageId, gateId, configured: true, task: task.task };
  }

  private readonly manualGateStatus: ManualGateResolver = ({ issueId, stageId, gateId, stageEpoch, attempt, configured, task }) => {
    const approval = this.#manualGateApprovals.getApproval(issueId, stageId, gateId, stageEpoch, attempt);
    const followUps = task === FOLLOW_UP_GATE_TASK ? followUpsFromBody(this.store.getIssue(issueId)?.body ?? "") : [];
    return {
      required: configured && (task !== FOLLOW_UP_GATE_TASK || followUps.length > 0),
      approved: approval !== null,
      message: task === FOLLOW_UP_GATE_TASK ? "Waiting for follow-up acknowledgement."
        : task === ENTRY_APPROVAL_TASK_ID ? "Waiting for configured entry approval."
        : `Waiting for configured manual gate \"${gateId}\".`,
    };
  };

  private readonly manualGateWaiting: ManualGateWaitingNotifier = ({ issueId, stageId, gateId, stageEpoch, attempt, task }) => {
    if (task !== FOLLOW_UP_GATE_TASK) return;
    this.store.recordPushEvent({
      id: `follow-up:${issueId}:${stageId}:${gateId}:${stageEpoch}:${attempt}`,
      category: "questions",
      target: issueId,
    });
  };

  private readonly boardApprovalStatus: BoardApprovalResolver = ({ issueId, stageId, stageEpoch, attempt }) => {
    const approval = this.#manualGateApprovals.getBoardApproval(issueId, stageId, stageEpoch, attempt);
    return {
      required: this.#manualGateApprovals.hasBoardApprovalRequirement(issueId, stageId),
      approved: approval !== null,
      message: "Waiting for board approval",
    };
  };

  /**
   * A Follow-ups gate has no actor that can notice a human clearing its notes.  Fence its parked
   * visit after a source read so the normal executor re-evaluates the now-empty gate and advances.
   */
  private wakeClearedFollowUps(repositoryId: string, before: ReadonlyMap<string, string>): void {
    if (this.store.repositoryPause(repositoryId)) return;
    const journal = this.store.executions();
    for (const issue of this.store.listIssues(repositoryId)) {
      const previousBody = before.get(issue.id);
      if (previousBody === undefined || followUpsFromBody(previousBody).length === 0 || followUpsFromBody(issue.body).length !== 0) continue;
      if (this.hasWaitingFollowUp(issue)) {
        journal.onStageChange(issue.id);
      }
    }
  }

  private followUpBodies(repositoryId: string): Map<string, string> {
    return new Map(this.store.listIssues(repositoryId).map((issue) => [issue.id, issue.body]));
  }

  private hasWaitingFollowUp(issue: StoredIssue): boolean {
    return this.manualGateViews(issue).some((gate) => gate.kind === "follow-up" && gate.waiting);
  }

  private manualGateViews(issue: StoredIssue) {
    if (!issue.labels.includes(this.config.labels.enrollment) || !issue.projectedStage || issue.projectedState === "done" || issue.projectedState === "completed") return [];
    try {
      const plan = this.manualGatePlan(issue);
      const current = plan.stages.findIndex((stage) => stage.id === issue.projectedStage);
      if (current < 0) return [];
      const cursor = this.store.executions().getCursor(issue.id);
      const epoch = this.store.executions().stageEpoch(issue.id);
      return plan.stages.slice(current).flatMap((stage) => {
        if (stage.legacy) return [];
        const visit = cursor?.stage === stage.id && cursor.stageEpoch === epoch ? cursor : null;
        const boardApproval = visit
          ? this.#manualGateApprovals.getBoardApproval(issue.id, stage.id, epoch, visit.attempt)
          : null;
        const board = {
          stageId: stage.id,
          gateId: null,
          kind: "board" as const,
          required: this.#manualGateApprovals.hasBoardApprovalRequirement(issue.id, stage.id),
          waiting: visit?.list === "exit-gate" && visit.taskInstanceId === BOARD_APPROVAL_TASK_ID && visit.state === "pending" && visit.wakeAt === null,
          approvedBy: boardApproval?.accountName ?? null,
          approvedAt: boardApproval?.approvedAt ?? null,
        };
        const entryApproval = visit
          ? this.#manualGateApprovals.getApproval(issue.id, stage.id, ENTRY_APPROVAL_TASK_ID, epoch, visit.attempt)
          : null;
        const entry = stage.approval === "manual" ? [{
          stageId: stage.id,
          gateId: ENTRY_APPROVAL_TASK_ID,
          kind: "entry" as const,
          required: true,
          waiting: visit?.list === "actions" && visit.taskInstanceId === ENTRY_APPROVAL_TASK_ID && visit.state === "pending" && visit.wakeAt === null,
          approvedBy: entryApproval?.accountName ?? null,
          approvedAt: entryApproval?.approvedAt ?? null,
        }] : [];
        const configured = stage.exitGate.flatMap((task) => {
          if (!task.manual) return [];
          const approval = visit ? this.#manualGateApprovals.getApproval(issue.id, stage.id, task.id, epoch, visit.attempt) : null;
          const followUp = task.task === FOLLOW_UP_GATE_TASK;
          return [{
            stageId: stage.id,
            gateId: task.id,
            kind: followUp ? "follow-up" as const : "configured" as const,
            required: followUp ? followUpsFromBody(issue.body).length > 0 : true,
            waiting: visit?.list === "exit-gate" && visit.taskInstanceId === task.id && visit.state === "pending" && visit.wakeAt === null,
            approvedBy: approval?.accountName ?? null,
            approvedAt: approval?.approvedAt ?? null,
            ...(followUp ? { notes: followUpsFromBody(issue.body) } : {}),
          }];
        });
        return [board, ...entry, ...configured];
      });
    } catch {
      return [];
    }
  }

  /** Changes an enrolled item's final board-approval requirement without altering repository configuration. */
  setBoardApprovalRequirement(issueId: string, stageId: string, required: boolean): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    this.boardApprovalCandidate(issue, stageId);
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const wasRequired = this.#manualGateApprovals.hasBoardApprovalRequirement(issueId, stageId);
    if (required && !wasRequired && stageId === issue.projectedStage &&
      this.store.listStageTransitions(issueId).some((transition) => transition.fromStage === stageId && transition.status === "pending")) {
      throw new Error("board approval cannot be changed while the current stage is advancing");
    }
    this.#manualGateApprovals.setBoardApprovalRequirement({ issueId, stageId, required, changedAt: new Date().toISOString() });
    // A gate may have read its requirement immediately before this board action.
    // Starting a new epoch makes that in-flight decision stale before it can advance.
    // The fence must be synchronous: a subscriber would leave a window for the stale decision.
    // Waking a gate parked on this requirement, and scheduling, follow from the change's event.
    if (required && !wasRequired && stageId === issue.projectedStage && cursor?.stage === stageId && cursor.list === "exit-gate") {
      journal.onStageChange(issueId);
    }
  }

  /** Records a human receipt only for the current manual gate visit, then wakes that item. */
  approveManualGate(issueId: string, stageId: string, gateId: string | null, account: { id: string; username: string }): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    const candidate = gateId !== null ? this.manualGateCandidate(issue, stageId, gateId) : null;
    if (gateId === null) this.boardApprovalCandidate(issue, stageId);
    const journal = this.store.executions();
    const cursor = journal.getCursor(issueId);
    const stageEpoch = journal.stageEpoch(issueId);
    const expectedList = gateId === ENTRY_APPROVAL_TASK_ID ? "actions" : "exit-gate";
    if (!cursor || cursor.stage !== stageId || cursor.stageEpoch !== stageEpoch || cursor.list !== expectedList ||
      cursor.taskInstanceId !== (gateId ?? BOARD_APPROVAL_TASK_ID) || cursor.state !== "pending") {
      throw new Error(gateId === null ? "board approval is not waiting for approval" : "manual gate is not waiting for approval");
    }
    const status = gateId === null
      ? this.boardApprovalStatus({ issueId, stageId, stageEpoch, attempt: cursor.attempt })
      : this.manualGateStatus({ issueId, stageId, gateId, stageEpoch, attempt: cursor.attempt, configured: true, task: candidate!.task });
    if (!status.required) throw new Error(gateId === null ? "board approval is not required for this stage" : "manual approval is not required for this gate");
    const existing = gateId === null
      ? this.#manualGateApprovals.getBoardApproval(issueId, stageId, stageEpoch, cursor.attempt)
      : this.#manualGateApprovals.getApproval(issueId, stageId, gateId, stageEpoch, cursor.attempt);
    // A retry after the first request woke the item is a harmless no-op.  A
    // different pending gate, however, must not receive a late approval.
    if (existing) return;
    if (cursor.wakeAt !== null) throw new Error(gateId === null ? "board approval is not waiting for approval" : "manual gate is not waiting for approval");
    const approvedAt = new Date().toISOString();
    const recorded = gateId === null
      ? this.#manualGateApprovals.approveBoard({ issueId, stageId, stageEpoch, attempt: cursor.attempt, accountId: account.id, accountName: account.username, approvedAt })
      : this.#manualGateApprovals.approve({ issueId, stageId, gateId, stageEpoch, attempt: cursor.attempt, accountId: account.id, accountName: account.username, approvedAt });
    if (recorded) {
      this.store.appendConversationMessage({
        issueId, runId: null, stageId, actorType: "user", actorId: account.id,
        actorName: account.username, actorTitle: "Superuser",
        message: gateId === null ? "Approved board approval."
          : candidate!.task === FOLLOW_UP_GATE_TASK ? "Acknowledged Follow-ups."
          : candidate!.task === ENTRY_APPROVAL_TASK_ID ? "Approved configured entry approval."
          : `Approved configured manual gate \"${gateId}\".`,
      });
    }
    // The approval event wakes the item.
  }

  /** Log correlation for an item: its repository and <repository>:<number>. */
  private itemFields(issueId: string): LogFields {
    const issue = this.store.getIssue(issueId);
    return issue ? { repository: issue.repositoryId, item: `${issue.repositoryId}:${issue.sourceNumber}` } : { item: issueId };
  }

  /** One record per stage pass, keeping gate and agent stops apart from infrastructure failures. */
  private logOutcome(issueId: string, outcome: StageOutcome): void {
    const fields = { ...this.itemFields(issueId), stage: outcome.stageId };
    if (outcome.kind === "advance") log.info("Stage passed", { ...fields, next: outcome.nextStageId });
    else if (outcome.kind === "stopped") log.warn("Stage stopped", { ...fields, state: outcome.state, reason: outcome.reason });
    else if (outcome.kind === "correction") log.info("Stage returned to an earlier stage", { ...fields, target: outcome.targetStageId, reason: outcome.reason });
    else log.debug("Stage parked", { ...fields, reason: outcome.reason, wakeAt: outcome.wakeAt });
  }

  private async execute(issue: StoredIssue, signal: AbortSignal): Promise<void> {
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    const executor = new IssueExecutor({
      config: this.config,
      store: this.store,
      sourceName: repository.source,
      source: this.executionGitHub(issue.repositoryId),
      workspaceManager: this.workspaceManager,
      recoverWorkspaceChange: async (currentIssue, currentRepository, workspace) => {
        const codeHost = this.executionCodeHost(currentIssue.id, this.codeHostFor(currentRepository.id));
        if (!codeHost) return;
        await recoverClosedChange({
          codeHost, store: this.store, source: currentRepository.source, address: currentRepository.address,
          issue: { id: currentIssue.id, sourceNumber: currentIssue.sourceNumber, title: currentIssue.title },
          workspace, base: currentRepository.baseBranch, closes: true,
        });
      },
      loadDeliveryState: async (currentIssue, currentRepository) =>
        this.loadDeliveryState(currentIssue.id, currentRepository.address),
      sourceGuidance: SOURCE_GUIDANCE,
      taskDeps: (currentIssue, currentRepository) => this.taskDeps(currentIssue.id, currentRepository, signal),
      manualGate: this.manualGateStatus,
      manualGateWaiting: this.manualGateWaiting,
      boardApproval: this.boardApprovalStatus,
      waitFallback: (repositoryId, kind) => this.waitFallbackMs(repositoryId, kind),
      admitInFlight: (currentIssue, targetStageId) => this.inFlightAdmission(currentIssue, targetStageId),
      signal,
      runtime: (context, refreshDeliveryState) => new ConfiguredStageRuntime(
        this.config,
        this.store,
        context,
        this.mcpFactory(),
        this.sourceActions(context),
        refreshDeliveryState,
        {},
        signal,
      ),
    });
    try {
      const warningBefore = this.store.getIssue(issue.id)?.warning ?? null;
      const outcome = await executor.execute(issue);
      this.logOutcome(issue.id, outcome);
      if (outcome.kind === "parked") {
        // A transition can reach the repository pause fence after the stage
        // itself has completed. Its pending source mutation is deliberately
        // retained for resume; do not turn the status-comment write into an
        // infrastructure failure while that repository is paused.
        if (this.store.repositoryPause(issue.repositoryId)) {
          return;
        }
        // A parked poll changes nothing at the source: no reconcile, just the status line.
        this.restorePendingStatus(issue.repositoryId);
        if ((this.store.getIssue(issue.id)?.warning ?? null) !== warningBefore) await this.updateStatusComment(issue.id);
      } else {
        // The item's own step changed its state; nothing else in the repository did.
        await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
        await this.updateStatusComment(issue.id);
      }
    } catch (error) {
      if (signal.aborted) return;
      await this.handleInfrastructureFailure(issue, error);
      return;
    }
    this.#infrastructureFailures.delete(issue.id);
  }

  /**
   * A stage that failed outside its own tasks (runner crash, provider outage, a bug in Conveyor) is
   * retried with exponential backoff and, once `settings.retries` is used up, stopped as `error` with
   * the reason, instead of retrying the same deterministic failure forever.
   */
  private async handleInfrastructureFailure(issue: StoredIssue, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const stageId = this.store.getStageState(issue.id)?.stageId ?? issue.projectedStage ?? "";
    const previous = this.#infrastructureFailures.get(issue.id);
    const failures = previous?.stageId === stageId ? previous.count + 1 : 1;
    const decision = infrastructureRetry({ failures, usageLimit: isUsageLimitError(error), retries: this.config.settings.retries });
    if ("retryInMs" in decision) {
      const now = new Date();
      const waiting: IssueWaitingViewModel = {
        kind: "waiting",
        reason: `Execution failed: ${message}`,
        since: previous?.stageId === stageId && previous.waiting
          ? previous.waiting.since
          : now.toISOString(),
        nextCheckAt: new Date(now.getTime() + decision.retryInMs).toISOString(),
        deadline: null,
      };
      this.#infrastructureFailures.set(issue.id, { stageId, count: failures, waiting });
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: "active",
        warning: `Execution failed and will retry in ${formatDuration(decision.retryInMs)}: ${message}`,
      });
      await this.updateStatusComment(issue.id).catch((statusError) => {
        log.error("Status comment update failed", this.itemFields(issue.id), statusError);
      });
      log.warn("Stage failed outside its tasks; retrying", { ...this.itemFields(issue.id), stage: stageId, attempt: failures, retryInMs: decision.retryInMs }, error);
      this.retryLater(issue.id, decision.retryInMs);
      return;
    }
    this.#infrastructureFailures.delete(issue.id);
    const repository = this.config.repositories[issue.repositoryId]!;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    const reason = `${displayName(stageId)} stopped after ${failures} failed attempts: ${message}`;
    log.error("Stage stopped as error after repeated failures", { ...this.itemFields(issue.id), stage: stageId, attempts: failures }, error);
    this.store.appendConversationMessage({
      issueId: issue.id, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: reason,
    });
    await applyStageTransition({
      store: this.store,
      source: this.executionGitHub(issue.repositoryId),
      sourceName: repository.source,
      address: repository.address,
      configHash: this.config.hash,
      transitionId: randomUUID(),
      issue,
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      result: { kind: "stopped", stageId, state: "error", reason, requiredFixes: [], feedbackCycles: 0, result: null },
      actor: { name: "Conveyor", title: "Orchestrator" },
    }).catch((transitionError) => {
      log.error("Stopping the item as error failed", { ...this.itemFields(issue.id), stage: stageId }, transitionError);
    });
    await this.updateStatusComment(issue.id).catch(() => {});
  }

  private retryLater(issueId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      if (this.#shuttingDown) return;
      const failure = this.#infrastructureFailures.get(issueId);
      if (failure) this.#infrastructureFailures.set(issueId, {
        stageId: failure.stageId,
        count: failure.count,
      });
      const current = this.store.getStageState(issueId);
      if (current?.status === "error") {
        this.store.setStageState({
          issueId,
          stageId: current.stageId,
          status: "ready",
          feedbackCycle: current.feedbackCycle,
          configHash: this.config.hash,
        });
        this.schedule();
      }
    }, delayMs);
    this.#retryTimers.add(timer);
  }

  /** Reconciliation resets warnings; a parked item's pending message is re-applied from its journal. */
  private restorePendingStatus(repositoryId: string): void {
    if (this.store.repositoryPause(repositoryId)) return;
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.projectedState !== "active" || issue.warning) continue;
      const message = this.store.executions().pendingMessage(issue.id);
      if (message === null) continue;
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: issue.projectedState,
        warning: message,
      });
    }
  }

  private async loadDeliveryState(
    issueId: string,
    address: string,
  ): Promise<{ change: unknown | null; pullRequest: unknown | null; checks: unknown[] }> {
    const stored = this.store.getCurrentPullRequest(issueId);
    if (!stored) return { change: null, pullRequest: null, checks: [] };
    const repository = this.store.getIssue(issueId)?.repositoryId;
    const host = repository ? this.executionCodeHost(issueId, this.codeHostFor(repository)) : null;
    if (!host) throw new Error(`no code host configured for ${issueId}`);
    const delivery = await host.getChangeDelivery({ address, id: stored.id });
    this.store.upsertPullRequest({
      issueId,
      id: stored.id,
      number: delivery.change.number,
      url: delivery.change.url,
      state: delivery.change.state,
      ...(delivery.change.mergedAt || stored.mergedAt
        ? { mergedAt: delivery.change.mergedAt ?? stored.mergedAt }
        : {}),
    });
    const change: CiChange = { repository: address, changeId: String(delivery.change.number), url: delivery.change.url };
    const checks = await this.ciProvider(this.store.getIssue(issueId)?.repositoryId ?? "").list(change, delivery.change.headSha);
    return { change: delivery.change, pullRequest: delivery.pullRequest ?? null, checks };
  }

  private ciProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider {
    const repository = this.config.repositories[repositoryId];
    if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
    const providerName = repository.ci.provider ?? "actions";
    // Unreferenced named providers are inert. An omitted repository reference
    // selects its source-native provider with no named-provider configuration.
    const configured = repository.ci.provider ? this.config.ci[repository.ci.provider] : undefined;
    const stageTriggers = stageInput?.triggers;
    const configuredTriggers = configured?.triggers;
    const triggers = parseGitHubActionsTriggers(
      configuredTriggers?.length ? configuredTriggers : stageTriggers,
      configuredTriggers?.length ? `ci.${providerName}.triggers` : "pullRequest.awaitChecks.with.triggers",
    );
    const key = `${repositoryId}:${providerName}:${JSON.stringify(triggers)}`;
    let provider = this.#ciProviders.get(key);
    if (!provider) {
      if (configured && configured.type !== "github-actions") throw new Error(`unsupported CI provider: ${providerName}`);
      provider = new GitHubActionsCiProvider(this.github, triggers);
      this.#ciProviders.set(key, provider);
    }
    return provider;
  }

  /** Lets a paused repository keep observing CI while preventing CI dispatches and reruns. */
  private executionCiProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider {
    const provider = this.ciProvider(repositoryId, stageInput);
    const store = this.store;
    return new Proxy(provider, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property !== "start" && property !== "rerun") return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  /** The code host an item's run uses: its writes stop at the durable repository pause boundary. */
  private executionCodeHost(issueId: string, host: CodeHost | null): CodeHost | null {
    if (!host) return null;
    const repositoryId = this.store.getIssue(issueId)?.repositoryId;
    const store = this.store;
    return new Proxy(host, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (!CODE_HOST_WRITES.has(String(property))) return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (repositoryId && store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  /** Fences every item-task source mutation at the durable repository pause boundary. */
  private executionGitHub(repositoryId: string): GitHubAdapter {
    const store = this.store;
    return new Proxy(this.github, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (!GITHUB_WRITES.has(String(property))) return value.bind(target) as unknown;
        return async (...args: unknown[]) => {
          if (store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
          return Reflect.apply(value, target, args) as unknown;
        };
      },
    });
  }

  private codeHostFor(repositoryId: string): CodeHost | null {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return null;
    const name = repository.codeHost ?? repository.source;
    return this.#codeHosts.get(name) ?? null;
  }

  /** A stage that only runs an in-process source action: no producer or verifier process. */
  private isLightweightStage(repositoryId: string, stageId: string): boolean {
    return isLightweightRepositoryStage(this.config, repositoryId, stageId);
  }

  private interruptIneligibleRuns(): void {
    for (const [issueId, active] of this.#active) {
      const issue = this.store.getIssue(issueId);
      if (
        !issue ||
        issue.projectedState !== "active" ||
        issue.projectedStage !== active.stageId
      ) {
        active.controller.abort();
      }
    }
  }

  /**
   * `full` lists every issue. `changed` lists the issues changed since Conveyor last saw the
   * repository: since its previous listing in this run, or after a restart since the newest change it
   * stored. `finish` records a successful read.
   */
  private issueListing(repositoryId: string, mode: "full" | "changed"): { since?: string; finish(): void } {
    const startedAt = Date.now();
    const since = mode === "changed" ? this.#issueListings.get(repositoryId)?.since ?? this.storedSince(repositoryId) : undefined;
    return {
      ...(since !== undefined ? { since } : {}),
      finish: () => this.#issueListings.set(repositoryId, { since: new Date(startedAt - ISSUE_LISTING_OVERLAP_MS).toISOString() }),
    };
  }

  /** Just before the newest change Conveyor stored for a repository; undefined when it stored none. */
  private storedSince(repositoryId: string): string | undefined {
    let newest = Number.NEGATIVE_INFINITY;
    for (const issue of this.store.listIssues(repositoryId)) newest = Math.max(newest, Date.parse(issue.sourceUpdatedAt));
    return Number.isFinite(newest) ? new Date(newest - ISSUE_LISTING_OVERLAP_MS).toISOString() : undefined;
  }

  /**
   * Reads the source into the projection. `only` reads just those issues (one request each) and
   * touches nothing else, for work on one item; otherwise a listing, partial for a webhook pass.
   */
  private async reconcileRepository(repositoryId: string, options: { partial?: boolean; includeIssueNumbers?: readonly number[]; only?: readonly number[] } = {}): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    if (options.only) {
      await this.refreshIssues(repositoryId, options.only);
      return;
    }
    const pipeline = this.config.pipelines[repository.pipeline]!;
    const followUpBodies = this.followUpBodies(repositoryId);
    const listing = this.issueListing(repositoryId, options.partial === true ? "changed" : "full");
    await reconcileRepository({
      store: this.store,
      configHash: this.config.hash,
      repository: {
        id: repositoryId,
        configName: repositoryId,
        source: repository.source,
        address: repository.address,
        folder: repository.folder,
      },
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      source: this.executionGitHub(repositoryId),
      trust: this.#issueTrust,
      extraTrustedLogins: repository.extraTrustedLogins ?? [],
      expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
      ...(listing.since !== undefined ? { since: listing.since } : {}),
      ...(options.includeIssueNumbers !== undefined ? { includeIssueNumbers: options.includeIssueNumbers } : {}),
    });
    listing.finish();
    if (this.store.repositoryPause(repositoryId)) return;
    const scope = options.includeIssueNumbers ? new Set(options.includeIssueNumbers) : null;
    await this.reconcileRelationships(repositoryId, repository.address, scope);
    await this.backfillCiIndicators(repositoryId, scope);
    this.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.restorePendingStatus(repositoryId);
    this.interruptIneligibleRuns();
    this.store.events().append("repository.reconciled", { issueNumbers: options.includeIssueNumbers ? [...options.includeIssueNumbers] : null }, { repositoryId });
  }

  /** Reads the named issues of a repository and updates only them: one request per issue, no listing. */
  private async refreshIssues(repositoryId: string, numbers: readonly number[]): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    const followUpBodies = this.followUpBodies(repositoryId);
    const issues = await Promise.all([...new Set(numbers)].map((number) => this.github.getIssue(repository.address, number)));
    await reconcileRepository({
      store: this.store,
      configHash: this.config.hash,
      repository: { id: repositoryId, configName: repositoryId, source: repository.source, address: repository.address, folder: repository.folder },
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      source: this.executionGitHub(repositoryId),
      trust: this.#issueTrust,
      extraTrustedLogins: repository.extraTrustedLogins ?? [],
      expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
      issues,
      // Conveyor's own label writes move updated_at but change neither enrollment nor text. Anyone
      // else's change arrives as a delivery that names them, so a trusted item keeps its decision.
      ...(this.webhookUrl(repositoryId)
        ? { delivered: new Map(numbers.map((number) => [number, { enrollment: "unchanged", title: "unchanged", body: "unchanged" } as const])) }
        : {}),
    });
    if (this.store.repositoryPause(repositoryId)) return;
    const scope = new Set(numbers);
    await this.reconcileRelationships(repositoryId, repository.address, scope);
    this.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.restorePendingStatus(repositoryId);
    this.interruptIneligibleRuns();
    this.store.events().append("repository.reconciled", { issueNumbers: [...scope] }, { repositoryId });
  }

  /**
   * The sub-issues and blockers of an issue. Every reconcile needs them, so an issue unchanged since
   * its last read reuses that read for up to an hour; sub-issue and dependency webhooks drop it sooner.
   */
  private async relationshipsOf(address: string, issue: StoredIssue, refresh = true): Promise<{ children: SourceIssue[]; dependencies: SourceIssue[] }> {
    const cached = this.#relationships.get(issue.id);
    // A pass scoped to some issues reuses what it knows of the others, however old: the read of
    // this run, or after a restart the relationships it stored.
    if (cached && !refresh) return cached;
    if (!refresh) return this.storedRelationships(issue);
    // Healthy webhooks report relationship changes, so a read is trusted for longer.
    const reuseMs = this.webhookUrl(issue.repositoryId) ? HEALTHY_RELATIONSHIP_REUSE_MS : RELATIONSHIP_REUSE_MS;
    if (cached && cached.updatedAt === issue.sourceUpdatedAt && Date.now() - cached.readAt < reuseMs) return cached;
    const children = await this.github.listSubIssues(address, issue.sourceNumber);
    const dependencies = await this.github.listDependencies(address, issue.sourceNumber);
    const read = { updatedAt: issue.sourceUpdatedAt, readAt: Date.now(), children, dependencies };
    this.#relationships.set(issue.id, read);
    return read;
  }

  /** The sub-issues and blockers Conveyor stored for an issue, in the shape a GitHub read returns. */
  private storedRelationships(issue: StoredIssue): { children: SourceIssue[]; dependencies: SourceIssue[] } {
    const asSource = (id: string): SourceIssue[] => {
      const stored = this.store.getIssue(id);
      return stored ? [{
        id: stored.id, number: stored.sourceNumber, url: stored.sourceUrl, title: stored.title, body: stored.body,
        state: stored.sourceState === "closed" ? "closed" : "open", stateReason: stored.sourceStateReason ?? null,
        labels: stored.labels, updatedAt: stored.sourceUpdatedAt,
      }] : [];
    };
    const children = [...this.store.listChildren(issue.id)].sort((left, right) => (left.siblingOrder ?? 0) - (right.siblingOrder ?? 0));
    return { children: children.flatMap((child) => asSource(child.issueId)), dependencies: this.store.listDependencies(issue.id).flatMap(asSource) };
  }

  /** Whether an item and all of its descendants meet the roll-up completion rule. */
  private isRollupSatisfied(issueId: string, visited = new Set<string>()): boolean {
    if (visited.has(issueId)) return false;
    const issue = this.store.getIssue(issueId);
    if (!issue) return false;
    const children = this.store.listChildren(issueId);
    const next = new Set(visited).add(issueId);
    if (children.length > 0) {
      return children.every((child) => this.isRollupSatisfied(child.issueId, next));
    }
    const doneLabel = this.config.labels.states.done;
    return (doneLabel !== undefined && issue.labels.includes(doneLabel)) ||
      (issue.sourceState === "closed" &&
        (!this.store.hasMergedPullRequest(issue.id) || this.hasWaitingFollowUp(issue)));
  }

  /** Reflect the successful, source-authoritative close without waiting for another poll. */
  private recordClosedRollupParent(parent: StoredIssue, sourceIssue: SourceIssue): void {
    this.store.upsertIssue({
      id: parent.id,
      repositoryId: parent.repositoryId,
      sourceNumber: sourceIssue.number,
      sourceUrl: sourceIssue.url,
      title: parent.title,
      body: parent.body,
      sourceState: sourceIssue.state,
      sourceStateReason: sourceIssue.stateReason ?? null,
      labels: sourceIssue.labels,
      sourceUpdatedAt: sourceIssue.updatedAt,
      ...(parent.acceptedTextAt !== undefined ? { acceptedTextAt: parent.acceptedTextAt } : {}),
      ...(sourceIssue.type !== undefined ? { issueType: sourceIssue.type } : {}),
    });
    this.store.setIssueProjection(parent.id, {
      stage: parent.projectedStage,
      state: "done",
      warning: null,
    });
  }

  /** Mark and close a completed active roll-up, recovering each source mutation independently. */
  private async completeRollupParent(
    repositoryId: string,
    address: string,
    parent: StoredIssue,
    doneLabel: string | undefined,
  ): Promise<void> {
    if (this.store.repositoryPause(repositoryId)) return;
    const github = this.executionGitHub(repositoryId);
    const repository = this.config.repositories[repositoryId]!;
    const stageLabel = parent.projectedStage
      ? [this.config.labels.stageTemplate.replace("{stage}", parent.projectedStage)]
      : [];
    const closeMutationKeyPrefix = `rollup-completion-close:${parent.id}:`;

    let current = await github.getIssue(address, parent.sourceNumber);
    const priorCloseMutation = this.store.getLatestSourceMutationByKeyPrefix(closeMutationKeyPrefix);
    if (
      current.state === "closed" &&
      current.stateReason === "completed" &&
      priorCloseMutation &&
      priorCloseMutation.status !== "succeeded"
    ) {
      // A request can reach GitHub even when its response is lost. Seeing the
      // completed state on a later reconciliation is the authoritative proof
      // that the planned mutation finished, so do not issue a second close.
      this.store.completeSourceMutation(priorCloseMutation.id, {
        state: current.state,
        stateReason: current.stateReason,
      });
      this.recordClosedRollupParent(parent, current);
      return;
    }
    if (
      !doneLabel ||
      current.state !== "open" ||
      !current.labels.includes(this.config.labels.enrollment)
    ) {
      return;
    }
    const labels = [
      this.config.labels.enrollment,
      ...stageLabel,
      doneLabel,
      ...metadataLabels(current.labels, this.config)
        .filter((label) => label !== this.config.labels.metadata.closable),
    ].sort((left, right) => left.localeCompare(right));
    const currentConveyorLabels = current.labels
      .filter(
        (label) =>
          label === this.config.labels.enrollment ||
          label.startsWith(`${this.config.labels.enrollment}:`) ||
          label === this.config.labels.metadata.noSplit,
      )
      .sort((left, right) => left.localeCompare(right));
    const needsLabelUpdate = labels.length !== currentConveyorLabels.length ||
      labels.some((label, index) => label !== currentConveyorLabels[index]);

    if (needsLabelUpdate) {
      const labelMutationDigest = createHash("sha256")
        .update(`${parent.id}\0${current.updatedAt}\0${[...current.labels].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 24);
      const labelMutation = this.store.beginSourceMutation({
        // The source snapshot starts a completion episode. It remains stable
        // while a failed label write is retried, but changes before a parent
        // can be completed again after GitHub reopens or relabels it.
        idempotencyKey: `rollup-completion-labels:${parent.id}:${labelMutationDigest}`,
        source: repository.source,
        operation: "issue.labels.replace",
        request: { issueId: parent.id, issueNumber: parent.sourceNumber, labels },
      });
      if (labelMutation.status !== "succeeded") {
        try {
          await github.replaceConveyorLabels(
            address,
            parent.sourceNumber,
            labels,
            [this.config.labels.metadata.noSplit],
          );
          this.store.completeSourceMutation(labelMutation.id, { labels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          this.store.failSourceMutation(
            labelMutation.id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      current = await github.getIssue(address, parent.sourceNumber);
    }

    if (
      current.state !== "open" ||
      !current.labels.includes(this.config.labels.enrollment)
    ) {
      return;
    }
    if (!current.labels.includes(doneLabel)) {
      throw new Error("Completed roll-up parent no longer has its done label; refusing to close it.");
    }

    const closeMutationDigest = createHash("sha256")
      .update(`${parent.id}\0${current.updatedAt}\0${[...current.labels].sort().join("\0")}`)
      .digest("hex")
      .slice(0, 24);
    const closeMutation = this.store.beginSourceMutation({
      idempotencyKey: `${closeMutationKeyPrefix}${closeMutationDigest}`,
      source: repository.source,
      operation: "issue.close",
      request: {
        issueId: parent.id,
        issueNumber: parent.sourceNumber,
        stateReason: "completed",
      },
    });
    if (closeMutation.status === "succeeded") return;
    try {
      const closed = await github.closeIssue(address, parent.sourceNumber);
      if (closed.state !== "closed") {
        throw new Error("GitHub did not confirm the completed roll-up parent as closed.");
      }
      this.store.completeSourceMutation(closeMutation.id, {
        state: closed.state,
        stateReason: closed.stateReason ?? null,
      });
      this.recordClosedRollupParent(parent, closed);
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      // GitHub can apply the close and still answer with an error (a 422 was seen in production), so
      // the issue's state decides: a closed issue is a completed close, not a failure to retry.
      const observed = await this.github.getIssue(address, parent.sourceNumber).catch(() => null);
      if (observed?.state === "closed") {
        this.store.completeSourceMutation(closeMutation.id, { state: observed.state, stateReason: observed.stateReason ?? null });
        this.recordClosedRollupParent(parent, observed);
        return;
      }
      this.store.failSourceMutation(
        closeMutation.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  /** Completes one roll-up parent; its failure is that parent's, so the rest of the repository still reconciles. */
  private async completeRollupParentLogged(repositoryId: string, address: string, parent: StoredIssue, doneLabel: string | undefined): Promise<boolean> {
    try {
      await this.completeRollupParent(repositoryId, address, parent, doneLabel);
      return true;
    } catch (error) {
      if (error instanceof RepositoryPausedError) return false;
      log.warn("Roll-up parent could not be closed; the next pass retries it", this.itemFields(parent.id), error);
      return false;
    }
  }


  /** Drops the remembered sub-issues and blockers of the named issues, so the next pass reads them. */
  private forgetRelationships(repositoryId: string, numbers: readonly number[]): void {
    const named = new Set(numbers);
    for (const issue of this.store.listIssues(repositoryId)) {
      if (named.has(issue.sourceNumber)) this.#relationships.delete(issue.id);
    }
  }

  /** `scope` names the issues a webhook pass reads afresh; the others keep what was read before. Null reads all. */
  private async reconcileRelationships(
    repositoryId: string,
    address: string,
    scope: ReadonlySet<number> | null = null,
  ): Promise<void> {
    if (this.store.repositoryPause(repositoryId)) return;
    const refresh = (issue: StoredIssue) => scope === null || scope.has(issue.sourceNumber);
    const issues = this.store
      .listIssues(repositoryId)
      .filter(
        (issue) =>
          // A closed enrolled intermediate can still contain descendants that
          // decide its open ancestor's roll-up state.
          (issue.sourceState === "open" || issue.labels.includes(this.config.labels.enrollment)) &&
          // Stopped items too: the board must show the dependencies a person
          // added while an item was blocked, and the scheduler needs them the
          // moment it is unblocked.
          !["offboarded", "missing"].includes(issue.projectedState ?? ""),
      );
    const issueByNumber = new Map(
      this.store
        .listIssues(repositoryId)
        .map((issue) => [issue.sourceNumber, issue]),
    );
    const parents = new Map<string, { parentId: string; siblingOrder: number }>();
    for (const parent of issues) {
      const { children } = await this.relationshipsOf(address, parent, refresh(parent));
      for (const [index, child] of children.entries()) {
        const storedChild = issueByNumber.get(child.number);
        if (storedChild) {
          parents.set(storedChild.id, { parentId: parent.id, siblingOrder: index + 1 });
        }
      }
    }
    const activeIssueIds = new Set(issues.map((issue) => issue.id));
    for (const [childId, parent] of parents) {
      if (activeIssueIds.has(childId)) continue;
      this.store.replaceRelationships(
        childId,
        parent,
        this.store.listDependencies(childId),
      );
    }
    for (const issue of issues) {
      const { dependencies } = await this.relationshipsOf(address, issue, refresh(issue));
      const blockerIds: string[] = [];
      for (const dependency of dependencies) {
        const storedDependency = issueByNumber.get(dependency.number);
        if (storedDependency) {
          blockerIds.push(storedDependency.id);
          continue;
        }
        this.store.upsertIssue({
          id: dependency.id,
          repositoryId,
          sourceNumber: dependency.number,
          sourceUrl: dependency.url,
          // Dependencies can be read before they are independently reconciled.
          // Do not make that raw read an agent-visible snapshot.
          title: "",
          body: "",
          sourceState: dependency.state,
          sourceStateReason: dependency.stateReason ?? null,
          labels: dependency.labels,
          sourceUpdatedAt: dependency.updatedAt,
          acceptedTextAt: null,
          ...(dependency.type !== undefined ? { issueType: dependency.type } : {}),
        });
        this.store.setIssueProjection(dependency.id, {
          stage: null,
          state: "offboarded",
          warning: null,
        });
        blockerIds.push(dependency.id);
        const inserted = this.store.getIssue(dependency.id);
        if (inserted) issueByNumber.set(dependency.number, inserted);
      }
      this.store.replaceRelationships(
        issue.id,
        parents.get(issue.id) ?? null,
        blockerIds,
      );
    }
    const doneLabel = this.config.labels.states.done;
    const pipeline = this.config.pipelines[
      this.config.repositories[repositoryId]!.pipeline
    ]!;
    const stageIds = pipeline.stages.map((stage) => stage.id);
    const stageRanks = new Map(stageIds.map((stageId, index) => [stageId, index]));
    const rollupStage = (
      issueId: string,
      visited = new Set<string>(),
    ): string | null => {
      if (visited.has(issueId)) return null;
      const next = new Set(visited).add(issueId);
      const unfinishedChildren = this.store
        .listChildren(issueId)
        .filter((child) => !this.isRollupSatisfied(child.issueId));
      const childStages = unfinishedChildren.flatMap((child) => {
        const nestedStage = rollupStage(child.issueId, next);
        const stage = nestedStage ?? this.store.getIssue(child.issueId)?.projectedStage;
        return stage && stageRanks.has(stage) ? [stage] : [];
      });
      return childStages.sort(
        (left, right) => stageRanks.get(left)! - stageRanks.get(right)!,
      )[0] ?? null;
    };
    const runningIssueIds = new Set(
      [
        ...this.store.listActiveIssueRuns().map((run) => run.issueId),
        ...this.#active.keys(),
      ],
    );
    const repositoryIssues = this.store.listIssues(repositoryId);
    for (const parent of repositoryIssues) {
      if (this.store.repositoryPause(repositoryId)) return;
      const children = this.store.listChildren(parent.id);
      const closeMutation = this.store.getLatestSourceMutationByKeyPrefix(`rollup-completion-close:${parent.id}:`);
      if (
        children.length > 0 &&
        parent.sourceState === "closed" &&
        closeMutation &&
        closeMutation.status !== "succeeded"
      ) {
        await this.completeRollupParentLogged(repositoryId, address, parent, doneLabel);
        continue;
      }
      if (
        children.length === 0 ||
        parent.sourceState !== "open" ||
        !parent.labels.includes(this.config.labels.enrollment)
      ) {
        continue;
      }
      // A live parent run owns its outcome, including any question it asks.
      // Child roll-up must not fence that run or replace its source state.
      if (runningIssueIds.has(parent.id)) continue;
      // A retried child-creation stage may be queued behind available capacity.
      // Keep its stage intact until it can run; otherwise roll-up would replace
      // it with a child's frontier before it creates the remaining children.
      if (this.childCreationStageIsReady(parent)) continue;
      // A parked question has already finished its producer run, but its cursor
      // still belongs to that run and must survive until its answer resumes it.
      if (this.hasResumableQuestionExecution(parent.id)) continue;
      // A stage that passed earlier may subsequently be stopped. Never let a
      // roll-up erase that stop while its source state still says to park it.
      if (this.hasRollupStopLabel(parent)) continue;
      if (this.store.getStageState(parent.id)?.status !== "running") {
        await removeWorkspace({
          store: this.store,
          manager: this.workspaceManager,
          issueId: parent.id,
          repositoryFolder: this.config.repositories[repositoryId]!.folder,
        });
      }

      const allChildrenSatisfied = children.every((child) => this.isRollupSatisfied(child.issueId));
      const targetStage = rollupStage(parent.id);
      if (!allChildrenSatisfied && targetStage) {
        const desiredLabels = [
          this.config.labels.enrollment,
          this.config.labels.stageTemplate.replace("{stage}", targetStage),
          ...metadataLabels(parent.labels, this.config)
            .filter((label) => label !== this.config.labels.metadata.closable),
        ].sort((left, right) => left.localeCompare(right));
        const currentLabels = parent.labels
          .filter(
            (label) =>
              label === this.config.labels.enrollment ||
              label.startsWith(`${this.config.labels.enrollment}:`) ||
              label === this.config.labels.metadata.noSplit,
          )
          .sort((left, right) => left.localeCompare(right));
        if (
          desiredLabels.length !== currentLabels.length ||
          desiredLabels.some((label, index) => label !== currentLabels[index])
        ) {
          const transitionDigest = createHash("sha256")
            .update(`${parent.id}\0${parent.sourceUpdatedAt}\0${parent.projectedStage ?? ""}\0${targetStage}`)
            .digest("hex")
            .slice(0, 24);
          let applied: boolean;
          try {
            applied = await applyRollupTransition({
              store: this.store,
              source: this.executionGitHub(repositoryId),
              sourceName: this.config.repositories[repositoryId]!.source,
              address,
              configHash: this.config.hash,
              transitionId: `rollup-${transitionDigest}`,
              issue: parent,
              targetStageId: targetStage,
              labels: this.config.labels,
              reason: `Following the earliest unfinished child stage: ${targetStage}`,
            });
          } catch (error) {
            if (error instanceof RepositoryPausedError) return;
            throw error;
          }
          if (applied) {
            log.info("Roll-up stage transition completed", {
              ...this.itemFields(parent.id),
              sourceStage: parent.projectedStage,
              targetStage,
              reason: `Following the earliest unfinished child stage: ${targetStage}`,
            });
          }
        }
      }
      if (allChildrenSatisfied && doneLabel && await this.completeRollupParentLogged(repositoryId, address, parent, doneLabel)) {
        log.info("Parent roll-up completed", {
          ...this.itemFields(parent.id),
          sourceStage: parent.projectedStage,
          targetStage: "done",
          reason: "All child items are complete",
        });
      }
    }
  }

  private mcpFactory(): ScopedMcpFactory {
    return {
      create: async ({ runId, stageId, context, allowedTools, actor }) => {
        const token = randomBytes(32).toString("base64url");
        this.#mcpGrants.set(token, {
          runId,
          stageId,
          context,
          allowedTools: new Set(allowedTools.map(canonicalToolName)),
          actor,
          calls: new Map(),
        });
        const directory = path.join(this.config.settings.artifacts, runId);
        await mkdir(directory, { recursive: true });
        const contextFile = path.join(directory, "mcp-context.json");
        const port = listenPort(this.config.web.listen);
        await writeFile(contextFile, JSON.stringify({
          version: 1,
          runId,
          stageId,
          repository: {
            id: context.repository.id,
            address: context.repository.address,
            baseBranch: context.repository.baseBranch,
          },
          issue: {
            id: context.issue.id,
            number: context.issue.sourceNumber,
            title: context.issue.title,
            body: context.issue.body,
            labels: context.issue.labels,
            url: context.issue.sourceUrl,
          },
          workspace: context.workspace,
          delivery: context.delivery ?? { pullRequest: null, checks: [] },
          sourceGuidance: context.sourceGuidance,
          control: { url: `http://127.0.0.1:${port}/internal/mcp`, token },
          allowedTools: [...new Set(allowedTools.map(canonicalToolName))],
        }), { mode: 0o600 });
        await chmod(contextFile, 0o600);
        return {
          configuration: mcpServerCommand(contextFile),
          close: async () => {
            this.#mcpGrants.delete(token);
            await rm(contextFile, { force: true });
          },
        };
      },
    };
  }

  private async steeringMcpLease(
    runId: string,
    workspace: string,
    allowedTools: readonly string[],
  ): Promise<ScopedMcpLease> {
    const token = randomBytes(32).toString("base64url");
    this.#mcpGrants.set(token, {
      runId,
      stageId: "steering",
      context: null,
      allowedTools: new Set(allowedTools.map(canonicalToolName)),
      actor: null,
      calls: new Map(),
    });
    const directory = path.join(this.config.settings.artifacts, runId);
    await mkdir(directory, { recursive: true });
    const contextFile = path.join(directory, "mcp-context.json");
    const port = listenPort(this.config.web.listen);
    await writeFile(contextFile, JSON.stringify({
      version: 1,
      runId,
      stageId: "steering",
      repository: {
        id: "conveyor-system",
        address: "conveyor/system",
        baseBranch: "main",
      },
      issue: {
        id: `steering:${runId}`,
        number: 1,
        title: "Interactive Conveyor steering",
        body: "",
        labels: [],
        url: this.config.web.publicUrl ?? `http://127.0.0.1:${port}/`,
      },
      workspace: { path: workspace, branch: "steering" },
      delivery: { pullRequest: null, checks: [] },
      sourceGuidance: "This is a system-scoped steering run. Only explicitly granted Operator diagnostic and control tools are available. Inspect before any control action.",
      control: { url: `http://127.0.0.1:${port}/internal/mcp`, token },
      allowedTools: [...new Set(allowedTools.map(canonicalToolName))],
    }), { mode: 0o600 });
    await chmod(contextFile, 0o600);
    return {
      configuration: mcpServerCommand(contextFile),
      close: async () => {
        this.#mcpGrants.delete(token);
        await rm(contextFile, { force: true });
      },
    };
  }

  private sourceActions(context: RuntimeIssueContext): SourceActionHandler {
    return {
      run: async (action) => {
        this.assertRepositoryActive(context.repository.id);
        const workspace = context.workspace;
        const changeOperation = changeAction(action.sourceAction);
        if (action.sourceAction === "workspace.cleanup") {
          await removeWorkspace({
            store: this.store,
            manager: this.workspaceManager,
            issueId: context.issue.id,
            repositoryFolder: context.repository.folder,
          });
          return;
        }
        if (!workspace) throw new Error(`${action.sourceAction} requires a workspace`);
        if (changeOperation === "ensure") {
          const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
          if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
          const ensured = await pushAndEnsureChange({
            codeHost, store: this.store, address: context.repository.address,
            issue: { id: context.issue.id, sourceNumber: context.issue.sourceNumber, title: context.issue.title },
            workspace, base: context.repository.baseBranch, closes: action.with?.closingReference !== false,
          });
          if (!ensured.pushed) return { outcome: "failure", status: ensured.status, reason: ensured.reason, summary: ensured.reason };
          return;
        }
        if (action.sourceAction === "ci.await" || action.sourceAction === "pullRequest.awaitChecks") {
          return this.awaitPullRequestChecks(context, workspace, action.with);
        }
        if (changeOperation === "merge") {
          const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
          if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
          const pullRequest = await codeHost.ensureChange({
            address: context.repository.address,
            issueNumber: context.issue.sourceNumber,
            branch: workspace.branch,
            base: context.repository.baseBranch,
            title: context.issue.title,
            closes: true,
          });
          const merged = await codeHost.mergeChange({ address: context.repository.address, id: pullRequest.id, method: "squash" });
          if (!merged.merged) throw new Error(`code host did not merge change request #${pullRequest.number}`);
          this.store.upsertPullRequest({
            issueId: context.issue.id,
            id: pullRequest.id,
            number: pullRequest.number,
            url: pullRequest.url,
            state: "merged",
            mergedAt: new Date().toISOString(),
          });
          return;
        }
        throw new Error(`unsupported source action: ${action.sourceAction}`);
      },
    };
  }

  /**
   * Gate a stage on CI for the change request's current head.
   */
  private async awaitPullRequestChecks(
    context: RuntimeIssueContext,
    workspace: { path: string; branch: string },
    input: Record<string, unknown> | undefined,
  ): Promise<SourceActionOutcome> {
    const options = parseCiGateOptions(input);
    const maxCorrections = typeof input?.maxCorrections === "number" ? input.maxCorrections : 5;
    const codeHost = this.executionCodeHost(context.issue.id, this.codeHostFor(context.repository.id));
    if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
    const ensured = await pushAndEnsureChange({
      codeHost, store: this.store, address: context.repository.address,
      issue: { id: context.issue.id, sourceNumber: context.issue.sourceNumber, title: context.issue.title },
      workspace, base: context.repository.baseBranch, closes: input?.closingReference !== false,
    });
    if (!ensured.pushed) return { outcome: "failure", status: ensured.status, reason: ensured.reason, summary: ensured.reason };
    const pullRequest = ensured.change;
    const headSha = (await codeHost.getChange({ address: context.repository.address, id: pullRequest.id })).headSha;
    const outcome = await evaluateCiGate({
      change: { repository: context.repository.address, changeId: String(pullRequest.number), url: pullRequest.url },
      issueKey: context.issue.id,
      options,
      provider: this.executionCiProvider(context.issue.repositoryId, input),
      headSha,
      memory: this.#ciMemory,
      now: Date.now(),
      observe: (observation) => {
        const base = {
          issueId: context.issue.id, headSha, changeUrl: pullRequest.url, ignoreChecks: options.ignoreChecks,
          now: new Date(), authoritative: true,
        };
        if ("runs" in observation) observeCi(this.store, { ...base, runs: observation.runs });
        else observeCiError(this.store, { ...base, error: observation.error });
      },
    });
    if (outcome.outcome === "failure" && outcome.status === "changes-requested") {
      // Stop an implementation<->CI loop that is not converging.
      const transitions = this.store.listStageTransitions(context.issue.id);
      let corrections = 0;
      for (const transition of transitions) {
        if (transition.fromStage !== context.issue.projectedStage) continue;
        if (transition.kind === "advance") corrections = 0;
        else if (transition.kind === "correction") corrections += 1;
      }
      if (corrections >= maxCorrections) {
        return {
          ...outcome,
          status: "blocked",
          reason: `${outcome.reason} CI has now failed ${corrections + 1} times in a row after implementation fixes; a person needs to look.`,
        };
      }
    }
    return outcome;
  }

  /** An MCP tool call: a thin wrapper over the task dispatcher, which enforces the grant and journals mutations. */
  async handleMcp(payload: unknown, token: string, callId?: string): Promise<unknown> {
    const grant = this.#mcpGrants.get(token);
    if (!grant) throw new Error("expired MCP grant");
    if (callId) {
      const prior = grant.calls.get(callId);
      if (prior) return prior;
      const call = withEventContext({ actor: { kind: "agent", id: grant.runId } }, () => withGitHubCallSource("agent", () => this.handleMcpRequest(payload, grant)));
      grant.calls.set(callId, call);
      return call;
    }
    return withEventContext({ actor: { kind: "agent", id: grant.runId } }, () => withGitHubCallSource("agent", () => this.handleMcpRequest(payload, grant)));
  }

  private async handleMcpRequest(payload: unknown, grant: McpGrant): Promise<unknown> {
    const context = grant.context;
    const scheduled = this.#scheduledOperatorChecks.has(grant.runId);
    let tool = "unknown";
    try {
      const request = object(payload);
      tool = string(request.tool, "tool");
      // The MCP server adds its run scope to every input; the grant is authoritative, so drop it.
      const { runId: _run, stageId: _stage, repositoryId: _repository, issueId: _issue, ...input } = object(request.input ?? {});
      const taskDeps = (): TaskDeps => context
        // A system-scoped (steering) grant has no item: only explicitly allowed steering-safe tools are available.
        ? this.taskDeps(context.issue.id, context.repository)
        : ({
            store: this.store,
            config: this.config,
            issueId: "",
            operator: {
              scheduled,
              board: () => this.operatorBoard(),
              findItem: (reference) => this.operatorFindItem(reference),
              itemHistory: async (input) => {
                const matches = this.operatorItemsForReference(input.itemId);
                if (matches.length === 0) {
                  if (scheduled) throw new Error("scheduled checks may inspect history only for their stopped targets");
                  throw new Error("item is not on this configured board");
                }
                if (matches.length > 1) throw new Error("item reference matches multiple configured board items; use a repository-qualified reference");
                const issue = matches[0]!;
                if (scheduled && !this.#scheduledOperatorChecks.get(grant.runId)?.targets.has(issue.id)) {
                  throw new Error("scheduled checks may inspect history only for their stopped targets");
                }
                const history = await this.operatorItemHistory({ ...input, itemId: issue.id });
                if (scheduled) this.#scheduledOperatorChecks.get(grant.runId)?.inspected.add(issue.id);
                return history;
              },
              retry: (itemId, note) => this.retryIssue(itemId, note, "AI Operator"),
              scheduledRetry: (itemId, note, evidence) => this.scheduledRetryIssue(grant.runId, itemId, note, evidence),
              answerQuestion: (questionId, answer, evidence) => this.scheduledAnswerQuestion(grant.runId, questionId, answer, evidence),
              scheduledOutcome: (itemId, reason) => this.reportScheduledOutcome(grant.runId, itemId, reason),
              moveBacklog: (input) => this.operatorMoveBacklog(input),
            },
          } as TaskDeps);
      const result = await dispatchTool({
        name: tool,
        input,
        actor: grant.actor,
        grant: {
          runId: grant.runId,
          stageId: grant.stageId,
          issueScoped: context !== null,
          actor: grant.actor,
          tasks: grant.allowedTools,
        },
      }, {
        registry: createTaskRegistry(),
        deps: taskDeps,
        liveHeadSha: async () => {
          if (!context) return null;
          const state = await this.loadDeliveryState(context.issue.id, context.repository.address) as {
            change?: { headSha?: string } | null;
            pullRequest?: { headSha?: string } | null;
          };
          return state.change?.headSha ?? state.pullRequest?.headSha ?? null;
        },
        store: this.store,
      });
      if (context && canonicalToolName(tool) === "agent.askQuestion") {
        await this.updateStatusComment(context.issue.id);
      }
      return result;
    } catch (error) {
      if (context) log.warn("Issue MCP tool failed", { ...this.itemFields(context.issue.id), tool: canonicalToolName(tool) }, error);
      throw error;
    }
  }

  /** A redacted board view for the scoped Operator MCP tools; it intentionally has no credentials or raw config. */
  private operatorBoard(): unknown {
    const activeIssueIds = new Set(this.store.listActiveIssueRuns().map((run) => run.issueId));
    const items = this.operatorVisibleItems().map((issue) => {
      const cursor = this.store.executions().getCursor(issue.id);
      const manualGates = this.manualGateViews(issue);
      const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
      const active = activeIssueIds.has(issue.id);
      const stopped = STOPPED_ISSUE_STATES.has(issue.projectedState ?? "");
      const parent = issue.parentId ? this.store.getIssue(issue.parentId) : null;
      return {
        ...this.operatorReference(issue),
        stage: this.store.getStageState(issue.id)?.stageId ?? issue.projectedStage,
        state: issue.projectedState ?? issue.sourceState,
        activity: active ? "active" : cursor?.state === "pending" ? "waiting" : "idle",
        queue: issue.queueRank === null ? { status: "not-queued" } : { status: "queued", rank: issue.queueRank },
        waitingOrStopReason: cursor?.state === "pending"
          ? this.store.executions().pendingMessage(issue.id) ?? issue.warning
          : stopped ? latestStopReason(this.store, issue.id) ?? issue.warning : null,
        parent: this.operatorVisibleItem(parent) ? this.operatorReference(parent) : null,
        dependencies: this.store.listDependencies(issue.id)
          .map((id) => this.store.getIssue(id))
          .filter((dependency): dependency is StoredIssue => this.operatorVisibleItem(dependency))
          .map((dependency) => this.operatorReference(dependency)),
      };
    });
    return {
      reconciledAt: this.#lastReconciledAt,
      repositories: Object.entries(this.config.repositories).map(([id, repository]) => ({
        id,
        address: repository.address,
        health: this.#repositoryErrors.has(id) || this.#onboardingErrors.has(id) ? "degraded" : "healthy",
        lastReconciledAt: this.#lastReconciledAt,
      })),
      items,
    };
  }

  private operatorVisibleItem(issue: StoredIssue | null): issue is StoredIssue {
    return Boolean(issue && this.config.repositories[issue.repositoryId] && issue.projectedState !== "offboarded");
  }

  private operatorVisibleItems(): StoredIssue[] {
    return this.store.listIssues().filter((issue) => this.operatorVisibleItem(issue));
  }

  private operatorReference(issue: StoredIssue): { id: string; repositoryId: string; number: number; url: string; title: string } {
    return {
      id: issue.id,
      repositoryId: issue.repositoryId,
      number: issue.sourceNumber,
      url: issue.sourceUrl,
      title: issue.title,
    };
  }

  /** Resolves the forms people use without consulting a source outside the configured board. */
  private operatorItemsForReference(input: string): StoredIssue[] {
    const reference = input.trim().toLowerCase();
    const visible = this.operatorVisibleItems();
    const direct = visible.filter((issue) => issue.id.toLowerCase() === reference);
    if (direct.length > 0) return direct;
    const bare = /^#?(\d+)$/.exec(reference);
    if (bare) return visible.filter((issue) => issue.sourceNumber === Number(bare[1]));
    const qualified = /^(.+?)(?:#\s*|:\s*|\s+)(\d+)$/.exec(reference);
    if (!qualified) {
      const matching = Object.entries(this.config.repositories).flatMap(([id, repository]) =>
        [id, repository.address, repository.address.split("/").at(-1)!]
          .map((alias) => alias.toLowerCase())
          .filter((alias) => reference.startsWith(alias) && /^\d+$/.test(reference.slice(alias.length)))
          .map((alias) => ({ id, number: Number(reference.slice(alias.length)) })),
      );
      return visible.filter((issue) => matching.some((candidate) =>
        issue.repositoryId === candidate.id && issue.sourceNumber === candidate.number,
      ));
    }
    const [, repositoryReference, number] = qualified;
    if (!repositoryReference || !number) return [];
    const repositories = Object.entries(this.config.repositories)
      .filter(([id, repository]) => {
        const address = repository.address.toLowerCase();
        return [id.toLowerCase(), address, address.split("/").at(-1)!].includes(repositoryReference.trim());
      })
      .map(([id]) => id);
    return visible.filter((issue) => repositories.includes(issue.repositoryId) && issue.sourceNumber === Number(number));
  }

  private operatorFindItem(reference: string): unknown {
    const items = this.operatorItemsForReference(reference).map((issue) => this.operatorReference(issue));
    return items.length > 0
      ? { reference, status: "found", items }
      : { reference, status: "not-on-board", message: "This reference is not on this configured board.", items: [] };
  }

  /** History is deliberately bounded by transition, run, and event limits and rejects non-board references uniformly. */
  private async operatorItemHistory(input: {
    itemId: string;
    beforeRunId?: string;
    eventRunId?: string;
    beforeEventSequence?: number;
    runLimit: number;
    eventLimit: number;
  }): Promise<unknown> {
    const issue = this.store.getIssue(input.itemId);
    if (!this.operatorVisibleItem(issue)) {
      throw new Error("item is not on this configured board");
    }
    const runs = this.store.listIssueRunsPage(issue.id, {
      ...(input.beforeRunId ? { before: input.beforeRunId } : {}),
      limit: input.runLimit,
    });
    const eventRun = input.eventRunId ? this.store.getRun(input.eventRunId) : null;
    if (input.eventRunId && (!eventRun || eventRun.issueId !== issue.id)) {
      throw new Error("event cursor does not belong to this board item");
    }
    let delivery: unknown;
    try {
      const repository = this.config.repositories[issue.repositoryId]!;
      delivery = { status: "available", ...await this.loadDeliveryState(issue.id, repository.address) };
    } catch (error) {
      delivery = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "delivery diagnostics are unavailable",
      };
    }
    return {
      item: { id: issue.id, repositoryId: issue.repositoryId, number: issue.sourceNumber, url: issue.sourceUrl, title: issue.title },
      transitions: this.store.listStageTransitions(issue.id).slice(-50).map((transition) => ({
        id: transition.id,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
        kind: transition.kind,
        status: transition.status,
        resultStatus: transition.resultStatus,
        reason: transition.error ?? transition.reason,
        createdAt: transition.createdAt,
        completedAt: transition.completedAt,
      })),
      runs: runs.runs.map((run) => {
        const page = this.store.listRunEventsPage(run.id, {
          limit: input.eventLimit,
          ...(run.id === input.eventRunId && input.beforeEventSequence !== undefined
            ? { before: input.beforeEventSequence }
            : {}),
        });
        return {
          id: run.id,
          stageId: run.stageId,
          attempt: run.attempt,
          kind: run.kind,
          status: run.status,
          result: run.result,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          events: page.events,
          nextEventBefore: page.nextBefore,
        };
      }),
      nextRunBefore: runs.nextBefore,
      delivery,
    };
  }

  private operatorMoveBacklog(input: { itemId: string; position: "up" | "down" | "before" | "end"; beforeItemId?: string }): unknown {
    if (input.position === "up" || input.position === "down") {
      this.reorderBacklog(input.itemId, input.position);
    } else {
      this.moveBacklogIssue(input.itemId, input.position === "before" ? input.beforeItemId! : null);
    }
    const issue = this.store.getIssue(input.itemId);
    return {
      position: input.position,
      queueRank: issue?.queueRank ?? null,
      ...(input.position === "before" ? { beforeIssueId: input.beforeItemId } : {}),
    };
  }

  /** A GitHub items provider's webhook secret: its `webhookSecret`, else CONVEYOR_GITHUB_WEBHOOK_SECRET. */
  private webhookSecretFor(sourceName: string): string {
    const source = this.config.sources[sourceName];
    return (source?.type === "github" ? source.webhookSecret : undefined) ?? process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET ?? "";
  }

  async handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<void> {
    // Providers may use different secrets on one webhook path: find the one that signed this delivery.
    const candidates = [...new Set(Object.keys(this.config.sources).map((name) => this.webhookSecretFor(name)).filter(Boolean))];
    const signature = headers.get("x-hub-signature-256");
    const secret = candidates.find((candidate) => verifyGitHubSignature(rawBody, signature, candidate));
    if (!secret) {
      throw new Error("invalid GitHub webhook signature");
    }
    const deliveryId = headers.get("x-github-delivery");
    const eventType = headers.get("x-github-event");
    if (!deliveryId || !eventType) throw new Error("missing GitHub webhook headers");
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    const repositoryAddress = object(object(payload).repository).full_name;
    const repository = typeof repositoryAddress === "string"
      ? Object.entries(this.config.repositories).find(([, candidate]) => candidate.address.toLowerCase() === repositoryAddress.toLowerCase())
      : undefined;
    // A delivery counts only for a repository whose own provider's secret signed it.
    if (repository && this.webhookSecretFor(repository[1].source) !== secret) throw new Error("invalid GitHub webhook signature for this repository");
    // Conveyor's own status-comment writes come back as deliveries; they carry nothing to read, and
    // reconciling on them made every write trigger more writes.
    if (eventType === "issue_comment" && isStatusComment(fields(fields(payload).comment).body)) return;
    // The delivery and what it means are recorded together; subscribers react once it committed.
    const normalized = repository ? normalizeGitHubEvent(eventType, payload) : null;
    const recorded = withEventContext({ actor: { kind: "webhook", id: deliveryId } }, () =>
      this.store.recordSourceEvent({ source: "github", deliveryId, eventType, payload, repositoryId: repository?.[0] ?? null, normalized }));
    if (!recorded) return;
    // Before anything reacts to it: the copy now says what the delivery says.
    if (repository) this.github.applyDelivery?.(eventType, payload);
    if (typeof repositoryAddress !== "string") return;
    if (!repository) this.schedule();
  }

  /**
   * The projection's reaction to a GitHub event: the CI indicator first, so the board shows a
   * finished run within seconds, then a reconcile of the issues the event names. It runs in the
   * background: GitHub counts a delivery as failed after ten seconds, and the event bus must not
   * wait for GitHub either.
   */
  private reactToGitHubEvent(event: StoredEvent): void {
    const repositoryId = event.repositoryId;
    if (!repositoryId || !this.config.repositories[repositoryId]) return;
    const work = withEventContext({ actor: { kind: "webhook", id: event.actor.id } }, () => withGitHubCallSource("webhook", async () => {
      await this.applyCiEvent(repositoryId, event)
        .catch((error) => log.warn("CI indicator webhook update failed", { repository: repositoryId, event: event.type }, error));
      if (isEventOf(event, "github.issueUpdated")) {
        // A comment on a pull request changes nothing on the item's issue.
        if (event.payload.pullRequest) {
          const named = new Set(this.issueNumbersFor(repositoryId, event));
          this.refreshStatusComments(this.store.listIssues(repositoryId).filter((issue) => named.has(issue.sourceNumber)).map((issue) => issue.id));
          return;
        }
        if (await this.applyIssueDelivery(repositoryId, event.actor.id)) return;
      }
      if (isEventOf(event, "github.changeUpdated") && event.payload.action === "closed" && event.payload.merged) {
        const named = new Set(this.issueNumbersFor(repositoryId, event));
        for (const issue of this.store.listIssues(repositoryId).filter((candidate) => named.has(candidate.sourceNumber))) {
          await this.recoverClosedItem(repositoryId, issue);
        }
        this.refreshStatusComments(this.store.listIssues(repositoryId).filter((issue) => named.has(issue.sourceNumber)).map((issue) => issue.id));
        return;
      }
      const issueNumbers = this.issueNumbersFor(repositoryId, event);
      if (issueNumbers.length === 0) return;
      // CI and pull request events change no issue data: the indicator is updated above, a waiting
      // task reads the change itself, and the status comments of the items involved are refreshed.
      if (isEventOf(event, "github.ciUpdated") || isEventOf(event, "github.changeUpdated")) {
        // CI progress changes nothing the comment shows.
        if (isEventOf(event, "github.ciUpdated") && !event.payload.completed) return;
        const named = new Set(issueNumbers);
        this.refreshStatusComments(this.store.listIssues(repositoryId).filter((issue) => named.has(issue.sourceNumber)).map((issue) => issue.id));
        return;
      }
      if (isEventOf(event, "github.relationshipChanged")) this.forgetRelationships(repositoryId, event.payload.numbers);
      await this.queueWebhookReconcile(repositoryId, issueNumbers);
    }));
    this.#webhookWork.add(work);
    void work.finally(() => this.#webhookWork.delete(work));
  }

  /**
   * Applies the issue an `issues` or `issue_comment` delivery carries, with no GitHub request: the
   * delivery holds the issue's current state and names who made the change. False when the delivery
   * cannot stand in for a read (a transfer, an unknown action), so the caller reads the issue instead.
   */
  private async applyIssueDelivery(repositoryId: string, deliveryId: string | null): Promise<boolean> {
    const repository = this.config.repositories[repositoryId];
    const stored = deliveryId ? this.store.sourceEvent("github", deliveryId) : null;
    if (!repository || !stored) return false;
    const change = deliveredIssueChange(repository.address, stored.eventType, stored.payload, this.config.labels.enrollment);
    if (!change) return false;
    const number = change.issue.number;
    const prior = this.store.listIssues(repositoryId).find((issue) => issue.sourceNumber === number);
    const followUpBodies = this.followUpBodies(repositoryId);
    // Deliveries can arrive out of order: an older state of the issue changes nothing.
    if (prior && Date.parse(prior.sourceUpdatedAt) > Date.parse(change.issue.updatedAt)) return true;
    const pipeline = this.config.pipelines[repository.pipeline]!;
    await reconcileRepository({
      store: this.store,
      configHash: this.config.hash,
      repository: { id: repositoryId, configName: repositoryId, source: repository.source, address: repository.address, folder: repository.folder },
      stages: pipeline.stages.map((stage) => stage.id),
      labels: this.config.labels,
      source: this.executionGitHub(repositoryId),
      trust: this.#issueTrust,
      extraTrustedLogins: repository.extraTrustedLogins ?? [],
      expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
      issues: [change.issue],
      delivered: new Map([[number, change.actors]]),
    });
    const applied = this.store.listIssues(repositoryId).find((issue) => issue.sourceNumber === number);
    if (change.issue.state === "closed" && applied) await this.recoverClosedItem(repositoryId, applied, change.issue);
    if (this.store.repositoryPause(repositoryId)) return true;
    this.wakeClearedFollowUps(repositoryId, followUpBodies);
    this.restorePendingStatus(repositoryId);
    this.interruptIneligibleRuns();
    this.store.events().append("repository.reconciled", { issueNumbers: [number] }, { repositoryId });
    this.schedule();
    if (applied) this.refreshStatusComments([applied.id]);
    return true;
  }

  /** Resolves once every accepted webhook delivery has been processed. */
  async webhooksSettled(): Promise<void> {
    // A delivery's work starts from its event, and that work records events of its own.
    for (;;) {
      await this.eventsSettled();
      if (this.#webhookWork.size === 0) return;
      await Promise.all([...this.#webhookWork]);
    }
  }

  /** The issue numbers whose status a GitHub event may change; a pull request names its item's issue. */
  private issueNumbersFor(repositoryId: string, event: StoredEvent): number[] {
    const forPullRequests = (numbers: readonly number[]) => {
      const wanted = new Set(numbers);
      return this.store.listIssues(repositoryId).flatMap((issue) => {
        const pullRequest = this.store.getCurrentPullRequest(issue.id);
        return pullRequest && wanted.has(pullRequest.number) ? [issue.sourceNumber] : [];
      });
    };
    if (isEventOf(event, "github.issueUpdated")) return event.payload.pullRequest ? forPullRequests([event.payload.number]) : [event.payload.number];
    if (isEventOf(event, "github.relationshipChanged")) return event.payload.numbers;
    if (isEventOf(event, "github.changeUpdated")) return forPullRequests([event.payload.number]);
    if (isEventOf(event, "github.ciUpdated")) return forPullRequests(event.payload.pullRequests);
    return [];
  }

  /**
   * Reconciles a repository for webhook deliveries, one pass at a time. Deliveries arriving while a
   * pass waits to start join it, so a burst of deliveries costs one or two passes rather than one each.
   * Only the status comments of the issues the deliveries name are refreshed.
   */
  private queueWebhookReconcile(repositoryId: string, issueNumbers: number[] | null): Promise<void> {
    const queued = this.#queuedWebhookReconciles.get(repositoryId);
    if (queued) {
      if (issueNumbers === null) queued.issueNumbers = null;
      else for (const issueNumber of issueNumbers) queued.issueNumbers?.add(issueNumber);
      return queued.done;
    }
    const entry: { issueNumbers: Set<number> | null; done: Promise<void> } = {
      issueNumbers: issueNumbers === null ? null : new Set(issueNumbers),
      done: Promise.resolve(),
    };
    this.#queuedWebhookReconciles.set(repositoryId, entry);
    const previous = this.#webhookReconciles.get(repositoryId) ?? Promise.resolve();
    entry.done = previous.then(async () => {
      // Deliveries from here on queue the next pass: this one may already have read past them.
      this.#queuedWebhookReconciles.delete(repositoryId);
      if (this.#shuttingDown) return;
      await this.reconcileRepository(repositoryId, {
        partial: true,
        ...(entry.issueNumbers === null ? {} : { includeIssueNumbers: [...entry.issueNumbers] }),
      });
      this.schedule();
      const issues = this.store.listIssues(repositoryId);
      this.refreshStatusComments((entry.issueNumbers === null
        ? issues
        : issues.filter((issue) => entry.issueNumbers!.has(issue.sourceNumber))).map((issue) => issue.id));
    }).catch((error) => log.error("Repository reconciliation failed", { repository: repositoryId }, error));
    this.#webhookReconciles.set(repositoryId, entry.done);
    void entry.done.then(() => {
      if (this.#webhookReconciles.get(repositoryId) === entry.done) this.#webhookReconciles.delete(repositoryId);
    });
    return entry.done;
  }

  /**
   * Updates the stored CI indicator from a CI event or a pull request that opened or got a new head.
   * Only the change's current head counts: an event for another head is dropped unless the code
   * host confirms it is the head now (then it replaces the old head's indicator).
   */
  private async applyCiEvent(repositoryId: string, event: StoredEvent): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    let head: string;
    let numbers: readonly number[];
    let newHead: boolean;
    if (isEventOf(event, "github.ciUpdated")) {
      // Progress (requested, in progress) changes nothing a reader of the indicator acts on;
      // ci.start already shows the head's CI as starting. Only a finished run is read.
      if (!event.payload.completed) return;
      head = event.payload.sha;
      numbers = event.payload.pullRequests;
      newHead = false;
    } else if (isEventOf(event, "github.changeUpdated") && ["opened", "reopened", "synchronize"].includes(event.payload.action) && event.payload.headSha) {
      head = event.payload.headSha;
      numbers = [event.payload.number];
      newHead = true;
    } else return;
    const issueIds = new Set([
      ...numbers.flatMap((number) => this.store.findIssueIdsByPullRequest(repositoryId, number)),
      ...this.store.findIssueIdsByIndicatorHead(repositoryId, CI_INDICATOR_ID, head),
    ]);
    for (const issueId of issueIds) {
      const stored = this.store.getCurrentPullRequest(issueId);
      if (!stored || stored.state === "merged" || stored.mergedAt) continue;
      const indicator = this.store.listIndicators(issueId).find((entry) => entry.id === CI_INDICATOR_ID);
      const known = indicator?.headSha === head;
      // A completion can arrive after the change advanced but before its synchronize
      // delivery. Do not let a cached indicator make that old head look current.
      const liveHead = await this.currentChangeHead(repositoryId, stored.id);
      if (liveHead !== head) continue;
      this.setLiveChangeHead(issueId, liveHead);
      if (repository.ci?.mode === "disabled" || (newHead && known)) continue;
      const change = { repository: repository.address, changeId: String(stored.number), url: stored.url };
      const input = { issueId, headSha: head, changeUrl: stored.url, ignoreChecks: repository.ci?.ignoreChecks ?? [], now: new Date(), authoritative: !known };
      if (newHead) { startCiForHead(this.store, input); continue; }
      let runs: CiRun[];
      try { runs = await this.ciProvider(repositoryId).list(change, head); }
      catch (error) { observeCiError(this.store, { ...input, error }); continue; }
      observeCi(this.store, { ...input, runs });
    }
  }

  private async currentChangeHead(repositoryId: string, changeId: string): Promise<string | null> {
    const codeHost = this.codeHostFor(repositoryId);
    const address = this.config.repositories[repositoryId]?.address;
    if (!codeHost || !address) return null;
    try { return (await codeHost.getChange({ address, id: changeId })).headSha; }
    catch { return null; }
  }

  /** Records a changed source head after the dashboard can read it from the in-memory projection. */
  private setLiveChangeHead(issueId: string, headSha: string): void {
    if (this.#liveChangeHeads.get(issueId) === headSha) return;
    this.#liveChangeHeads.set(issueId, headSha);
    this.store.events().append("change.headObserved", { headSha }, { issueId });
  }

  /** Existing open changes acquire a current-head CI indicator after a reconcile or restart. */
  /** `scope` limits a webhook pass to the issues it names; null covers every open item. */
  private async backfillCiIndicators(repositoryId: string, scope: ReadonlySet<number> | null = null): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const ciDisabled = repository.ci?.mode === "disabled";
    const stored = ciDisabled
      ? new Map<string, ReturnType<ConveyorStore["listIndicators"]>[number]>()
      : new Map(this.store.listIndicators().filter((entry) => entry.id === CI_INDICATOR_ID).map((entry) => [entry.issueId, entry]));
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.sourceState !== "open") continue;
      if (scope !== null && !scope.has(issue.sourceNumber)) continue;
      const pullRequest = this.store.getCurrentPullRequest(issue.id);
      if (!pullRequest || pullRequest.state !== "open" || pullRequest.mergedAt) continue;
      try {
        const head = await this.currentChangeHead(repositoryId, pullRequest.id);
        if (!head) continue;
        this.setLiveChangeHead(issue.id, head);
        if (ciDisabled) continue;
        const current = stored.get(issue.id);
        // A stored indicator is kept only while it is for the current head and no longer "starting".
        if (current?.headSha === head && current.progress !== "starting") continue;
        const change = { repository: repository.address, changeId: String(pullRequest.number), url: pullRequest.url };
        observeCi(this.store, {
          issueId: issue.id, headSha: head, changeUrl: pullRequest.url, ignoreChecks: repository.ci?.ignoreChecks ?? [],
          now: new Date(), authoritative: true, runs: await this.ciProvider(repositoryId).list(change, head),
        });
      } catch (error) {
        log.warn("CI indicator backfill failed", this.itemFields(issue.id), error);
      }
    }
  }

  /**
   * Wakes an item whose cursor is parked on `agent.run` in the stage of the run that asked the
   * question. Any other parked task, and every legacy stage, keeps the restart behaviour.
   */
  private wakeParkedAgent(question: { issueId: string; runId: string | null }): boolean {
    const journal = this.store.executions();
    const cursor = journal.getCursor(question.issueId);
    const run = question.runId ? this.store.getRun(question.runId) : null;
    const issue = this.store.getIssue(question.issueId);
    if (!cursor || run?.stageId !== cursor.stage || !issue || !this.hasResumableQuestionExecution(question.issueId)) return false;
    return this.wakeParked(question.issueId);
  }

  async answerQuestion(questionId: string, answer: string, source = "web", evidence?: string): Promise<void> {
    const question = this.store.getQuestion(questionId);
    if (!question) throw new Error("question not found");
    const issue = this.store.getIssue(question.issueId);
    if (issue?.projectedState === "offboarded") {
      throw new Error("This question belongs to an offboarded item.");
    }
    if (issue) this.assertRepositoryActive(issue.repositoryId);
    const response = validatedQuestionAnswer(question, answer);
    if (question.status !== "open") throw new Error("This question has already been answered.");
    if (question.answer !== null) {
      const prior = typeof question.answer === "object" && question.answer !== null
        ? (question.answer as { answer?: unknown }).answer
        : question.answer;
      if (prior !== response) throw new Error("This question already has a pending answer; retry the same answer.");
      if (source.startsWith("scheduled-operator:") && !question.answerSource?.startsWith("scheduled-operator:")) {
        throw new Error("This question already has a pending owner answer.");
      }
      if (!source.startsWith("scheduled-operator:") && question.answerSource?.startsWith("scheduled-operator:")) {
        throw new Error("This question has a scheduled answer pending its source mirror.");
      }
    }
    const scheduled = source.startsWith("scheduled-operator:");
    if (scheduled) {
      // The source mutation must succeed before this becomes an accepted, resume-worthy answer.
      // Keep the response and its evidence durable so reconciliation can finish that mutation later.
      this.store.recordQuestionAnswer(questionId, source, { answer: response, evidence: evidence ?? null });
    } else {
      const runStage = question.runId ? this.store.getRun(question.runId)?.stageId : null;
      this.store.recordQuestionAnswerWithConversation({
        questionId,
        source,
        answer: { answer: response },
        stageId: runStage ?? issue?.projectedStage ?? null,
        message: `**Question:** ${question.prompt}\n\n**Accepted answer:** ${response}`,
      });
    }
    if (!issue) return;
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    if (scheduled) {
      await this.#completeScheduledAnswer(question, issue, repository, response);
      return;
    }
    await this.#finalizeQuestionAnswer(question, issue, repository);
    this.#trackAnswerFollowUp(this.#answerFollowUp(
      issue.id, question.id, response, repository.address, issue.sourceNumber, repository.source,
    ).then(() => undefined));
  }

  async #finalizeQuestionAnswer(
    question: StoredQuestion,
    issue: StoredIssue,
    repository: ConveyorConfig["repositories"][string],
  ): Promise<void> {
    this.assertRepositoryActive(issue.repositoryId);
    const github = this.executionGitHub(issue.repositoryId);
    // Before replying, only what resuming needs: the source's needs-input label goes first (a sync
    // that still saw it would stop the item again), then the parked agent wakes. Mirroring the answer
    // as a comment, re-syncing the repository and the status comment follow in the background.
    const needsInput = this.config.labels.states["needs-input"];
    const hadNeedsInput = Boolean(needsInput && issue.labels.includes(needsInput));
    if (hadNeedsInput) {
      const runStage = question.runId ? this.store.getRun(question.runId)?.stageId : null;
      const stage = runStage ?? issue.projectedStage;
      const metadata = metadataLabels(issue.labels, this.config);
      try {
        await github.replaceConveyorLabels(repository.address, issue.sourceNumber, [
          this.config.labels.enrollment,
          ...(stage ? [this.config.labels.stageTemplate.replace("{stage}", stage)] : []),
          ...metadata,
        ], [this.config.labels.metadata.noSplit]);
      } catch (error) {
        if (error instanceof RepositoryPausedError) throw error;
        throw new Error("Your answer was saved but the question state could not be cleared. Submit the same answer to retry.");
      }
    }
    this.store.completeQuestionAnswer(question.id);
    // A stage parked on an agent's question continues where it stopped; legacy stages restart.
    const parkedAgentWoken = this.wakeParkedAgent(question);
    const runStage = question.runId ? this.store.getRun(question.runId)?.stageId : null;
    const resumedStage = runStage ?? issue.projectedStage;
    if (resumedStage) {
      // A native agent can park without first writing needs-input to the source. Clear its local
      // projection before scheduling; with the step parked this keeps it (see setIssueProjection).
      this.store.setIssueProjection(issue.id, { stage: resumedStage, state: "active", warning: null });
    }
    if (!parkedAgentWoken && issue.projectedStage) {
      const metadata = metadataLabels(issue.labels, this.config);
      await github.replaceConveyorLabels(repository.address, issue.sourceNumber, [
        this.config.labels.enrollment,
        this.config.labels.stageTemplate.replace("{stage}", issue.projectedStage),
        ...metadata,
      ], [this.config.labels.metadata.noSplit]);
    }
    this.schedule();
  }

  readonly #scheduledAnswerCompletions = new Map<string, Promise<void>>();

  async #completeScheduledAnswer(
    question: StoredQuestion,
    issue: StoredIssue,
    repository: ConveyorConfig["repositories"][string],
    response: string,
  ): Promise<void> {
    const existing = this.#scheduledAnswerCompletions.get(question.id);
    if (existing) return existing;
    const completion = (async () => {
      const mirrored = await this.#answerFollowUp(
        issue.id, question.id, response, repository.address, issue.sourceNumber, repository.source, true,
      );
      if (!mirrored) {
        throw new Error("Scheduled answer is pending source mirror; it will retry after reconciliation.");
      }
      const current = this.store.getQuestion(question.id);
      if (!current || current.status !== "open") return;
      const evidence = questionAnswerEvidence(current.answer);
      this.store.recordQuestionAnswerWithConversation({
        questionId: current.id,
        source: current.answerSource ?? "scheduled-operator:recovery",
        answer: current.answer,
        stageId: current.runId ? this.store.getRun(current.runId)?.stageId ?? issue.projectedStage : issue.projectedStage,
        message: `**Scheduled Operator question answer:** ${current.prompt}\n\n**Accepted answer:** ${response}\n\n**Evidence:** ${evidence ?? "recorded by scheduled Operator"}`,
        actor: { type: "conveyor", id: current.answerSource ?? "scheduled-operator:recovery", name: "Scheduled Operator", title: "Conveyor Operator" },
      });
      await this.#finalizeQuestionAnswer(current, issue, repository);
    })().finally(() => this.#scheduledAnswerCompletions.delete(question.id));
    this.#scheduledAnswerCompletions.set(question.id, completion);
    return completion;
  }

  #recoverPendingScheduledAnswers(): void {
    for (const question of this.store.listOpenQuestions()) {
      if (!question.answerSource?.startsWith("scheduled-operator:")) continue;
      const response = questionAnswerText(question.answer);
      const issue = this.store.getIssue(question.issueId);
      const repository = issue && this.config.repositories[issue.repositoryId];
      if (!response || !issue || !repository || issue.projectedState === "offboarded") continue;
      this.#trackAnswerFollowUp(this.#completeScheduledAnswer(question, issue, repository, response));
    }
  }

  /** Background work after an answer: settled before the service closes, and awaitable in tests. */
  readonly #answerFollowUps = new Set<Promise<void>>();

  #trackAnswerFollowUp(work: Promise<void>): void {
    const tracked = work.catch((error: unknown) => log.warn("Answer follow-up failed", {}, error)).finally(() => this.#answerFollowUps.delete(tracked));
    this.#answerFollowUps.add(tracked);
  }

  /** Resolves once every answer's background work (comment, re-sync, status) has finished. */
  async answerFollowUpsSettled(): Promise<void> {
    while (this.#answerFollowUps.size > 0) await Promise.all([...this.#answerFollowUps]);
    await this.eventsSettled();
  }

  async #answerFollowUp(issueId: string, questionId: string, response: string, address: string, sourceNumber: number, source: string, scheduled = false): Promise<boolean> {
    const issue = this.store.getIssue(issueId);
    if (!issue || this.store.repositoryPause(issue.repositoryId)) return false;
    const github = this.executionGitHub(issue.repositoryId);
    // The answer is mirrored as an issue comment once, retried a few times when the source is unavailable.
    const mirrorKey = `question-answer:${questionId}`;
    if (!this.#answerMirrorsInFlight.has(mirrorKey)) {
      this.#answerMirrorsInFlight.add(mirrorKey);
      try {
        for (const [attempt, delayMs] of [0, 2_000, 10_000].entries()) {
          if (delayMs > 0) await Bun.sleep(this.answerRetryDelayMs ?? delayMs);
          if (this.#shuttingDown && attempt > 0) break;
          const mirror = this.store.beginSourceMutation({
            idempotencyKey: mirrorKey,
            source,
            operation: "issue.comment.answer",
            request: { issueId, questionId, answer: response, actor: scheduled ? "scheduled-operator" : "owner" },
          });
          if (mirror.status === "succeeded") break;
          try {
            const marker = `<!-- conveyor:answer:${questionId} -->`;
            const sourceHasAnswer = typeof github.hasCommentWithMarker === "function" &&
              await github.hasCommentWithMarker(address, sourceNumber, marker);
            if (!sourceHasAnswer) await github.addComment(address, sourceNumber, `${marker}\n**${scheduled ? "Scheduled Operator answer" : "Conveyor answer"}:** ${response}`);
            this.store.completeSourceMutation(mirror.id, { questionId });
            break;
          } catch (error) {
            if (error instanceof RepositoryPausedError) return false;
            this.store.failSourceMutation(mirror.id, error instanceof Error ? error.message : String(error));
            log.warn("Could not mirror an answer to the source; retrying", { ...this.itemFields(issueId), attempt: attempt + 1 }, error);
          }
        }
      } finally {
        this.#answerMirrorsInFlight.delete(mirrorKey);
      }
    }
    const mirrored = this.store.getSourceMutationByKey(mirrorKey)?.status === "succeeded";
    try {
      // Reconciliation is needed after every answer, not only when the stale source snapshot happened
      // to include the needs-input label.
      const answered = this.store.getIssue(issueId);
      if (answered) await this.reconcileRepository(answered.repositoryId, { only: [answered.sourceNumber] });
    } catch (error) {
      log.warn("Question answer reconciliation failed; the parked run remains resumable", this.itemFields(issueId), error);
    }
    await this.updateStatusComment(issueId);
    this.schedule();
    this.store.events().append("item.requeued", { reason: "answer" }, { issueId });
    return mirrored;
  }

  /** Tests shorten the pauses between answer-mirror retries. */
  answerRetryDelayMs: number | null = null;

  /**
   * Starts one cadence-triggered Operator run when the reconciled board contains stopped enrolled
   * work. This deliberately does not queue missed intervals: a live steering run is the lock.
   */
  async runScheduledOperatorCheck(): Promise<string | null> {
    const steering = this.config.web?.steering;
    if (!steering?.periodic || !this.#lastReconciledAt || this.#repositoryErrors.size > 0 ||
      this.#shuttingDown || this.#drain || this.#steeringActive.size > 0) return null;
    const targets = this.store.listIssues().filter((issue) =>
      Boolean(this.config.repositories[issue.repositoryId]) &&
      this.store.repositoryPause(issue.repositoryId) === null &&
      issue.labels.includes(this.config.labels.enrollment) &&
      issue.projectedState !== "offboarded" &&
      issue.projectedState !== null && STOPPED_ISSUE_STATES.has(issue.projectedState),
    );
    if (targets.length === 0) return null;
    const agent = this.config.agents[steering.agent];
    if (!agent) throw new Error(`Unknown steering agent: ${steering.agent}`);
    const runner = this.config.runners[agent.runner];
    if (!runner || runner.type !== "codex") throw new Error("The steering agent must use a Codex runner");
    const allowed = agent.tasks.filter((task) => new Set([
      "operator.getBoard", "operator.getItemHistory", "operator.retryStoppedItem", "operator.answerItemQuestion",
      "operator.reportStoppedItemOutcome",
    ]).has(task));
    if (!allowed.includes("operator.getBoard") || !allowed.includes("operator.getItemHistory")) {
      throw new Error("The scheduled Operator requires operator.getBoard and operator.getItemHistory grants");
    }

    const runId = randomUUID();
    this.store.createRun({
      id: runId, issueId: null, stageId: "steering", attempt: 1, kind: "steering", status: "running",
      configHash: this.config.hash, startedAt: new Date().toISOString(),
    });
    this.store.appendRunEvent(runId, "operator.scheduled", { itemIds: targets.map((issue) => issue.id), cadenceMs: steering.periodic.intervalMs });
    this.#scheduledOperatorChecks.set(runId, {
      targets: new Set(targets.map((issue) => issue.id)),
      inspected: new Set(),
      outcomes: new Map(),
    });
    const controller = new AbortController();
    this.#steeringActive.set(runId, controller);
    const prompt = [
      "This is a scheduled Operator check, not an owner request.",
      `Consider only these stopped items: ${targets.map((issue) => issue.id).join(", ")}.`,
      "Inspect the board and each target's history before acting. Record a concise outcome for every target.",
      "You may retry only a target after quoting source content added after its recorded stop, or non-Operator conversation recorded after that stop.",
      "You may answer only an open target question when its answer is unambiguous and you quote the current issue, acceptance criteria, or recorded conversation evidence.",
      "For every inspected target you cannot safely retry or answer, use the outcome-reporting tool to record why it remains stopped. Do not move backlog items, inspect or act on unrelated items, or make up owner preferences.",
    ].join("\n");
    const completion = this.executeSteering(runId, prompt, { ...agent, tasks: allowed }, runner, steering.workspace, controller.signal, true)
      .finally(() => {
        const check = this.#scheduledOperatorChecks.get(runId);
        const run = this.store.getRun(runId);
        for (const issue of targets) {
          const outcome = check?.outcomes.get(issue.id);
          this.store.appendRunEvent(runId, "operator.outcome", {
            issueId: issue.id,
            outcome: outcome?.outcome ?? "unresolved",
            reason: outcome?.reason ??
              (check?.inspected.has(issue.id)
                ? `Scheduled check ${run?.status ?? "ended"} before recording a disposition.`
                : `Scheduled check ${run?.status ?? "ended"} before inspecting this target.`),
            runStatus: run?.status ?? "unknown",
            ...(outcome?.evidence ? { evidence: outcome.evidence } : {}),
          });
        }
        this.#scheduledOperatorChecks.delete(runId);
        this.#steeringActive.delete(runId);
        this.#steeringCompletions.delete(runId);
      });
    this.#steeringCompletions.set(runId, completion);
    void completion;
    return runId;
  }


  async startSteering(prompt: string): Promise<string> {
    const request = prompt.trim();
    if (!request || request.length > 12_000) {
      throw new Error("The steering prompt must contain between 1 and 12000 characters");
    }
    if (this.#drain) throw new Error("Conveyor is draining: no new work is admitted");
    const steering = this.config.web?.steering;
    if (!steering) throw new Error("The steering agent is not configured");
    // A human request wins over a cadence check. Abort and wait for its lease to close so their
    // grants cannot overlap; another owner request still receives the existing busy response.
    const scheduled = [...this.#steeringActive]
      .filter(([runId]) => this.#scheduledOperatorChecks.has(runId));
    for (const [, controller] of scheduled) controller.abort();
    await Promise.all(scheduled.map(([runId]) => this.#steeringCompletions.get(runId)));
    if (this.#steeringActive.size > 0) {
      throw new Error("A steering agent is already running");
    }
    const agent = this.config.agents[steering.agent];
    if (!agent) throw new Error(`Unknown steering agent: ${steering.agent}`);
    const runner = this.config.runners[agent.runner];
    if (!runner || runner.type !== "codex") {
      throw new Error("The steering agent must use a Codex runner");
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    this.store.createRun({
      id: runId,
      issueId: null,
      stageId: "steering",
      attempt: 1,
      kind: "steering",
      status: "running",
      configHash: this.config.hash,
      startedAt,
    });
    this.store.appendRunEvent(runId, "user", { text: request });
    const controller = new AbortController();
    this.#steeringActive.set(runId, controller);
    const completion = this.executeSteering(runId, request, agent, runner, steering.workspace, controller.signal)
      .finally(() => {
        this.#steeringActive.delete(runId);
        this.#steeringCompletions.delete(runId);
      });
    this.#steeringCompletions.set(runId, completion);
    void completion;
    return runId;
  }

  /** Wait for a currently running steering request to settle. */
  async waitForSteeringRun(runId: string): Promise<void> {
    await this.#steeringCompletions.get(runId);
  }

  private async executeSteering(
    runId: string,
    userPrompt: string,
    agent: ConveyorConfig["agents"][string],
    runner: Extract<ConveyorConfig["runners"][string], { type: "codex" }>,
    workspace: string,
    signal: AbortSignal,
    scheduled = false,
  ): Promise<void> {
    const started = performance.now();
    let lease: ScopedMcpLease | null = null;
    try {
      lease = await this.steeringMcpLease(runId, workspace, agent.tasks);
      const instructions = await readFile(agent.instructions, "utf8");
      const result = await this.#runSteering({
        command: runner.command,
        workspace,
        artifactsDirectory: path.join(this.config.settings.artifacts, runId),
        prompt: [
          instructions.trim(),
          conveyorToolGuidance(agent.tasks),
          "",
          scheduled ? "You are the scheduled Conveyor Operator. Work only within the scheduled check." : "You are the authenticated Conveyor steering agent. Work only within the user's request.",
          "Inspect current state before changing it. Never close source issues. Finish with a concise report of actions, verification, and anything still unresolved.",
          "Use agent.reportProgress only for concise user-facing updates. Never expose private reasoning, raw command output, command names, or tool-call mechanics in those updates.",
          "",
          "User request:",
          userPrompt,
        ].join("\n"),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: agent.workspaceAccess === "workspace-write" ? runner.sandbox : "read-only",
        ...(agent.workspaceAccess === "confined" ? { filesystem: "scratch" as const } : {}),
        automaticApprovals: runner.automaticApprovals,
        mcp: lease.configuration,
        interruptGraceMs: this.config.settings.interruptGraceMs,
        signal,
      });
      this.store.appendRunEvent(runId, "report", { text: result.summary });
      this.store.finishRun(runId, {
        status: "succeeded",
        exitCode: result.exitCode,
        result: { summary: result.summary },
        sessionId: result.sessionId,
        usage: {
          ...result.usage,
          amount: 0,
          currency: "USD",
          source: "unavailable",
          durationMs: result.durationMs,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.appendRunEvent(runId, "error", { text: message });
      this.store.finishRun(runId, {
        status: signal.aborted ? "interrupted" : "failed",
        exitCode: 1,
        result: { reason: message },
        sessionId: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          amount: 0,
          currency: "USD",
          source: "unavailable",
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        },
      });
    } finally {
      await lease?.close();
    }
  }

  getSteeringRun(runId: string): { id: string; status: string } | null {
    const run = this.store.getRun(runId);
    return run?.kind === "steering" ? { id: run.id, status: run.status } : null;
  }

  getSteeringEvents(runId: string, after: number): Array<{
    sequence: number;
    type: string;
    text: string;
    createdAt: string;
  }> {
    if (!this.getSteeringRun(runId)) return [];
    return this.store.listRunEvents(runId).flatMap((event) => {
      if (event.sequence <= after) return [];
      const visible = userFacingSteeringEvent(event);
      return visible ? [visible] : [];
    });
  }

  reorderBacklog(issueId: string, direction: "up" | "down"): void {
    this.requireBacklogIssue(issueId);
    this.store.moveQueueIssue(issueId, direction);
  }

  /** Drag-and-drop placement: put a backlog issue right before another, or last. */
  moveBacklogIssue(issueId: string, beforeIssueId: string | null): void {
    this.requireBacklogIssue(issueId);
    if (beforeIssueId !== null) this.requireBacklogIssue(beforeIssueId);
    this.store.moveQueueIssueBefore(issueId, beforeIssueId);
  }

  private requireBacklogIssue(issueId: string): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.parentId || issue.projectedState === "offboarded") {
      throw new Error("only top-level board issues can be reordered");
    }
    const repository = this.config.repositories[issue.repositoryId];
    const firstStage = repository
      ? this.config.pipelines[repository.pipeline]?.stages[0]?.id
      : undefined;
    if (!firstStage || issue.projectedStage !== firstStage) {
      throw new Error("only backlog issues can be reordered");
    }
  }

  /**
   * Queue comment writes for an issue so concurrent scheduling and webhook work cannot create
   * duplicate source comments or allow an older snapshot to win the race.
   */
  private updateStatusComment(issueId: string): Promise<void> {
    const previous = this.#statusCommentUpdatesByIssue.get(issueId) ?? Promise.resolve();
    const update = previous
      .catch(() => {})
      .then(() => this.writeStatusComment(issueId));
    this.#statusCommentUpdatesByIssue.set(issueId, update);
    this.#statusCommentUpdates.add(update);
    const complete = () => {
      this.#statusCommentUpdates.delete(update);
      if (this.#statusCommentUpdatesByIssue.get(issueId) === update) {
        this.#statusCommentUpdatesByIssue.delete(issueId);
      }
    };
    void update.then(complete, complete);
    return update;
  }

  /** The approval fence for an item. A merged item uses the durable review fence, not a later PR projection. */
  private criterionApprovalHead(issue: StoredIssue): string | null {
    const pullRequest = this.store.getCurrentPullRequest(issue.id);
    const context = this.store.executions().getContext(issue.id)?.context;
    const change = context?.change;
    if (!pullRequest || !change) return null;
    if (pullRequest.state === "merged" || pullRequest.mergedAt !== null || change.state === "merged") {
      return change.state === "merged" ? change.headSha : context.checkpoints.reviewPassed?.sha ?? null;
    }
    if (pullRequest.state !== "open" || change.state !== "open") return null;
    return this.#liveChangeHeads.get(issue.id) ?? change.headSha;
  }

  /** Source-authoritative criteria annotated from durable review approvals. */
  private criterionApprovalStates(issue: StoredIssue) {
    const approvals = new Map(
      new CriterionApprovals(this.store.sqlite()).list(issue.id).map((approval) => [approval.criterionId, approval]),
    );
    const headSha = this.criterionApprovalHead(issue);
    const evidence = new Map(this.store.criterionTestEvidence(issue.id).map((entry) => [entry.criterionId, entry]));
    const repository = this.config.repositories[issue.repositoryId];
    const host = this.codeHostFor(issue.repositoryId);
    return criteriaOf(issue.body).map(({ id, text, manual }) => {
      const recorded = evidence.get(id);
      return {
        id,
        text,
        approved: isCriterionApprovedAt(approvals, { id, text }, headSha),
        manual,
        tests: (recorded?.tests ?? []).map((test) => ({
          name: test.name,
          file: test.file,
          line: test.line ?? null,
          description: test.description ?? null,
          sourceUrl: repository && host && recorded?.sourceLinkHead
            ? host.sourceFileUrl({ address: repository.address, path: test.file, headSha: recorded.sourceLinkHead, ...(test.line === undefined ? {} : { line: test.line }) })
            : null,
        })),
      };
    });
  }

  private async writeStatusComment(issueId: string): Promise<void> {
    const issue = this.store.getIssue(issueId);
    if (!issue) return;
    if (this.store.repositoryPause(issue.repositoryId)) return;
    const relevant = issue.labels.some(
      (label) =>
        label === this.config.labels.enrollment ||
        label.startsWith(`${this.config.labels.enrollment}:`),
    );
    if (!relevant) return;
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    const stageState = this.store.getStageState(issue.id);
    const latestRun = this.store.latestRunSummary(issue.id);
    const questions = this.store
      .listOpenQuestions()
      .filter((question) => question.issueId === issue.id)
      .map((question) => question.prompt);
    const children = this.store.listChildren(issue.id).flatMap(({ issueId: childId }) => {
      const child = this.store.getIssue(childId);
      return child ? [{ number: child.sourceNumber, title: child.title }] : [];
    });
    const dependencies = this.store.listDependencies(issue.id).flatMap((blockerId) => {
      const blocker = this.store.getIssue(blockerId);
      return blocker
        ? [{ number: blocker.sourceNumber, title: blocker.title, state: blocker.projectedState ?? blocker.sourceState }]
        : [];
    });
    const openPullRequest = this.store.getCurrentPullRequest(issue.id);
    if (openPullRequest?.state === "open" && !openPullRequest.mergedAt) {
      // A status comment must agree with the review gate even when a webhook was delayed.
      const liveHead = await this.currentChangeHead(issue.repositoryId, openPullRequest.id);
      if (liveHead) this.setLiveChangeHead(issue.id, liveHead);
    } else {
      this.#liveChangeHeads.delete(issue.id);
    }
    const acceptanceCriteria = this.criterionApprovalStates(issue).map(({ text, approved }) => ({ text, passed: approved }));
    const status = this.currentIssueStatus(issue);
    const markdown = renderStatusComment({
      issue: { number: issue.sourceNumber, title: issue.title, state: issue.sourceState },
      stage: issue.projectedStage ?? "unassigned",
      state: issue.projectedState ?? "unknown",
      ...(status ? { status: this.statusCommentText(status) } : {}),
      ...(stageState
        ? { activity: `${stageState.stageId} · ${stageState.status}` }
        : {}),
      acceptanceCriteria,
      children,
      dependencies,
      ...(latestRun
        ? { latestRun: {
            id: latestRun.id,
            state: latestRun.status,
            durationMs: latestRun.durationMs,
            usage: {
              inputTokens: latestRun.inputTokens,
              outputTokens: latestRun.outputTokens,
            },
            costUsd:
              latestRun.costSource === "unavailable" ? null : latestRun.amount,
          } }
        : {}),
      questions,
      warnings: !status && issue.warning ? [issue.warning] : [],
    });
    const digest = createHash("sha256").update(markdown).digest("hex");
    const mutation = this.store.beginSourceMutation({
      idempotencyKey: `status:${issue.id}:${digest}`,
      source: repository.source,
      operation: "comment.status.upsert",
      request: { issueId: issue.id, digest },
    });
    // A succeeded mutation only proves this content was written once; the remote comment may
    // have moved on since (checked, then unchecked), so skip only when it is the last write.
    if (mutation.status === "succeeded" && this.#statusCommentDigests.get(issue.id) === digest) return;
    try {
      const commentId = await this.executionGitHub(issue.repositoryId).upsertStatusComment(
        repository.address,
        issue.sourceNumber,
        markdown,
        this.#statusCommentIds.get(issue.id),
      );
      this.store.completeSourceMutation(mutation.id, { commentId });
      this.#statusCommentDigests.set(issue.id, digest);
      this.#statusCommentIds.set(issue.id, commentId);
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * The status line of the issue's status comment. Only the status itself: times that move on their
   * own (the next check, how long it has been queued) would rewrite the comment without any change.
   */
  private statusCommentText(status: LiveIssueStatus): string {
    return `${status.kind === "queued" ? "Queued" : "Waiting"} · ${status.reason}`;
  }

  private repositorySummaries(issues?: readonly StoredIssue[]): RepositorySummaries {
    return buildRepositorySummaries({
      store: this.store,
      config: this.config,
      ...(issues ? { issues } : {}),
      onboardingErrors: this.#onboardingErrors,
      reconciliationErrors: this.#repositoryErrors,
      startup: this.#startupRepositories,
      lastReconciledAt: this.#lastReconciledAt,
      webhookHealth: this.#webhookHealth,
      githubCalls: this.githubCalls.summary(GITHUB_CALL_SUMMARY_MS),
    });
  }

  /** Matches the event stream revision to displayed repository facts, excluding volatile report timestamps. */
  private dashboardRevision(repositorySummaries = this.repositorySummaries()): string {
    const repositoryFacts = repositorySummaries.repositories.map(({ id, health, error, lastReconciledAt, startup }) => ({ id, health, error, lastReconciledAt, startup }));
    const repositoryDigest = createHash("sha256").update(JSON.stringify(repositoryFacts)).digest("hex");
    return `${this.store.dashboardRevision()}|repositories:${repositoryDigest}`;
  }

  dashboard(
    csrfToken: string,
    pagination: DashboardPageSelection = {
      view: "board",
      repositoryId: null,
      column: null,
      page: 1,
      doneLimit: 20,
      runId: null,
      issueId: null,
      repositoryIds: [],
      q: "",
      state: null,
      recentTypes: [],
      recentCursor: null,
    },
  ): DashboardViewModel {
    const agentRunner = new Map(Object.entries(this.config.agents ?? {}).map(([agentId, agent]) => [agentId, agent.runner]));
    const harnessUsage = Object.entries(this.config.runners ?? {}).flatMap(([runnerId, runner]) => {
      if (runner.type !== "codex" && runner.type !== "claude-code") return [];
      const windows = runner.type === "codex"
        ? readCodexQuota(process.env.CODEX_HOME || path.join(homedir(), ".codex"))
        : readClaudeQuota([...agentRunner.entries()].flatMap(([agentId, configuredRunner]) =>
            configuredRunner === runnerId ? this.store.listHarnessRunEvents(agentId) : [],
          ));
      return [{
        id: runnerId,
        name: runnerId === "codex" ? "Codex" : runnerId === "claude-code" ? "Claude Code" : displayName(runnerId),
        windows,
      }];
    });
    const listedIssues = this.store.listIssues();
    const issues = listedIssues.filter((issue) => issue.projectedState !== "offboarded");
    const repositoryColors = new Map(Object.keys(this.config.repositories).map((repositoryId, index) =>
      [repositoryId, (index % 8) + 1],
    ));
    const activeRuns = this.store.listActiveIssueRuns();
    const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const listedById = new Map(listedIssues.map((issue) => [issue.id, issue]));
    const openQuestions = this.store.listOpenQuestions().filter((question) => byId.has(question.issueId));
    const questionIssueIds = new Set(openQuestions.map((question) => question.issueId));
    const relation = (issue: StoredIssue): IssueRelationViewModel => ({
      id: issue.id,
      repository: issue.repositoryId,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      satisfied:
        issue.sourceState === "closed" ||
        issue.projectedState === "done" ||
        issue.projectedState === "completed",
    });
    const rollupRelation = (issue: StoredIssue): IssueRelationViewModel => ({
      ...relation(issue),
      satisfied: this.isRollupSatisfied(issue.id),
    });
    // A parent card places each child on the line: Backlog, each configured stage, then Done.
    // Called only while cards are built, after the stages and the backlog below are known.
    const childRelation = (child: StoredIssue): IssueRelationViewModel => {
      const base = rollupRelation(child);
      const names = ["Backlog", ...stages.map((stage) => stageNames.get(stage) ?? displayName(stage)), "Done"];
      const stageIndex = child.projectedStage ? stages.indexOf(child.projectedStage) : -1;
      const index = base.satisfied
        ? names.length - 1
        : backlogIds.has(child.id) || stageIndex < 0 ? 0 : stageIndex + 1;
      const station = { index, count: names.length, name: names[index]! };
      return { ...withProgress(child, base), station };
    };
    // An unfinished child or dependency also says whether it is moving, and its state in words.
    const withProgress = (item: StoredIssue, base: IssueRelationViewModel): IssueRelationViewModel => {
      if (base.satisfied) return base;
      const state = item.projectedState ?? item.sourceState;
      const signal = activeIssueIds.has(item.id)
        ? "run"
        // An item with inconsistent labels cannot move until someone repairs them: it is stopped too.
        : questionIssueIds.has(item.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { ...base, signal, state: displayName(state) };
    };
    const tone = (state: string): IssueTone => {
      if (state === "done" || state === "completed") return "success";
      if (["blocked", "error", "rejected", "needs-intervention", "inconsistent"].includes(state)) {
        return "danger";
      }
      if (["paused", "needs-input"].includes(state)) return "warning";
      if (state === "closed") return "muted";
      return "active";
    };
    const todos = new ItemTodos(this.store.sqlite());
    const renderedAt = Date.now();
    const indicators = new Map<string, IndicatorViewModel[]>();
    for (const stored of this.store.listIndicators()) {
      // CI that is disabled for the repository shows nothing, even if a record was stored earlier.
      const repositoryId = byId.get(stored.issueId)?.repositoryId;
      if (stored.id === CI_INDICATOR_ID && (!repositoryId || this.config.repositories[repositoryId]?.ci?.mode === "disabled")) continue;
      indicators.set(stored.issueId, [...(indicators.get(stored.issueId) ?? []), indicatorView(stored, renderedAt)]);
    }
    // A dashboard uses the same item facts in columns, rollups, related-item details, and the
    // selected card. Keep each per-item store lookup to one read for the whole model build.
    const stageStates = new Map<string, ReturnType<ConveyorStore["getStageState"]>>();
    const stageStateFor = (issueId: string) => {
      if (!stageStates.has(issueId)) stageStates.set(issueId, this.store.getStageState(issueId));
      return stageStates.get(issueId)!;
    };
    const childrenByParent = new Map<string, ReturnType<ConveyorStore["listChildren"]>>();
    const childrenFor = (issueId: string) => {
      if (!childrenByParent.has(issueId)) childrenByParent.set(issueId, this.store.listChildren(issueId));
      return childrenByParent.get(issueId)!;
    };
    const dependenciesByIssue = new Map<string, ReturnType<ConveyorStore["listDependencies"]>>();
    const dependenciesFor = (issueId: string) => {
      if (!dependenciesByIssue.has(issueId)) dependenciesByIssue.set(issueId, this.store.listDependencies(issueId));
      return dependenciesByIssue.get(issueId)!;
    };
    const dependentsByIssue = new Map<string, ReturnType<ConveyorStore["listDependents"]>>();
    const dependentsFor = (issueId: string) => {
      if (!dependentsByIssue.has(issueId)) dependentsByIssue.set(issueId, this.store.listDependents(issueId));
      return dependentsByIssue.get(issueId)!;
    };
    const costsByIssue = new Map<string, ReturnType<ConveyorStore["costSummary"]>>();
    const costFor = (issueId: string) => {
      if (!costsByIssue.has(issueId)) costsByIssue.set(issueId, this.store.costSummary({ issueId }));
      return costsByIssue.get(issueId)!;
    };
    const schedulerQueue = this.schedulerQueue(listedIssues, {
      stageState: stageStateFor,
      dependencies: dependenciesFor,
      children: childrenFor,
      issue: (issueId) => listedById.get(issueId) ?? null,
    });
    const card = (
      issue: StoredIssue,
      options: { reason?: string | null; state?: string } = {},
    ): IssueCardViewModel => {
      const state = stageStateFor(issue.id);
      const cost = costFor(issue.id);
      const children = childrenFor(issue.id)
        .flatMap(({ issueId }) => {
          const child = byId.get(issueId);
          return child ? [childRelation(child)] : [];
        });
      const dependencies = dependenciesFor(issue.id)
        .flatMap((issueId) => {
          const dependency = listedById.get(issueId);
          return dependency ? [withProgress(dependency, relation(dependency))] : [];
        });
      const projectedState = options.state ?? issue.projectedState ?? issue.sourceState;
      const parent = issue.parentId ? byId.get(issue.parentId) : null;
      const siblings = parent
        ? childrenFor(parent.id).flatMap(({ issueId }) => {
            const sibling = byId.get(issueId);
            return sibling ? [rollupRelation(sibling)] : [];
          })
        : [];
      const cursor = this.store.executions().getCursor(issue.id);
      const manualGates = this.manualGateViews(issue);
      const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
      const parked = !questionIssueIds.has(issue.id) ? this.currentIssueStatus(issue, schedulerQueue) : null;
      const retry = !activeIssueIds.has(issue.id)
        ? this.#infrastructureFailures.get(issue.id)?.waiting ?? null
        : null;
      const waiting = parked ?? retry;
      const stopped = STOPPED_ISSUE_STATES.has(projectedState);
      const openQuestion = stopped ? openQuestions.find((question) => question.issueId === issue.id) : undefined;
      const waitingDependencies = dependencies.filter((dependency) => !dependency.satisfied);
      const dependencyReason = waitingDependencies.length > 0
        ? `Waiting for ${waitingDependencies.map((dependency) => `#${dependency.number} ${dependency.title}`).join(", ")} to be completed.`
        : null;
      const stopReason = stopped
        ? latestStopReason(this.store, issue.id) ??
          (openQuestion ? `${openQuestion.reason}. Answer needed: ${openQuestion.prompt}` : null) ??
          dependencyReason ?? issue.warning ?? options.reason ??
          "Conveyor received the stopped state, but no blocking reason was recorded. Add the concrete blocker and required action in Conversation before resuming this item."
        : null;
      const viewIssue = { ...issue, projectedState };
      const retryable = this.retryableStoppedIssue(viewIssue, children.length, activeIssueIds.has(issue.id));
      const resumable = this.resumablePausedIssue(viewIssue, activeIssueIds.has(issue.id));
      const resumableRollup = this.resumableRollupIssue(viewIssue, children.length, activeIssueIds.has(issue.id), openQuestion !== undefined);
      return {
        id: issue.id,
        repository: issue.repositoryId,
        repositoryPaused: this.store.repositoryPause(issue.repositoryId) !== null,
        repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
        number: issue.sourceNumber,
        title: issue.title,
        url: issue.sourceUrl,
        state: projectedState,
        labels: issue.labels,
        issueType: issue.metadata.type,
        issueFields: this.issueFieldValues(issue),
        acceptanceCriteria: this.criterionApprovalStates(issue),
        manualGates,
        csrfToken,
        todos: todosView(todos.get(issue.id)?.items ?? []),
        stage: issue.projectedStage,
        stageBadge: stageBadgeFor(issue, state),
        searchActors: issue.projectedStage
          ? actorsForStage(issue.projectedStage, this.config.repositories[issue.repositoryId]?.pipeline)
          : [],
        indicators: indicators.get(issue.id) ?? [],
        activity: cursor?.state === "pending"
          ? `${cursor.stage} › ${cursor.taskInstanceId ?? cursor.list}`
          : state ? `${state.stageId} · ${state.status}` : null,
        // Live waiting/queued text supersedes the persisted warning, which can describe the
        // gate state from before the item became runnable.
        reason: stopReason ?? (manualWaiting
          ? manualWaiting.kind === "board" ? "Waiting for board approval"
            : manualWaiting.kind === "entry" ? "Waiting for configured entry approval."
              : `Waiting for configured manual gate \"${manualWaiting.gateId}\".`
          : waiting ? null : issue.warning ?? options.reason ?? null),
        cost: formatUsage(cost),
        duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
        stateChangedAt: state?.updatedAt ?? issue.sourceUpdatedAt,
        waiting,
        blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(projectedState),
        inconsistent: issue.projectedState === "inconsistent",
        closable: issue.labels.includes(this.config.labels.metadata.closable),
        noSplit: issue.labels.includes(this.config.labels.metadata.noSplit),
        tone: tone(projectedState),
        parent: parent ? rollupRelation(parent) : null,
        parentProgress: parent && siblings.length > 0
          ? { done: siblings.filter((sibling) => sibling.satisfied).length, total: siblings.length }
          : null,
        children,
        dependencies,
        working: activeIssueIds.has(issue.id),
        needsAttention: questionIssueIds.has(issue.id) || manualWaiting !== null || [
          "blocked", "error", "needs-input", "needs-intervention", "rejected",
        ].includes(projectedState),
        retryable,
        resumable,
        resumableRollup,
        stoppedRollup: stopped && children.length > 0,
        ...(issue.projectedState === "offboarded" ? { historyOnly: true } : {}),
      };
    };
    const stageNames = new Map<string, string>();
    const stageDescriptions = new Map<string, string>();
    const stageIcons = new Map<string, string>();
    for (const pipeline of Object.values(this.config.pipelines)) {
      for (const stage of pipeline.stages) {
        if (!stageNames.has(stage.id)) stageNames.set(stage.id, stage.name ?? displayName(stage.id));
        if (stage.description && !stageDescriptions.has(stage.id)) stageDescriptions.set(stage.id, stage.description);
        if (stage.icon && !stageIcons.has(stage.id)) stageIcons.set(stage.id, stage.icon);
      }
    }
    const stages = [...stageNames.keys()];
    const recent = pagination.view === "recent"
      ? this.recentActivity(pagination, repositoryColors)
      : undefined;
    const actorsForStage = (stageId: string, pipelineId?: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      const addAgent = (agentId: string) => {
        const agent = this.config.agents[agentId];
        actors.push({
          type: "agent",
          name: agent?.name ?? displayName(agentId),
          title: agent?.title ?? "AI agent",
        });
      };
      for (const [id, pipeline] of Object.entries(this.config.pipelines)) {
        if (pipelineId && id !== pipelineId) continue;
        const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
        if (!stage) continue;
        if (isNativeStage(stage)) {
          const agentIds = stage.actions.flatMap((task) => {
            if (task.task !== "agent.run") return [];
            const single = task.with?.agent;
            const listed = task.with?.agents;
            return [
              ...(typeof single === "string" ? [single] : []),
              ...(Array.isArray(listed) ? listed.filter((value): value is string => typeof value === "string") : []),
            ];
          });
          if (agentIds.length === 0) actors.push({ type: "script", name: "Script", title: null });
          else agentIds.forEach(addAgent);
          continue;
        }
        if (stage.run.type !== "agent") {
          actors.push({ type: "script", name: "Script", title: null });
          continue;
        }
        addAgent(stage.run.agent);
      }
      return [...new Map(actors.map((actor) => [
        `${actor.type}:${actor.name}:${actor.title ?? ""}`,
        actor,
      ])).values()];
    };
    const configuredStages = new Set(stages);
    const sourceStages = (issue: StoredIssue): string[] => {
      const repository = this.config.repositories[issue.repositoryId];
      const pipeline = repository ? this.config.pipelines[repository.pipeline] : null;
      if (!pipeline) return [];
      return pipeline.stages.flatMap((stage) =>
        issue.labels.includes(this.config.labels.stageTemplate.replace("{stage}", stage.id))
          ? [stage.id]
          : [],
      );
    };
    const remainsInWorkflow = (issue: StoredIssue): boolean =>
      issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "done" &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active");
    const finishedRollupIds = new Set(issues
      .filter((issue) => ["done", "completed"].includes(issue.projectedState ?? ""))
      .filter((issue) => childrenFor(issue.id).length > 0)
      .filter((issue) => this.isRollupSatisfied(issue.id))
      .map((issue) => issue.id));
    const filterRepositories = new Set(pagination.repositoryIds ?? []);
    const filterWords = (pagination.q ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    /** Deliberately excludes long issue bodies and acceptance criteria. */
    const matchesBoardText = (issue: StoredIssue): boolean => {
      if (filterWords.length === 0) return true;
      const assignedAgents = issue.projectedStage
        ? actorsForStage(issue.projectedStage, this.config.repositories[issue.repositoryId]?.pipeline)
        : [];
      const haystack = [
        issue.title,
        String(issue.sourceNumber),
        `#${issue.sourceNumber}`,
        issue.repositoryId,
        ...issue.labels,
        issue.metadata.type ?? "",
        ...this.issueFieldValues(issue).flatMap((field) => [field.name, field.value]),
        ...assignedAgents.flatMap((agent) => [agent.name, agent.title ?? ""]),
      ].join(" ").toLocaleLowerCase();
      return filterWords.every((word) => haystack.includes(word));
    };
    const matchesDoneFilter = (issue: StoredIssue): boolean =>
      (filterRepositories.size === 0 || filterRepositories.has(issue.repositoryId)) && matchesBoardText(issue);
    const closedIssues = issues
      .filter((issue) =>
        (issue.sourceState === "closed" && !remainsInWorkflow(issue)) || finishedRollupIds.has(issue.id)
      )
      .filter(matchesDoneFilter)
      .sort((left, right) =>
        right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
        left.repositoryId.localeCompare(right.repositoryId) ||
        right.sourceNumber - left.sourceNumber
      );
    // This is a database count over the Done predicate, not a count of the already materialized
    // list. Keep the card projection below limited even when a repository has years of history.
    const doneTotal = this.store.countFinishedIssues({
      repositoryIds: [...filterRepositories],
      words: filterWords,
      workflows: Object.entries(this.config.repositories).map(([repositoryId, repository]) => ({
        repositoryId,
        stages,
        sourceStageLabels: (this.config.pipelines[repository.pipeline]?.stages ?? []).map((stage) =>
          this.config.labels.stageTemplate.replace("{stage}", stage.id),
        ),
      })),
      stageActors: Object.entries(this.config.repositories).flatMap(([repositoryId, repository]) =>
        (this.config.pipelines[repository.pipeline]?.stages ?? []).map((stage) => ({
          repositoryId,
          stageId: stage.id,
          text: actorsForStage(stage.id, repository.pipeline)
            .flatMap((actor) => [actor.name, actor.title ?? ""])
            .join(" ")
            .toLocaleLowerCase(),
        })),
      ),
    });
    const workflowIssues = issues.filter((issue) =>
      !finishedRollupIds.has(issue.id) && (issue.sourceState !== "closed" || remainsInWorkflow(issue))
    );
    const backlogIssues = workflowIssues.filter((issue) => {
      if (issue.sourceState === "closed") return false;
      if (issue.parentId || !issue.labels.includes(this.config.labels.enrollment)) return false;
      if (
        sourceStages(issue).length !== 0 ||
        (issue.projectedState !== "active" && !STOPPED_ISSUE_STATES.has(issue.projectedState ?? ""))
      ) return false;
      const stageState = stageStateFor(issue.id);
      const repository = this.config.repositories[issue.repositoryId];
      const firstStage = repository ? this.config.pipelines[repository.pipeline]?.stages[0]?.id : undefined;
      if (issue.projectedStage !== firstStage) return false;
      if (issue.projectedState === "active") {
        return stageState?.status === "ready" && !this.store.getActiveWorkspace(issue.id);
      }
      return stageState?.status === issue.projectedState ||
        (issue.projectedState === "needs-input" && stageState?.status === "ready");
    });
    const backlogIds = new Set(backlogIssues.map((issue) => issue.id));
    const stageBadgeFor = (
      issue: StoredIssue,
      state: ReturnType<ConveyorStore["getStageState"]>,
    ): IssueStageBadgeViewModel => itemStageBadge(
      issue.projectedStage ?? state?.stageId ?? null,
      stageNames,
      stageIcons,
      issue.projectedState === "offboarded"
        ? "offboarded"
        : finishedRollupIds.has(issue.id) || (issue.sourceState === "closed" && !remainsInWorkflow(issue))
        ? "done"
        : backlogIds.has(issue.id)
        ? "backlog"
        : null,
    );
    const stagedIssues = workflowIssues.filter((issue) =>
      !backlogIds.has(issue.id) &&
      issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active"),
    );
    const stagedIds = new Set(stagedIssues.map((issue) => issue.id));
    const attentionIssues = workflowIssues.filter((issue) =>
      !backlogIds.has(issue.id) && !stagedIds.has(issue.id),
    );
    const graphFilterRepositories = new Set(pagination.repositoryIds ?? []);
    const graphCurrentIssues = workflowIssues.filter((issue) =>
      (graphFilterRepositories.size === 0 || graphFilterRepositories.has(issue.repositoryId)) &&
      (!pagination.graphStage || issue.projectedStage === pagination.graphStage),
    );
    // The graph starts with filtered current workflow items, then adds only direct relationship
    // endpoints. That retains the context needed to understand a current item without turning
    // historical completed work into a second, unbounded archive view.
    const graphCurrentIds = new Set(graphCurrentIssues.map((issue) => issue.id));
    const graphContextIds = new Set<string>();
    const addGraphContext = (issueId: string | null | undefined) => {
      if (issueId && !graphCurrentIds.has(issueId) && listedById.has(issueId)) graphContextIds.add(issueId);
    };
    for (const issue of graphCurrentIssues) {
      addGraphContext(issue.parentId);
      childrenFor(issue.id).forEach(({ issueId }) => addGraphContext(issueId));
      dependenciesFor(issue.id).forEach(addGraphContext);
      dependentsFor(issue.id).forEach(addGraphContext);
    }
    const graphIds = new Set([...graphCurrentIds, ...graphContextIds]);
    const graphStatus = (issue: StoredIssue) => {
      const itemRelation = childrenFor(issue.id).length > 0 ? rollupRelation(issue) : relation(issue);
      if (itemRelation.satisfied) return { satisfied: true, signal: null } as const;
      const state = issue.projectedState ?? issue.sourceState;
      const signal = activeIssueIds.has(issue.id)
        ? "run"
        : questionIssueIds.has(issue.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { satisfied: false, signal } as const;
    };
    const graphNodes: GraphNodeViewModel[] = [...graphIds]
      .flatMap((issueId) => {
        const issue = listedById.get(issueId);
        if (!issue) return [];
        const status = graphStatus(issue);
        return [{
          id: issue.id,
          repository: issue.repositoryId,
          repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
          number: issue.sourceNumber,
          title: issue.title,
          state: displayName(issue.projectedState ?? issue.sourceState),
          stage: issue.projectedStage ? stageNames.get(issue.projectedStage) ?? displayName(issue.projectedStage) : null,
          stageId: issue.projectedStage,
          context: graphContextIds.has(issue.id),
          signal: status.signal,
        }];
      })
      .sort((left, right) =>
        left.repository.localeCompare(right.repository) || left.number - right.number || left.id.localeCompare(right.id)
      );
    const graphRelationships = new Map<string, GraphRelationshipViewModel>();
    const addGraphRelationship = (relationship: GraphRelationshipViewModel) => {
      if (!graphIds.has(relationship.from) || !graphIds.has(relationship.to)) return;
      graphRelationships.set(`${relationship.kind}:${relationship.from}:${relationship.to}`, relationship);
    };
    for (const issue of graphCurrentIssues) {
      if (issue.parentId) addGraphRelationship({ kind: "parent-child", from: issue.parentId, to: issue.id, status: null });
      childrenFor(issue.id).forEach(({ issueId }) => {
        addGraphRelationship({ kind: "parent-child", from: issue.id, to: issueId, status: null });
      });
      dependenciesFor(issue.id).forEach((prerequisiteId) => {
        const prerequisite = listedById.get(prerequisiteId);
        if (!prerequisite) return;
        const prerequisiteStatus = graphStatus(prerequisite);
        addGraphRelationship({
          kind: "dependency",
          from: prerequisite.id,
          to: issue.id,
          status: prerequisiteStatus.satisfied ? "satisfied" : prerequisiteStatus.signal === "stop" ? "stopped" : "outstanding",
        });
      });
      dependentsFor(issue.id).forEach((dependentId) => {
        const dependent = listedById.get(dependentId);
        if (!dependent) return;
        const prerequisiteStatus = graphStatus(issue);
        addGraphRelationship({
          kind: "dependency",
          from: issue.id,
          to: dependent.id,
          status: prerequisiteStatus.satisfied ? "satisfied" : prerequisiteStatus.signal === "stop" ? "stopped" : "outstanding",
        });
      });
    }
    const graph = {
      nodes: graphNodes,
      relationships: [...graphRelationships.values()].sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
      ),
    };
    const column = (
      id: string,
      name: string,
      columnIssues: StoredIssue[],
      cost: string | null,
      issueCard: (issue: StoredIssue) => IssueCardViewModel = (issue) => card(issue),
      actors: readonly StageActorViewModel[] = [],
      complete = false,
    ): StageColumnViewModel => {
      const totalPages = complete ? 1 : Math.max(1, Math.ceil(columnIssues.length / DASHBOARD_PAGE_SIZE));
      const requestedPage = pagination.column === id ? pagination.page : 1;
      const page = Math.min(Math.max(1, requestedPage), totalPages);
      const offset = (page - 1) * DASHBOARD_PAGE_SIZE;
      return {
        id,
        name,
        actors,
        cost,
        totalIssues: columnIssues.length,
        page,
        totalPages,
        issues: (complete ? columnIssues : columnIssues.slice(offset, offset + DASHBOARD_PAGE_SIZE)).map(issueCard),
      };
    };
    // A source-closed item remains actionable only when its correlated Conveyor PR merged and
    // it still has configured workflow work after that merge.
    const awaitsOwner = (issue: StoredIssue): boolean =>
      issue.labels.includes(this.config.labels.enrollment) &&
      (issue.sourceState !== "closed" ||
        (remainsInWorkflow(issue) && this.store.hasMergedPullRequest(issue.id)));
    const questions: QuestionViewModel[] = openQuestions.flatMap((question) => {
      const issue = byId.get(question.issueId);
      if (!issue || !awaitsOwner(issue)) return [];
      const options = questionOptions(question.options);
      return [{
        id: question.id,
        issueId: issue.id,
        repository: issue.repositoryId,
        repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
        issueNumber: issue.sourceNumber,
        issueTitle: issue.title,
        prompt: question.prompt,
        reason: question.reason,
        options,
        allowFreeText: question.allowFreeText,
        answerError: questionConfigurationError(question.options, question.allowFreeText),
      }];
    });
    const total = this.store.costSummary();
    const stageCosts = this.store.costSummaryByStage();
    const steering = this.steeringView(pagination.runId);
    const repositorySummaries = this.repositorySummaries(listedIssues);
    const degradedRepositories = repositorySummaries.repositories.filter((repository) => repository.health === "degraded").length;
    const unassociatedWarnings = [
      ...this.#onboardingErrors.entries(),
      ...this.#repositoryErrors.entries(),
    ].filter(([repository]) => !this.config.repositories[repository]).map(([repository, message]) => `${repository}: ${message}`);
    return {
      title: "Conveyor",
      project: `${Object.keys(this.config.repositories).length} repositories${degradedRepositories > 0 ? ` · ${degradedRepositories} degraded` : ""}`,
      totalUsage: formatUsage(total) ?? "0 runs",
      harnessUsage,
      draining: this.#drain
        ? {
          reason: this.#drain.reason,
          upgrade: this.#drain.upgrade
            ? {
              version: this.#drain.upgrade.targetVersion,
              releaseUrl: `https://github.com/Abaniumbay/conveyor/releases/tag/${this.#drain.upgrade.releaseTag}`,
            }
            : null,
        }
        : null,
      updatedAt: this.#lastReconciledAt ?? new Date().toISOString(),
      revision: this.dashboardRevision(repositorySummaries),
      view: pagination.view,
      repositoryId: pagination.repositoryId ?? null,
      boardFilters: {
        repositories: [...filterRepositories],
        q: pagination.q ?? "",
        state: pagination.state ?? null,
      },
      graphFilters: {
        repositories: [...graphFilterRepositories],
        stage: pagination.graphStage ?? null,
        stages: stages.map((stage) => ({ id: stage, name: stageNames.get(stage) ?? displayName(stage) })),
      },
      ...(recent ? { recent } : {}),
      graph,
      counts: {
        board: backlogIssues.length + stagedIssues.length,
        attention: attentionIssues.length,
      },
      activeWork: {
        runnerCount: activeRuns.length,
        runnerCapacity: this.config.settings.runners,
        runs: activeRuns,
      },
      stages: stages.map((stage) => ({
        ...column(
          `stage:${stage}`,
          stageNames.get(stage) ?? displayName(stage),
          stagedIssues.filter((issue) => issue.projectedStage === stage),
          formatUsage(stageCosts.get(stage) ?? {
            runs: 0, amount: 0, currency: "USD", durationMs: 0,
            inputTokens: 0, outputTokens: 0, cachedTokens: 0, unavailableRuns: 0,
          }),
          (issue) => card(issue),
          actorsForStage(stage),
          true,
        ),
        description: stageDescriptions.get(stage) ?? null,
        icon: stageIcons.get(stage) ?? null,
      })),
      backlog: backlogIssues.map((issue) => card(issue)),
      done: {
        id: "done",
        name: "Done",
        actors: [],
        cost: null,
        totalIssues: doneTotal,
        page: 1,
        totalPages: 1,
        issues: closedIssues.slice(0, pagination.doneLimit).map((issue) => card(issue, {
          state: finishedRollupIds.has(issue.id)
            ? issue.projectedState ?? "done"
            : issue.sourceStateReason === "completed" ? "completed" : "closed",
          reason: issue.sourceStateReason && issue.sourceStateReason !== "completed"
            ? `GitHub close reason: ${issue.sourceStateReason.replaceAll("_", " ")}.`
            : null,
        })),
      },
      attention: column(
        "attention",
        "Label problems",
        attentionIssues,
        null,
        (issue) => card(issue, {
          reason: issue.projectedStage
            ? "The issue has conflicting or invalid Conveyor labels."
            : "No valid configured stage label is present.",
        }),
      ),
      questions,
      needsYou: workflowIssues
        .filter((issue) => ["blocked", "error", "needs-input", "needs-intervention", "rejected"].includes(issue.projectedState ?? "") ||
          this.manualGateViews(issue).some((gate) => gate.waiting))
        .filter(awaitsOwner)
        .map((issue) => card(issue)),
      systemWarnings: unassociatedWarnings,
      repositories: repositorySummaries.repositories,
      restrictedRepositories: repositorySummaries.restrictedRepositories,
      steering,
      selectedIssue: pagination.issueId && listedById.has(pagination.issueId)
        ? card(listedById.get(pagination.issueId)!)
        : null,
      csrfToken,
    };
  }

  /** The Operator: whether it is configured, its recent runs, and the selected (or latest) run's conversation. */
  steeringView(runId: string | null): SteeringViewModel {
    const recent = this.store.listRunsByKind("steering", 10);
    const selectedId = runId ?? recent[0]?.id ?? null;
    const run = selectedId ? this.store.getRun(selectedId) : null;
    return {
      enabled: Boolean(this.config.web?.steering),
      agent: this.config.web?.steering?.agent ?? null,
      selected: run?.kind === "steering"
        ? {
            id: run.id,
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            events: this.store.listRunEvents(run.id).flatMap((event) => {
              const visible = userFacingSteeringEvent(event);
              return visible ? [visible] : [];
            }),
          }
        : null,
      recent,
    };
  }

  /** One page of the Recent view, for the browser application. */
  recentActivityPage(pagination: DashboardPageSelection): RecentActivityViewModel {
    const repositoryColors = new Map(Object.keys(this.config.repositories).map((repositoryId, index) => [repositoryId, (index % 8) + 1]));
    return this.recentActivity(pagination, repositoryColors);
  }

  private recentActivity(
    pagination: DashboardPageSelection,
    repositoryColors: ReadonlyMap<string, number>,
  ): RecentActivityViewModel {
    const allTypes: RecentActivityType[] = ["done", "stopped", "sent-back", "moved-forward", "new", "resumed", "rollup"];
    const defaultTypes = allTypes.filter((type) => type !== "rollup");
    const types = pagination.recentTypes && pagination.recentTypes.length > 0
      ? [...new Set(pagination.recentTypes)]
      : defaultTypes;
    const selectedTypes = new Set(types);
    const selectedRepositories = new Set(pagination.repositoryIds ?? []);
    const configuredRepositories = [...selectedRepositories].filter((repositoryId) => this.config.repositories[repositoryId] !== undefined);
    const rangeStartedAt = pagination.recentCursor
      ? null
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (selectedRepositories.size > 0 && configuredRepositories.length === 0) {
      return { types, repositoryIds: [...selectedRepositories], events: [], nextCursor: null, rangeStartedAt };
    }
    const events: RecentActivityEventViewModel[] = [];
    let cursor = pagination.recentCursor ?? null;
    let nextCursor: { occurredAt: string; id: string | null } | null = null;
    let exhausted = false;
    let inspected = 0;
    while (!exhausted && events.length < 50 && inspected < recentActivityCandidateLimit) {
      // Fetch one extra source record so the cursor never claims that another page exists
      // merely because the current batch happened to end on its size boundary.
      const candidateLimit = Math.min(101, recentActivityCandidateLimit - inspected);
      const candidates = this.store.listRecentActivity({
        from: rangeStartedAt,
        before: cursor,
        limit: candidateLimit,
        repositoryIds: configuredRepositories,
      });
      if (candidates.length === 0) {
        exhausted = true;
        break;
      }
      let processed = 0;
      for (const event of candidates) {
        processed += 1;
        const classified = this.classifyRecentActivity(event, repositoryColors);
        if (!classified || !selectedTypes.has(classified.type)) continue;
        if (selectedRepositories.size > 0 && !selectedRepositories.has(classified.repository)) continue;
        events.push(classified);
        if (events.length === 50) break;
      }
      inspected += processed;
      const last = candidates[processed - 1]!;
      cursor = { occurredAt: last.occurredAt, id: last.id };
      nextCursor = cursor;
      exhausted = processed === candidates.length && candidates.length < candidateLimit;
    }
    if (exhausted && rangeStartedAt) {
      // The first page is bounded to the last day. A cursor without an ID means strictly before
      // that range boundary, allowing Load more to continue into retained history.
      const older = this.store.listRecentActivity({
        from: null,
        before: { occurredAt: rangeStartedAt, id: null },
        limit: 1,
        repositoryIds: configuredRepositories,
      });
      nextCursor = older.length > 0 ? { occurredAt: rangeStartedAt, id: null } : null;
    } else if (exhausted) {
      nextCursor = null;
    }
    return { types, repositoryIds: [...selectedRepositories], events, nextCursor, rangeStartedAt };
  }

  private classifyRecentActivity(
    event: ReturnType<ConveyorStore["listRecentActivity"]>[number],
    repositoryColors: ReadonlyMap<string, number>,
  ): RecentActivityEventViewModel | null {
    let type: RecentActivityType | null = null;
    if (event.source === "done" || event.source === "done-fallback") {
      type = "done";
    } else {
      const stopped = new Set(["blocked", "error", "needs-intervention", "rejected"]);
      const pipeline = this.config.pipelines[this.config.repositories[event.repositoryId]?.pipeline ?? ""];
      const configuredStages = pipeline?.stages ?? [];
      const from = configuredStages.findIndex((stage) => stage.id === event.fromStage);
      const to = configuredStages.findIndex((stage) => stage.id === event.toStage);
      if (event.kind === "onboarded") type = "new";
      else if (event.kind === "restarted" || event.kind === "resumed") type = "resumed";
      else if (event.kind === "rollup") type = "rollup";
      else if (event.kind === "stopped" || stopped.has(event.resultStatus ?? "")) type = "stopped";
      else if (from >= 0 && to >= 0 && to < from) type = "sent-back";
      else if (event.kind === "advance" || (from >= 0 && to >= 0 && to > from)) type = "moved-forward";
    }
    if (!type) return null;
    return {
      id: event.id,
      occurredAt: event.occurredAt,
      type,
      repository: event.repositoryId,
      repositoryColor: repositoryColors.get(event.repositoryId) ?? 1,
      issueNumber: event.issueNumber,
      issueTitle: event.issueTitle,
      issueUrl: `/issues/${encodeURIComponent(event.repositoryId)}/${event.issueNumber}`,
      fromStage: event.fromStage,
      toStage: event.toStage,
      reason: event.reason,
    };
  }

  /** One item's card, for an item the live dashboard model does not hold (finished long ago or offboarded). */
  issueDetails(csrfToken: string, issueId: string): IssueCardViewModel | null {
    // This route is deliberately independent from dashboard(). A dialog is normally opened for
    // one card, so rebuilding every board column, rollup, and repository summary here would make
    // the on-demand endpoint proportional to the board rather than to the item being opened.
    const issue = this.store.getIssue(issueId);
    if (!issue) return null;
    const repositoryColors = new Map(Object.keys(this.config.repositories).map((repositoryId, index) =>
      [repositoryId, (index % 8) + 1],
    ));
    const pipeline = this.config.pipelines[this.config.repositories[issue.repositoryId]?.pipeline ?? ""];
    const stages = pipeline?.stages ?? [];
    const stageNames = stages.map((stage) => stage.name ?? displayName(stage.id));
    const stageNamesById = new Map<string, string>();
    const stageIconsById = new Map<string, string>();
    for (const stage of stages) {
      stageNamesById.set(stage.id, stage.name ?? displayName(stage.id));
      if (stage.icon) stageIconsById.set(stage.id, stage.icon);
    }
    const activeIssueIds = new Set(this.store.listActiveIssueRuns().map((run) => run.issueId));
    const allOpenQuestions = this.store.listOpenQuestions();
    const openQuestions = allOpenQuestions.filter((question) => question.issueId === issue.id);
    const questionIssueIds = new Set(allOpenQuestions.map((question) => question.issueId));
    const relatedIssues = new Map<string, StoredIssue>([[issue.id, issue]]);
    const relatedIssue = (id: string): StoredIssue | null => {
      if (!relatedIssues.has(id)) {
        const candidate = this.store.getIssue(id);
        if (candidate) relatedIssues.set(id, candidate);
      }
      return relatedIssues.get(id) ?? null;
    };
    // Board cards show only enrolled children and parents, but their dependency list deliberately
    // retains offboarded relationship stubs so a stopped item can still say what it is waiting for.
    const boardIssue = (id: string): StoredIssue | null => {
      const candidate = relatedIssue(id);
      return candidate?.projectedState === "offboarded" ? null : candidate;
    };
    const stageStates = new Map<string, ReturnType<ConveyorStore["getStageState"]>>();
    const stageStateFor = (id: string) => {
      if (!stageStates.has(id)) stageStates.set(id, this.store.getStageState(id));
      return stageStates.get(id)!;
    };
    const childrenByParent = new Map<string, ReturnType<ConveyorStore["listChildren"]>>();
    const childrenFor = (id: string) => {
      if (!childrenByParent.has(id)) childrenByParent.set(id, this.store.listChildren(id));
      return childrenByParent.get(id)!;
    };
    const dependenciesByIssue = new Map<string, ReturnType<ConveyorStore["listDependencies"]>>();
    const dependenciesFor = (id: string) => {
      if (!dependenciesByIssue.has(id)) dependenciesByIssue.set(id, this.store.listDependencies(id));
      return dependenciesByIssue.get(id)!;
    };
    const relation = (item: StoredIssue): IssueRelationViewModel => ({
      id: item.id,
      repository: item.repositoryId,
      number: item.sourceNumber,
      title: item.title,
      url: item.sourceUrl,
      satisfied: item.sourceState === "closed" || item.projectedState === "done" || item.projectedState === "completed",
    });
    const rollupRelation = (item: StoredIssue): IssueRelationViewModel => ({
      ...relation(item),
      satisfied: this.isRollupSatisfied(item.id),
    });
    const withProgress = (item: StoredIssue, base: IssueRelationViewModel): IssueRelationViewModel => {
      if (base.satisfied) return base;
      const state = item.projectedState ?? item.sourceState;
      const signal = activeIssueIds.has(item.id)
        ? "run"
        : questionIssueIds.has(item.id) || STOPPED_ISSUE_STATES.has(state) || state === "inconsistent" ? "stop" : "wait";
      return { ...base, signal, state: displayName(state) };
    };
    const sourceStages = (item: StoredIssue): string[] => {
      const itemPipeline = this.config.pipelines[this.config.repositories[item.repositoryId]?.pipeline ?? ""];
      return itemPipeline?.stages.flatMap((stage) =>
        item.labels.includes(this.config.labels.stageTemplate.replace("{stage}", stage.id)) ? [stage.id] : [],
      ) ?? [];
    };
    const isBacklog = (item: StoredIssue): boolean => {
      if (item.sourceState === "closed" || item.parentId || !item.labels.includes(this.config.labels.enrollment)) return false;
      if (sourceStages(item).length !== 0 ||
        (item.projectedState !== "active" && !STOPPED_ISSUE_STATES.has(item.projectedState ?? ""))) return false;
      const itemPipeline = this.config.pipelines[this.config.repositories[item.repositoryId]?.pipeline ?? ""];
      if (item.projectedStage !== itemPipeline?.stages[0]?.id) return false;
      const state = stageStateFor(item.id);
      return item.projectedState === "active"
        ? state?.status === "ready" && !this.store.getActiveWorkspace(item.id)
        : state?.status === item.projectedState || (item.projectedState === "needs-input" && state?.status === "ready");
    };
    const childRelation = (child: StoredIssue): IssueRelationViewModel => {
      const base = rollupRelation(child);
      const names = ["Backlog", ...stageNames, "Done"];
      const stageIndex = child.projectedStage ? stages.findIndex((stage) => stage.id === child.projectedStage) : -1;
      const index = base.satisfied ? names.length - 1 : isBacklog(child) || stageIndex < 0 ? 0 : stageIndex + 1;
      return { ...withProgress(child, base), station: { index, count: names.length, name: names[index]! } };
    };
    const queue = this.schedulerQueue([issue], {
      stageState: stageStateFor,
      dependencies: dependenciesFor,
      children: childrenFor,
      issue: relatedIssue,
    });
    const state = stageStateFor(issue.id);
    const cost = this.store.costSummary({ issueId: issue.id });
    const children = childrenFor(issue.id).flatMap(({ issueId: childId }) => {
      const child = boardIssue(childId);
      return child ? [childRelation(child)] : [];
    });
    const dependencies = dependenciesFor(issue.id).flatMap((dependencyId) => {
      const dependency = relatedIssue(dependencyId);
      return dependency ? [withProgress(dependency, relation(dependency))] : [];
    });
    const parent = issue.parentId ? boardIssue(issue.parentId) : null;
    const siblings = parent
      ? childrenFor(parent.id).flatMap(({ issueId: siblingId }) => {
          const sibling = boardIssue(siblingId);
          return sibling ? [rollupRelation(sibling)] : [];
        })
      : [];
    const configuredStages = new Set(Object.values(this.config.pipelines).flatMap((itemPipeline) =>
      itemPipeline.stages.map((stage) => stage.id),
    ));
    const remainsInWorkflow = issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "done" &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active");
    const finishedRollup = ["done", "completed"].includes(issue.projectedState ?? "") &&
      childrenFor(issue.id).length > 0 && this.isRollupSatisfied(issue.id);
    const finished = (issue.sourceState === "closed" && !remainsInWorkflow) || finishedRollup;
    const doneState = finishedRollup
      ? issue.projectedState ?? "done"
      : issue.sourceStateReason === "completed" ? "completed" : "closed";
    const doneReason = issue.sourceStateReason && issue.sourceStateReason !== "completed"
      ? `GitHub close reason: ${issue.sourceStateReason.replaceAll("_", " ")}.`
      : null;
    const projectedState = finished ? doneState : issue.projectedState ?? issue.sourceState;
    const stageBadge = itemStageBadge(
      issue.projectedStage ?? state?.stageId ?? null,
      stageNamesById,
      stageIconsById,
      issue.projectedState === "offboarded" ? "offboarded" : finished ? "done" : isBacklog(issue) ? "backlog" : null,
    );
    const manualGates = this.manualGateViews(issue);
    const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
    const waiting = !questionIssueIds.has(issue.id) ? this.currentIssueStatus(issue, queue) : null;
    const retry = !activeIssueIds.has(issue.id) ? this.#infrastructureFailures.get(issue.id)?.waiting ?? null : null;
    const liveWaiting = waiting ?? retry;
    const stopped = STOPPED_ISSUE_STATES.has(projectedState);
    const openQuestion = stopped ? openQuestions[0] : undefined;
    const waitingDependencies = dependencies.filter((dependency) => !dependency.satisfied);
    const dependencyReason = waitingDependencies.length > 0
      ? `Waiting for ${waitingDependencies.map((dependency) => `#${dependency.number} ${dependency.title}`).join(", ")} to be completed.`
      : null;
    const stopReason = stopped
      ? latestStopReason(this.store, issue.id) ??
        (openQuestion ? `${openQuestion.reason}. Answer needed: ${openQuestion.prompt}` : null) ??
        dependencyReason ?? issue.warning ?? doneReason ??
        "Conveyor received the stopped state, but no blocking reason was recorded. Add the concrete blocker and required action in Conversation before resuming this item."
      : null;
    const viewIssue = { ...issue, projectedState };
    const retryable = this.retryableStoppedIssue(viewIssue, children.length, activeIssueIds.has(issue.id));
    const resumable = this.resumablePausedIssue(viewIssue, activeIssueIds.has(issue.id));
    const resumableRollup = this.resumableRollupIssue(viewIssue, children.length, activeIssueIds.has(issue.id), openQuestion !== undefined);
    const indicators = this.store.listIndicators(issue.id)
      .filter((indicator) => indicator.id !== CI_INDICATOR_ID || this.config.repositories[issue.repositoryId]?.ci?.mode !== "disabled")
      .map((indicator) => indicatorView(indicator, Date.now()));
    const actorsForStage = (stageId: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      const addAgent = (agentId: string) => {
        const agent = this.config.agents[agentId];
        actors.push({ type: "agent", name: agent?.name ?? displayName(agentId), title: agent?.title ?? "AI agent" });
      };
      for (const stage of stages.filter((candidate) => candidate.id === stageId)) {
        if (isNativeStage(stage)) {
          const agentIds = stage.actions.flatMap((task) => task.task !== "agent.run" ? [] : [
            ...(typeof task.with?.agent === "string" ? [task.with.agent] : []),
            ...(Array.isArray(task.with?.agents) ? task.with.agents.filter((value): value is string => typeof value === "string") : []),
          ]);
          if (agentIds.length === 0) actors.push({ type: "script", name: "Script", title: null });
          else agentIds.forEach(addAgent);
        } else if (stage.run.type !== "agent") {
          actors.push({ type: "script", name: "Script", title: null });
        } else addAgent(stage.run.agent);
      }
      return [...new Map(actors.map((actor) => [`${actor.type}:${actor.name}:${actor.title ?? ""}`, actor])).values()];
    };
    const cursor = this.store.executions().getCursor(issue.id);
    const todos = new ItemTodos(this.store.sqlite());
    const tone = (itemState: string): IssueTone => {
      if (itemState === "done" || itemState === "completed") return "success";
      if (["blocked", "error", "rejected", "needs-intervention", "inconsistent"].includes(itemState)) return "danger";
      if (["paused", "needs-input"].includes(itemState)) return "warning";
      return itemState === "closed" ? "muted" : "active";
    };
    return {
      id: issue.id,
      repository: issue.repositoryId,
      repositoryPaused: this.store.repositoryPause(issue.repositoryId) !== null,
      repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
      state: projectedState,
      labels: issue.labels,
      issueType: issue.metadata.type,
      issueFields: this.issueFieldValues(issue),
      acceptanceCriteria: this.criterionApprovalStates(issue),
      manualGates,
      csrfToken,
      todos: todosView(todos.get(issue.id)?.items ?? []),
      stage: issue.projectedStage,
      stageBadge,
      searchActors: issue.projectedStage ? actorsForStage(issue.projectedStage) : [],
      indicators,
      activity: cursor?.state === "pending" ? `${cursor.stage} › ${cursor.taskInstanceId ?? cursor.list}` : state ? `${state.stageId} · ${state.status}` : null,
      reason: stopReason ?? (manualWaiting
        ? manualWaiting.kind === "board" ? "Waiting for board approval"
          : manualWaiting.kind === "entry" ? "Waiting for configured entry approval."
            : `Waiting for configured manual gate \"${manualWaiting.gateId}\".`
        : liveWaiting ? null : issue.warning ?? doneReason ?? null),
      cost: formatUsage(cost),
      duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
      stateChangedAt: state?.updatedAt ?? issue.sourceUpdatedAt,
      waiting: liveWaiting,
      blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(projectedState),
      inconsistent: issue.projectedState === "inconsistent",
      closable: issue.labels.includes(this.config.labels.metadata.closable),
      noSplit: issue.labels.includes(this.config.labels.metadata.noSplit),
      tone: tone(projectedState),
      parent: parent ? rollupRelation(parent) : null,
      parentProgress: parent && siblings.length > 0 ? { done: siblings.filter((sibling) => sibling.satisfied).length, total: siblings.length } : null,
      children,
      dependencies,
      working: activeIssueIds.has(issue.id),
      needsAttention: questionIssueIds.has(issue.id) || manualWaiting !== null ||
        ["blocked", "error", "needs-input", "needs-intervention", "rejected"].includes(projectedState),
      retryable,
      resumable,
      resumableRollup,
      stoppedRollup: stopped && children.length > 0,
      ...(issue.projectedState === "offboarded" ? { historyOnly: true } : {}),
    };
  }

  issueActivity(issueId: string, before?: string): IssueActivityViewModel | null {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") return null;
    const page = this.store.listIssueRunsPage(issueId, {
      ...(before ? { before } : {}),
      limit: ACTIVITY_RUN_PAGE_SIZE,
    });
    return {
      issueId,
      runs: page.runs.map((run) => {
        const events = this.store.listRunEventsPage(run.id, { limit: ACTIVITY_EVENT_PAGE_SIZE });
        return {
          id: run.id,
          stageId: run.stageId,
          attempt: run.attempt,
          kind: run.kind,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          events: events.events,
          nextEventBefore: events.nextBefore,
        };
      }),
      nextRunBefore: page.nextBefore,
    };
  }

  issueRunEvents(issueId: string, runId: string, before?: number): IssueRunEventsViewModel | null {
    const issue = this.store.getIssue(issueId);
    const run = this.store.getRun(runId);
    if (!issue || issue.projectedState === "offboarded" || run?.issueId !== issueId) return null;
    const page = this.store.listRunEventsPage(runId, {
      ...(before === undefined ? {} : { before }),
      limit: ACTIVITY_EVENT_PAGE_SIZE,
    });
    return {
      issueId,
      runId,
      events: page.events,
      nextEventBefore: page.nextBefore,
    };
  }

  issueJourney(issueId: string): IssueJourneyViewModel | null {
    const issue = this.store.getIssue(issueId);
    if (!issue) return null;
    const repository = this.config.repositories[issue.repositoryId]
      ?? Object.values(this.config.repositories).find((candidate) =>
        candidate.address === issue.repositoryId
      );
    const pipeline = repository ? this.config.pipelines[repository.pipeline] : null;
    const stageState = this.store.getStageState(issueId);
    const cursor = this.store.executions().getCursor(issueId);
    const pending = cursor?.state === "pending";
    const activeRun = this.store.listActiveIssueRuns().find((run) => run.issueId === issueId);
    const stopped = STOPPED_ISSUE_STATES.has(issue.projectedState ?? "");
    const liveStatus = this.liveIssueStatus(issueId);
    const nowState = liveStatus?.kind ?? (pending ? "waiting" : activeRun ? "running" : stopped ? "stopped" : issue.projectedState ?? issue.sourceState);
    const nowReason = liveStatus?.reason ?? (pending
      ? this.store.executions().pendingMessage(issueId) ?? issue.warning
      : stopped ? latestStopReason(this.store, issueId) ?? issue.warning : null);
    const actorFor = (stageId: string | null): string => {
      if (!stageId) return "Conveyor · Orchestrator";
      const found = pipeline?.stages.find((candidate) => candidate.id === stageId);
      const stage = found && !isNativeStage(found) ? found : undefined;
      if (stage?.run.type === "agent") {
        const agent = this.config.agents[stage.run.agent];
        return `${agent?.name ?? displayName(stage.run.agent)} · ${agent?.title ?? "AI Agent"}`;
      }
      if (stage?.run.type === "script") return "Conveyor · Script";
      return "Conveyor · Orchestrator";
    };
    return {
      issueId,
      now: {
        stage: cursor?.stage ?? stageState?.stageId ?? issue.projectedStage,
        state: nowState,
        reason: nowReason,
        since: liveStatus?.since ?? (pending
          ? cursor.pendingSince
          : activeRun?.startedAt ?? stageState?.updatedAt ?? issue.sourceUpdatedAt),
      },
      transitions: this.store.listStageTransitions(issueId).map((transition) => ({
        id: transition.id,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
        kind: transition.kind,
        status: transition.status,
        resultStatus: transition.resultStatus,
        reason: transition.error ?? transition.reason,
        requiredFixes: transition.requiredFixes,
        actor: transition.actor
          ? `${transition.actor.name}${transition.actor.title ? ` · ${transition.actor.title}` : ""}`
          : actorFor(transition.fromStage ?? transition.toStage),
        createdAt: transition.createdAt,
        completedAt: transition.completedAt,
      })),
      findings: new ReviewFindings(this.store.sqlite()).listVisible(issueId).map((finding) => ({
        id: finding.id,
        type: finding.type,
        state: finding.state,
        author: finding.author,
        location: finding.path === null ? null : finding.line === null ? finding.path : `${finding.path}:${finding.line}`,
        url: finding.url,
        summary: finding.body.length > 240 ? `${finding.body.slice(0, 240)}…` : finding.body,
      })),
      skippedReviews: new ReviewFindings(this.store.sqlite()).skippedNative(issueId).map((review) => ({
        author: review.author,
        url: review.url,
        skippedAt: review.skippedAt,
        active: review.active,
      })),
    };
  }

  async systemStatus(): Promise<SystemStatusViewModel> {
    return collectSystemStatus({
      database: this.config.settings.database,
      artifacts: this.config.settings.artifacts,
      temporaryDirectory: tmpdir(),
      // Agent scratch paths are siblings of managed worktrees, so their capacity
      // follows the configured workspaces filesystem rather than the host TMPDIR.
      workspaceScratch: this.config.settings.workspaces,
    });
  }

  issueConversation(issueId: string): IssueConversationViewModel | null {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") return null;
    return {
      issueId,
      messages: this.store.listConversationMessages(issueId, 100).map((message) => ({
        id: message.id,
        stageId: message.stageId,
        actorType: message.actorType,
        actorId: message.actorId,
        actorName: message.actorName,
        actorAvatar: message.actorType === "user" ? this.store.dashboardAccountByUsername(message.actorName)?.avatar ?? null : null,
        actorTitle: message.actorTitle,
        message: message.message,
        createdAt: message.createdAt,
      })),
    };
  }

  async postIssueMessage(
    issueId: string,
    message: string,
    username: string,
  ): Promise<{ status: "delivered" | "started" | "queued"; stageId: string }> {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") throw new Error("issue not found");
    this.assertRepositoryActive(issue.repositoryId);
    if (issue.sourceState === "closed" && !this.store.hasMergedPullRequest(issueId)) {
      throw new Error("closed issues cannot be resumed from conversation");
    }
    if (["done", "missing", "inconsistent"].includes(issue.projectedState ?? "")) {
      throw new Error(`issue state ${issue.projectedState} cannot be resumed from conversation`);
    }
    const activeRun = this.store.listActiveIssueRuns().find((run) => run.issueId === issueId);
    const running = this.#active.has(issueId) || Boolean(activeRun);
    const question = this.store.listOpenQuestions().find((candidate) => candidate.issueId === issueId);
    const resumesQuestionRun = question !== undefined &&
      question.runId !== null &&
      this.hasResumableQuestionExecution(issueId);
    if (!running && !resumesQuestionRun && this.store.listChildren(issueId).length > 0) {
      throw new Error("roll-up parents cannot run directly; message a child issue instead");
    }
    const stageId = issue.projectedStage ?? this.store.getStageState(issueId)?.stageId ?? activeRun?.stageId ?? null;
    if (!stageId) throw new Error("issue has no unambiguous configured stage to resume");
    // Reject an invalid choice before it becomes a misleading conversation
    // entry. Human replies may use the label rendered by the form.
    const answer = question ? conversationQuestionAnswer(question, message) : null;
    const recorded = question && !running ? null : this.store.appendConversationMessage({
      issueId,
      runId: null,
      stageId,
      actorType: "user",
      actorId: username,
      actorName: username,
      actorTitle: null,
      message,
    });
    if (running) return { status: "delivered", stageId };

    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) throw new Error("issue repository is not configured");
    const pipeline = this.config.pipelines[repository.pipeline];
    if (!pipeline || !pipeline.stages.some((stage) => stage.id === stageId)) {
      throw new Error("issue has no unambiguous configured stage to resume");
    }

    if (question) {
      await this.answerQuestion(question.id, answer!, username);
    } else {
      const metadata = metadataLabels(issue.labels, this.config);
      const labels = [
        this.config.labels.enrollment,
        this.config.labels.stageTemplate.replace("{stage}", stageId),
        ...metadata,
      ];
      const mutation = this.store.beginSourceMutation({
        idempotencyKey: `conversation-resume:${recorded!.id}`,
        source: repository.source,
        operation: "issue.labels.resume",
        request: { issueId, issueNumber: issue.sourceNumber, labels },
      });
      if (mutation.status !== "succeeded") {
        try {
          await this.executionGitHub(issue.repositoryId).replaceConveyorLabels(
            repository.address,
            issue.sourceNumber,
            labels,
            [this.config.labels.metadata.noSplit],
          );
          this.store.completeSourceMutation(mutation.id, { labels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          this.store.failSourceMutation(
            mutation.id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
      const refreshed = this.store.getIssue(issueId);
      if (refreshed?.queueRank === null) this.store.setQueueRank(issueId, this.store.nextQueueRank());
      this.store.events().append("item.requeued", { reason: "message" }, { issueId });
      await this.eventsSettled();
      await this.updateStatusComment(issueId).catch((error) => {
        log.error("Status comment update failed after conversation resume", this.itemFields(issueId), error);
      });
    }

    await this.eventsSettled();
    const status = this.#active.has(issueId) ? "started" : "queued";
    this.store.appendConversationMessage({
      issueId,
      runId: null,
      stageId,
      actorType: "conveyor",
      actorId: "conveyor",
      actorName: "Conveyor",
      actorTitle: "Orchestrator",
      message: status === "started"
        ? `Started ${stageId}; your message is included in the agent handoff.`
        : `Queued ${stageId}; your message is included in the next agent handoff. Dependencies or runner capacity may delay the start.`,
    });
    return { status, stageId };
  }

  private async scheduledRetryIssue(runId: string, issueId: string, note: string, evidence: string): Promise<{ status: "started" | "queued"; stageId: string }> {
    const check = this.#scheduledOperatorChecks.get(runId);
    if (!check?.targets.has(issueId)) throw new Error("scheduled checks may retry only their stopped targets");
    if (!check.inspected.has(issueId)) throw new Error("inspect the item's history before retrying it");
    const issue = this.store.getIssue(issueId);
    const repository = issue && this.config.repositories[issue.repositoryId];
    if (!issue || !repository) throw new Error("item is not on this configured board");
    const live = await this.github.getIssue(repository.address, issue.sourceNumber);
    const recordedStop = latestStop(this.store, issueId);
    const evidenceText = evidence.trim();
    if (!evidenceText) throw new Error("scheduled retry evidence must not be blank");
    const stoppedAt = recordedStop.stoppedAt ? Date.parse(recordedStop.stoppedAt) : Number.NaN;
    if (!Number.isFinite(stoppedAt)) throw new Error("scheduled retry requires a recorded stopped attempt");
    const sourceChangedAfterStop = Date.parse(live.updatedAt) > stoppedAt;
    const sourceEvidence = sourceChangedAfterStop &&
      recordedStop.sourceSnapshot !== null &&
      [live.title, live.body].some((text) => text.includes(evidenceText)) &&
      ![recordedStop.sourceSnapshot.title, recordedStop.sourceSnapshot.body].some((text) => text.includes(evidenceText));
    const conversationEvidence = this.store.listConversationMessages(issueId).some((message) =>
      message.actorId !== "scheduled-operator" &&
      Date.parse(message.createdAt) > stoppedAt &&
      message.message.includes(evidenceText)
    );
    if (!sourceEvidence && !conversationEvidence) {
      throw new Error("scheduled retry evidence must quote source content added after the recorded stop or a non-Operator conversation recorded after it");
    }
    const outcome = await this.retryIssue(issueId, note, "Scheduled Operator", true);
    this.store.appendConversationMessage({
      issueId, runId, stageId: outcome.stageId, actorType: "conveyor", actorId: "scheduled-operator",
      actorName: "Scheduled Operator", actorTitle: "Conveyor Operator",
      message: `Scheduled retry started from evidence: ${evidenceText}`,
    });
    check.outcomes.set(issueId, {
      outcome: "retried",
      reason: `Scheduled retry ${outcome.status}.`,
      evidence: evidenceText,
    });
    return outcome;
  }

  private async scheduledAnswerQuestion(runId: string, questionId: string, answer: string, evidence: string): Promise<void> {
    const question = this.store.getQuestion(questionId);
    if (!question) throw new Error("question not found");
    const check = this.#scheduledOperatorChecks.get(runId);
    if (!check?.targets.has(question.issueId)) throw new Error("scheduled checks may answer only questions for their stopped targets");
    if (!check.inspected.has(question.issueId)) throw new Error("inspect the item's history before answering it");
    const issue = this.store.getIssue(question.issueId);
    const repository = issue && this.config.repositories[issue.repositoryId];
    if (!issue || !repository || issue.projectedState === "offboarded") throw new Error("question belongs to an ineligible board item");
    let evidenceText: string | undefined;
    try {
      const live = await this.github.getIssue(repository.address, issue.sourceNumber);
      evidenceText = evidence.trim();
      if (!evidenceText) throw new Error("scheduled answer evidence must not be blank");
      const sources = [live.title, live.body, ...criteriaOf(live.body).map((criterion) => criterion.text), ...this.store.listConversationMessages(issue.id).map((message) => message.message)];
      if (!sources.some((text) => text.includes(evidenceText!))) {
        throw new Error("scheduled answers require an unambiguous quote from current issue content, acceptance criteria, or recorded conversation");
      }
      const response = scheduledQuestionAnswerEvidence(question, answer, evidenceText, sources);
      await this.answerQuestion(questionId, response, `scheduled-operator:${runId}`, evidenceText);
      this.store.appendRunEvent(runId, "operator.answer", { questionId, issueId: issue.id, evidence: evidenceText });
      check.outcomes.set(issue.id, {
        outcome: "answered",
        reason: `Answered question ${questionId} from recorded evidence.`,
        evidence: evidenceText,
      });
    } catch (error) {
      check.outcomes.set(issue.id, {
        outcome: "unresolved",
        reason: error instanceof Error ? error.message : String(error),
        ...(evidenceText ? { evidence: evidenceText } : {}),
      });
      throw error;
    }
  }

  private reportScheduledOutcome(runId: string, issueId: string, reason: string): void {
    const check = this.#scheduledOperatorChecks.get(runId);
    if (!check?.targets.has(issueId)) throw new Error("scheduled checks may report only their stopped targets");
    if (!check.inspected.has(issueId)) throw new Error("inspect the item's history before reporting its outcome");
    if (check.outcomes.has(issueId)) throw new Error("scheduled outcome is already recorded for this target");
    const message = reason.trim();
    if (!message) throw new Error("scheduled outcome reason must not be blank");
    check.outcomes.set(issueId, { outcome: "unresolved", reason: message });
  }

  private hasLiveIssueRun(issueId: string): boolean {
    return this.#active.has(issueId) || this.store.listActiveIssueRuns().some((run) => run.issueId === issueId);
  }

  /** Whether this stage's agent is allowed to create children. */
  private stageCreatesChildren(repositoryId: string, stageId: string | null): boolean {
    if (!stageId) return false;
    const repository = this.config.repositories[repositoryId];
    const stage = repository && this.config.pipelines[repository.pipeline]?.stages.find((candidate) => candidate.id === stageId);
    if (!stage) return false;
    const agentIds = isNativeStage(stage)
      ? stage.actions.flatMap((task) => task.task !== "agent.run" ? [] : [
        ...(typeof task.with?.agent === "string" ? [task.with.agent] : []),
        ...(Array.isArray(task.with?.agents) ? task.with.agents.filter((agent): agent is string => typeof agent === "string") : []),
      ])
      : "run" in stage && stage.run?.type === "agent" ? [stage.run.agent] : [];
    return agentIds.some((agentId) => this.config.agents[agentId]?.tasks.some((task) =>
      task === "item.createChild" || task === "breakdown.createChildren",
    ));
  }

  private childCreationStageIsReady(issue: StoredIssue): boolean {
    return issue.projectedState === "active" &&
      this.childCreationRetryQueued(issue, issue.projectedStage);
  }

  /** Only an explicit retry may schedule a parent that already has children. */
  private childCreationRetryQueued(issue: StoredIssue, stageId: string | null): boolean {
    return this.stageCreatesChildren(issue.repositoryId, stageId) &&
      this.store.getStageState(issue.id)?.status === "retry-ready";
  }

  private retryableStoppedIssue(issue: StoredIssue, children: number, running: boolean): boolean {
    return (issue.sourceState === "open" ||
      (issue.sourceState === "closed" && this.store.hasMergedPullRequest(issue.id))) &&
      issue.labels.includes(this.config.labels.enrollment) &&
      issue.projectedStage !== null &&
      ["blocked", "error", "needs-intervention"].includes(issue.projectedState ?? "") &&
      !running && (children === 0 || this.stageCreatesChildren(issue.repositoryId, issue.projectedStage));
  }

  /** Whether Conveyor's recorded pause can safely restore enrollment for an open item. */
  private resumablePausedIssue(issue: StoredIssue, running: boolean): boolean {
    return issue.sourceState === "open" && issue.projectedState === "paused" && issue.pausedByConveyor &&
      !issue.labels.includes(this.config.labels.enrollment) && !running;
  }

  private resumableRollupIssue(issue: StoredIssue, children: number, running: boolean, hasOpenQuestion: boolean): boolean {
    return issue.sourceState === "open" &&
      issue.labels.includes(this.config.labels.enrollment) &&
      issue.projectedStage !== null &&
      ["blocked", "error", "needs-intervention"].includes(issue.projectedState ?? "") &&
      !running && children > 0 && !this.stageCreatesChildren(issue.repositoryId, issue.projectedStage) && !hasOpenQuestion;
  }

  /** Whether the stored state permits a stage retry before the command verifies the source snapshot. */
  canRetryIssue(issueId: string): boolean {
    const issue = this.store.getIssue(issueId);
    return issue !== null && this.retryableStoppedIssue(
      issue,
      this.store.listChildren(issueId).length,
      this.hasLiveIssueRun(issueId),
    );
  }

  /** Whether the stored state permits resuming a stopped parent before the command verifies the source snapshot. */
  canResumeRollupParent(issueId: string): boolean {
    const issue = this.store.getIssue(issueId);
    return issue !== null && this.resumableRollupIssue(
      issue,
      this.store.listChildren(issueId).length,
      this.hasLiveIssueRun(issueId),
      this.store.listOpenQuestions().some((question) => question.issueId === issueId),
    );
  }

  async resumeRollupParent(issueId: string): Promise<{ stageId: string }> {
    if (this.#resumingRollups.has(issueId)) throw new Error("resume waiting for children is already in progress");
    this.#resumingRollups.add(issueId);
    try {
      const issue = this.store.getIssue(issueId);
      const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
      if (!issue || !repository || issue.projectedState === "offboarded") throw new Error("issue not found");
      this.assertRepositoryActive(issue.repositoryId);
      if (!this.canResumeRollupParent(issueId)) {
        throw new Error("roll-up parent is not eligible to resume waiting for children");
      }
      const pipeline = this.config.pipelines[repository.pipeline];
      if (!pipeline) throw new Error("issue pipeline is not configured");

      const stopMutationKeyPrefix = `rollup-resume:${issue.id}:`;
      const priorMutation = this.store.getLatestSourceMutationByKeyPrefix(stopMutationKeyPrefix);
      const stopLabels = Object.entries(this.config.labels.states)
        .flatMap(([state, label]) => state === "done" ? [] : [label]);
      const live = await this.github.getIssue(repository.address, issue.sourceNumber);
      const sourceAlreadyResumed = live.number === issue.sourceNumber &&
        live.state === "open" &&
        live.labels.includes(this.config.labels.enrollment) &&
        !live.labels.some((label) => stopLabels.includes(label));
      if (sourceAlreadyResumed && priorMutation) {
        // GitHub can apply the label replacement before a lost response. Its
        // current labels are the authoritative proof that the planned resume completed.
        if (priorMutation.status !== "succeeded") {
          this.store.completeSourceMutation(priorMutation.id, { labels: live.labels });
        }
        await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
        return { stageId: issue.projectedStage ?? "" };
      }

      const evaluated = evaluateIssueState({
        sourceState: live.state,
        sourceLabels: live.labels,
        labels: this.config.labels,
        stages: pipeline.stages.map((stage) => stage.id),
        expectedPostMergeClosure: false,
      });
      const resumableStates = new Set(["blocked", "error", "needs-intervention"]);
      if (live.number !== issue.sourceNumber || live.state !== "open" || evaluated.mode !== "stopped" ||
        !evaluated.state || !resumableStates.has(evaluated.state) || !evaluated.stage ||
        evaluated.state !== issue.projectedState || evaluated.stage !== issue.projectedStage ||
        !this.canResumeRollupParent(issueId)) {
        throw new Error("roll-up parent state changed or is not eligible; refresh before resuming waiting for children");
      }
      // The local relationship projection can lag a user unlinking every child.
      // Read GitHub at the mutation boundary so a stale action cannot resume a non-parent.
      if ((await this.github.listSubIssues(repository.address, issue.sourceNumber)).length === 0) {
        throw new Error("roll-up parent no longer has children; refresh before resuming waiting for children");
      }

      const stageId = evaluated.stage;
      const conveyorLabels = live.labels.filter((label) =>
        (label === this.config.settings.labelPrefix ||
          label.startsWith(`${this.config.settings.labelPrefix}:`) ||
          label === this.config.labels.metadata.noSplit) &&
        label !== this.config.labels.states[evaluated.state!],
      );
      const digest = createHash("sha256")
        .update(`${issue.id}\0${live.updatedAt}\0${[...live.labels].sort().join("\0")}`)
        .digest("hex")
        .slice(0, 24);
      const mutation = this.store.beginSourceMutation({
        idempotencyKey: `${stopMutationKeyPrefix}${digest}`,
        source: repository.source,
        operation: "issue.labels.resume-rollup",
        request: { issueId, issueNumber: issue.sourceNumber, stoppedState: evaluated.state, stageId, labels: conveyorLabels },
      });
      if (mutation.status !== "succeeded") {
        try {
          await this.executionGitHub(issue.repositoryId).replaceConveyorLabels(
            repository.address,
            issue.sourceNumber,
            conveyorLabels,
            [this.config.labels.metadata.noSplit],
          );
          this.store.completeSourceMutation(mutation.id, { labels: conveyorLabels });
        } catch (error) {
          if (error instanceof RepositoryPausedError) throw error;
          const observed = await this.github.getIssue(repository.address, issue.sourceNumber).catch(() => null);
          if (observed?.state === "open" && observed.labels.includes(this.config.labels.enrollment) &&
            !observed.labels.some((label) => stopLabels.includes(label))) {
            this.store.completeSourceMutation(mutation.id, { labels: observed.labels });
          } else {
            this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
            throw error;
          }
        }
      }
      await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
      return { stageId };
    } finally {
      this.#resumingRollups.delete(issueId);
    }
  }

  async retryIssue(issueId: string, note: string, username: string, automated = false): Promise<{ status: "started" | "queued"; stageId: string }> {
    if (this.#retrying.has(issueId)) throw new Error("retry already in progress");
    this.#retrying.add(issueId);
    try {
      const issue = this.store.getIssue(issueId);
      const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
      if (!issue || !repository || issue.projectedState === "offboarded") throw new Error("issue not found");
      this.assertRepositoryActive(issue.repositoryId);
      if (note.length > 4_000) throw new Error("retry note must not exceed 4000 characters");
      const expectedPostMergeClosure = this.store.hasMergedPullRequest(issueId);
      if ((issue.sourceState !== "open" && !(issue.sourceState === "closed" && expectedPostMergeClosure)) ||
        !issue.labels.includes(this.config.labels.enrollment)) {
        throw new Error("issue is closed or offboarded");
      }
      if (this.hasLiveIssueRun(issueId)) {
        throw new Error("issue is already running");
      }
      const pipeline = this.config.pipelines[repository.pipeline];
      if (!pipeline) throw new Error("issue pipeline is not configured");
      const live = await this.github.getIssue(repository.address, issue.sourceNumber);
      const evaluated = evaluateIssueState({
        sourceState: live.state,
        sourceLabels: live.labels,
        labels: this.config.labels,
        stages: pipeline.stages.map((stage) => stage.id),
        expectedPostMergeClosure,
      });
      const stoppedStates = new Set(["blocked", "error", "needs-intervention"]);
      if (live.number !== issue.sourceNumber ||
        (live.state !== "open" && !(live.state === "closed" && expectedPostMergeClosure)) || evaluated.mode !== "stopped" ||
        !evaluated.state || !stoppedStates.has(evaluated.state) || !evaluated.stage ||
        evaluated.state !== issue.projectedState || evaluated.stage !== issue.projectedStage ||
        !this.canRetryIssue(issueId)) {
        throw new Error("issue state changed or is inconsistent; refresh before retrying");
      }

      const stageId = evaluated.stage;
      const mutation = this.store.beginSourceMutation({
        idempotencyKey: `web-retry:${randomUUID()}`,
        source: repository.source,
        operation: "issue.labels.retry",
        request: { issueId, issueNumber: issue.sourceNumber, stoppedState: evaluated.state, stageId },
      });
      const conveyorLabels = live.labels.filter((label) =>
        (label === this.config.settings.labelPrefix ||
          label.startsWith(`${this.config.settings.labelPrefix}:`) ||
          label === this.config.labels.metadata.noSplit) &&
        label !== this.config.labels.states[evaluated.state!],
      );
      try {
        await this.executionGitHub(issue.repositoryId).replaceConveyorLabels(
          repository.address,
          issue.sourceNumber,
          conveyorLabels,
          [this.config.labels.metadata.noSplit],
        );
        this.store.completeSourceMutation(mutation.id, { labels: conveyorLabels });
      } catch (error) {
        if (error instanceof RepositoryPausedError) throw error;
        this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
        throw error;
      }

      // Reconciliation runs the roll-up pass. Keep the durable retry marker in
      // place before it observes the cleared stop label, or it can advance this
      // parent to an unfinished child's later stage instead of retrying child
      // creation.
      if (this.store.listChildren(issueId).length > 0 && this.stageCreatesChildren(issue.repositoryId, stageId)) {
        const stage = this.store.getStageState(issueId);
        if (stage?.stageId === stageId) {
          this.store.setStageState({ ...stage, status: "retry-ready", configHash: this.config.hash });
        }
      }

      // A retry is a deliberate fresh attempt, so only failures observed after it may form a repeat.
      this.store.executions().resetCiFailureWindow(issueId);

      if (note.trim()) {
        this.store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: automated ? "conveyor" : "user", actorId: automated ? "scheduled-operator" : username,
          actorName: username, actorTitle: automated ? "Conveyor Operator" : null, message: note.trim(),
        });
      }
      await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
      const refreshed = this.store.getIssue(issueId);
      if (refreshed?.queueRank === null) this.store.setQueueRank(issueId, this.store.nextQueueRank());
      this.store.events().append("item.requeued", { reason: "retry" }, { issueId });
      await this.eventsSettled();
      const status = this.#active.has(issueId) ? "started" : "queued";
      this.store.appendConversationMessage({
        issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
        actorName: "Conveyor", actorTitle: "Orchestrator",
        message: status === "started" ? `Started ${stageId} after retry.` : `Queued ${stageId} after retry. The existing worktree and run history are retained.`,
      });
      return { status, stageId };
    } finally {
      this.#retrying.delete(issueId);
    }
  }

  /** Reconciled at least once, not stopping, and every repository onboarded and reconciling. */
  isReady(): boolean {
    return Boolean(this.#lastReconciledAt) && !this.#shuttingDown &&
      (!this.#startupStarted || this.#startupCompleted) && !this.#startupRunning &&
      !this.#startupFailed &&
      this.#repositoryErrors.size === 0 && this.#onboardingErrors.size === 0;
  }

  /** Stops admitting new work; running work continues. Idempotent: the first reason is kept. */
  drain(reason: string, upgrade: { targetVersion: string; releaseTag: string } | null = null): { since: string; reason: string } {
    if (!this.#drain) {
      this.#drain = { since: new Date().toISOString(), reason, upgrade };
      this.store.events().append("admission.paused", {});
      log.info("Admission paused: draining", { reason });
      for (const [issueId, active] of this.#active) {
        log.info("Stage waiting during drain", { ...this.itemFields(issueId), stage: active.stageId });
      }
    }
    return { since: this.#drain.since, reason: this.#drain.reason };
  }

  /** Admits new work again after a drain; false when no drain was in effect. */
  resumeAdmission(): boolean {
    if (!this.#drain) return false;
    this.#drain = null;
    this.store.events().append("admission.resumed", {});
    log.info("Admission resumed");
    this.schedule();
    return true;
  }

  draining(): { since: string; reason: string } | null {
    return this.#drain ? { since: this.#drain.since, reason: this.#drain.reason } : null;
  }

  /** Rejects an operation that would admit work or mutate the paused repository's source. */
  private assertRepositoryActive(repositoryId: string): void {
    if (this.store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
  }

  /** Work in flight: items executing a stage, and steering runs. */
  activeWork(): { items: Array<{ issueId: string; repositoryId: string; stageId: string }>; steering: number } {
    return {
      items: [...this.#active.entries()].map(([issueId, active]) => ({ issueId, repositoryId: active.repositoryId, stageId: active.stageId })),
      steering: this.#steeringActive.size,
    };
  }

  /** Pauses future repository work without changing its configured plan or any item projection. */
  pauseRepository(repositoryId: string, reason: string, actor: string): { pausedAt: string } {
    if (!this.config.repositories[repositoryId]) throw new Error("repository not found");
    const pause = this.store.pauseRepository(repositoryId, actor, reason.trim() || null);
    log.info("Repository paused", { repository: repositoryId, actor });
    return { pausedAt: pause.pausedAt };
  }

  /** Re-admits retained work without changing individual item enrollment. */
  async resumeRepository(repositoryId: string): Promise<{ resumedAt: string }> {
    if (!this.config.repositories[repositoryId]) throw new Error("repository not found");
    this.store.resumeRepository(repositoryId);
    const resumedAt = new Date().toISOString();
    // A paused cleanup has already recorded its source-mutation intent. Retry it immediately
    // after the write fence lifts instead of making a just-closed item wait for the hourly pass.
    await withGitHubCallSource("command", async () => {
      for (const issue of this.store.listRecoveryCandidates(repositoryId, resumedAt)) {
        await this.recoverClosedItem(repositoryId, issue);
      }
    });
    this.schedule();
    log.info("Repository resumed", { repository: repositoryId });
    return { resumedAt };
  }

  /**
   * Pauses an item the way the source does: removes only its enrollment label, so Conveyor stops
   * scheduling it and interrupts its running stage; its stage, worktree and history are kept.
   */
  async pauseIssue(issueId: string, actor: string): Promise<{ stageId: string | null }> {
    const { issue, repository, live } = await this.liveEnrolledIssue(issueId);
    if (!live.labels.includes(this.config.labels.enrollment)) throw new Error("the item is already paused");
    const labels = this.conveyorLabels(live.labels).filter((label) => label !== this.config.labels.enrollment);
    // Recorded before the write: the webhook of the removal can reconcile before this call returns.
    const keepsMarker = labels.length === 0;
    if (keepsMarker) this.store.setPausedByConveyor(issueId, true);
    try {
      await this.replaceLabelsRecorded(issue, repository, "issue.labels.pause", labels);
    } catch (error) {
      if (keepsMarker) this.store.setPausedByConveyor(issueId, false);
      throw error;
    }
    await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
    this.interruptIneligibleRuns();
    this.store.appendConversationMessage({
      issueId, runId: null, stageId: issue.projectedStage, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: `Paused by ${actor}. Its stage, worktree and history are kept.`,
    });
    log.info("Item paused", { ...this.itemFields(issueId), stage: issue.projectedStage ?? undefined, actor });
    return { stageId: issue.projectedStage };
  }

  /** Resumes a paused item by restoring its enrollment label; reports whether its stage started or queued. */
  async resumeIssue(issueId: string, actor: string): Promise<{ status: "started" | "queued"; stageId: string | null }> {
    const { issue, repository, live } = await this.liveEnrolledIssue(issueId);
    if (live.labels.includes(this.config.labels.enrollment)) throw new Error("the item is not paused");
    const labels = [...this.conveyorLabels(live.labels), this.config.labels.enrollment];
    await this.replaceLabelsRecorded(issue, repository, "issue.labels.resume", labels);
    await this.reconcileRepository(issue.repositoryId, { only: [issue.sourceNumber] });
    this.store.events().append("item.requeued", { reason: "resume" }, { issueId });
    await this.eventsSettled();
    const refreshed = this.store.getIssue(issueId);
    const status = this.#active.has(issueId) ? "started" : "queued";
    this.store.appendConversationMessage({
      issueId, runId: null, stageId: refreshed?.projectedStage ?? null, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: `Resumed by ${actor}; ${status === "started" ? "its stage started" : "its stage is queued"}.`,
    });
    log.info("Item resumed", { ...this.itemFields(issueId), stage: refreshed?.projectedStage ?? undefined, actor, status });
    return { status, stageId: refreshed?.projectedStage ?? null };
  }

  /** An open item known to Conveyor (enrolled or paused), with its live source state. */
  private async liveEnrolledIssue(issueId: string) {
    const issue = this.store.getIssue(issueId);
    const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
    if (!issue || !repository || issue.projectedState === "offboarded") throw new Error("item not found");
    this.assertRepositoryActive(issue.repositoryId);
    const live = await this.github.getIssue(repository.address, issue.sourceNumber);
    if (live.state !== "open") throw new Error("the item is closed");
    if (this.conveyorLabels(live.labels).length === 0 && !issue.pausedByConveyor) throw new Error("the item is offboarded (it has no Conveyor labels)");
    return { issue, repository, live };
  }

  private conveyorLabels(labels: readonly string[]): string[] {
    const prefix = this.config.settings.labelPrefix;
    return labels.filter((label) =>
      label === prefix || label.startsWith(`${prefix}:`) || label === this.config.labels.metadata.noSplit,
    );
  }

  private async replaceLabelsRecorded(issue: StoredIssue, repository: ConveyorConfig["repositories"][string], operation: string, labels: string[]): Promise<void> {
    this.assertRepositoryActive(issue.repositoryId);
    const mutation = this.store.beginSourceMutation({
      idempotencyKey: `${operation}:${randomUUID()}`,
      source: repository.source,
      operation,
      request: { issueId: issue.id, issueNumber: issue.sourceNumber, labels },
    });
    try {
      await this.executionGitHub(issue.repositoryId).replaceConveyorLabels(
        repository.address,
        issue.sourceNumber,
        labels,
        [this.config.labels.metadata.noSplit],
      );
      this.store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** An operator's dismissal of a review finding: the dispatcher runs `change.dismissFinding` as that human, never an agent. */
  async dismissFinding(issueId: string, findingId: string, reason: string, username: string): Promise<void> {
    const issue = this.store.getIssue(issueId);
    const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
    if (!issue || !repository) throw new Error("issue not found");
    const actor = { id: `human:${username}`, name: username, title: "Operator" };
    await dispatchTool({
      name: "change.dismissFinding",
      input: { findingId, reason },
      actor,
      grant: { runId: `web:${username}`, stageId: issue.projectedStage ?? "", issueScoped: true, actor, tasks: new Set(["change.dismissFinding"]) },
    }, {
      registry: createTaskRegistry(),
      deps: () => this.taskDeps(issue.id, { id: issue.repositoryId, address: repository.address, folder: repository.folder, baseBranch: repository.baseBranch }),
      liveHeadSha: async () => null,
      store: this.store,
    });
    // The finding.changed event wakes an item parked on its review gate.
    await this.updateStatusComment(issue.id);
  }

  /** An operator's change of a finding's type; the write, its history row and its event share one transaction. */
  reclassifyFinding(issueId: string, findingId: string, type: FindingType, username: string): { changed: boolean } {
    return { changed: new ReviewFindings(this.store.sqlite()).reclassify(issueId, findingId, type, username) };
  }

  webDependencies(auth: WebAuthApi, username: string, push: PushConfiguration | null = null): WebHandlerDependencies {
    const githubSource = Object.values(this.config.sources).find((source) => source.type === "github");
    return {
      auth,
      username,
      listAccounts: () => this.store.dashboardAccounts().map(({ id, username, role, avatar }) => ({ id, username, role, avatar })),
      getAccount: (id) => this.store.dashboardAccountById(id),
      getPushPreferences: (id) => this.store.getPushPreferences(id),
      pushPublicKey: push?.publicKey ?? null,
      dispatchPushEvents: () => deliverPushEvents(this.store, async (issueId) => {
        const target = this.store.getIssue(issueId);
        return target && target.projectedState !== "offboarded"
          ? `/issues/${encodeURIComponent(target.repositoryId)}/${target.sourceNumber}`
          : null;
      }, push),
      dispatch: (name, input, actor) => this.commands.dispatch(name, input, actor),
      recordSession: (change, accountId) => withEventContext({ actor: { kind: "user", id: accountId } }, () =>
        this.store.events().append(change === "signedIn" ? "session.signedIn" : "session.signedOut", { accountId })),
      getIssueDetails: (issueId) => this.issueDetails("", issueId),
      getDashboardSnapshot: () => this.#dashboardFeed.snapshot(),
      subscribeDashboardFeed: (listener, after) => this.#dashboardFeed.subscribe(listener, after),
      getDashboardFeedStatus: () => this.#dashboardFeed.status,
      getRecentActivity: (selection) => this.recentActivityPage(selection),
      getSteeringView: (runId) => this.steeringView(runId),
      getDashboardDone: ({ limit, q, repositoryIds }) => Object.values(normalizeDashboard(this.dashboard("", { ...DASHBOARD_SNAPSHOT_SELECTION, doneLimit: limit, q, repositoryIds: [...repositoryIds] })).items)
        .filter((item) => item.placement === "done")
        .sort((left, right) => left.order - right.order),
      isReady: () => this.isReady(),
      webhookPath: githubSource?.webhookPath ?? "/hooks/github",
      handleWebhook: (body, headers) => this.handleWebhook(body, headers),
      handleMcp: (body, token, callId) => this.handleMcp(body, token, callId),
      getSteeringRun: (runId) => this.getSteeringRun(runId),
      getSteeringEvents: (runId, after) => this.getSteeringEvents(runId, after),
      getIssueActivity: (issueId, before) => this.issueActivity(issueId, before),
      getIssueRunEvents: (issueId, runId, before) => this.issueRunEvents(issueId, runId, before),
      getIssueConversation: (issueId) => this.issueConversation(issueId),
      getIssueJourney: (issueId) => this.issueJourney(issueId),
      getIssueRoute: (reference) => {
        const issue = "id" in reference
          ? this.store.getIssue(reference.id)
          : this.store.listIssues(reference.repository).find((candidate) => candidate.sourceNumber === reference.number) ?? null;
        if (!issue) return null;
        return { id: issue.id, repository: issue.repositoryId, number: issue.sourceNumber };
      },
      getAgentProfiles: () => buildAgentProfiles(this.config),
      getReport: ({ period, repository }) => (repository !== null && !this.config.repositories[repository]
        ? null
        : buildReport({ store: this.store, config: this.config, period, repository })),
      getAgentProfile: async (agentId) =>
        (await buildAgentProfiles(this.config)).find((profile) => profile.id === agentId) ?? null,
    };
  }

  seedDashboardSuperuser(username: string, passwordHash: string): void {
    this.store.seedDashboardSuperuser(username, passwordHash);
  }

  dashboardAccountById(id: string) {
    return this.store.dashboardAccountById(id);
  }

  dashboardAccountByUsername(username: string) {
    return this.store.dashboardAccountByUsername(username);
  }
}

function todosView(items: readonly TodoItem[]): IssueTodosViewModel | null {
  const summary = summarizeTodos(items);
  return summary ? { ...summary, items } : null;
}
