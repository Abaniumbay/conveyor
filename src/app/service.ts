import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { freemem, homedir, totalmem, uptime } from "node:os";
import path from "node:path";

import { redactSecrets } from "../config/compose";
import { INTERNAL, selfCommand } from "../self";
import { log, type LogFields } from "../log/logger";
import { applyRetention, type RetentionPolicy, type RetentionReport } from "./retention";
import type { StageOutcome } from "../engine/stage-executor";
import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import { reconcileRepository } from "../core/reconciler";
import { evaluateIssueState } from "../core/issue-state";
import { capacityBlockers, selectRunnableIssues, type ConcurrencyLimits, type SchedulerCandidate, type SchedulerOccupant } from "../core/scheduler";
import { applyRollupTransition, applyStageTransition } from "../core/transition";
import { ConveyorStore, type StoredIssue } from "../db/store";
import { claudeCodeHarness } from "../harness/claude-code";
import { codexHarness } from "../harness/codex";
import type { Harness } from "../harness/types";
import { GitHubAdapter, verifyGitHubSignature } from "../source/github/adapter";
import { GitHubActionsCiProvider, focusGitHubActionsLog, parseGitHubActionsTriggers } from "../source/github/ci-provider";
import type { CiChange, CiProvider, CiRun } from "./ci-provider";
import { CodeHostRegistry } from "../codehost/registry";
import type { CodeHost } from "../codehost/types";
import { changeAction, pushAndEnsureChange } from "../codehost/actions";
import { renderStatusComment } from "../source/github/status-comment";
import { canonicalToolName } from "../tasks/aliases";
import { conveyorToolGuidance } from "../mcp/guidance";
import { dispatchTool } from "../tasks/dispatch";
import { runCodexSteering, type CodexSteeringInput } from "../runner/codex-steering";
import { WorkspaceManager } from "../workspace/manager";
import { formatDuration, formatUsage } from "../web/format";
import type { DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRelationViewModel, IssueRunEventsViewModel, IndicatorViewModel, IssueTodosViewModel, IssueTone, IssueWaitingViewModel, QuestionViewModel, StageActorViewModel, StageColumnViewModel, SystemStatusViewModel } from "../web/types";
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
import { criteriaFromBody } from "../tasks/item";
import { compilePipeline } from "../tasks/plan";
import { cliGit } from "../workspace/git";
import { removeWorkspace } from "../workspace/lifecycle";
import { AdvisoryCiWatches } from "../engine/advisory-ci";
import { ItemTodos, summarizeTodos, type TodoItem } from "../engine/todos";
import { buildReport } from "./reports";
import { CI_INDICATOR_ID, indicatorView, observeCi, observeCiError, startCiForHead, type StoredIndicator } from "./indicators";
import { createCiGateMemory, evaluateCiGate, parseCiGateOptions, type SourceActionOutcome } from "./ci-gate";

interface ActiveRun {
  repositoryId: string;
  stageId: string;
  controller: AbortController;
  /** Runs no runner process; excluded from global and repository permits. */
  lightweight: boolean;
}

type LiveIssueStatus = IssueWaitingViewModel & { kind: "waiting" | "queued" };

interface McpGrant {
  runId: string;
  stageId: string;
  context: RuntimeIssueContext | null;
  allowedTools: Set<string>;
  actor: { id: string; name: string; title: string } | null;
}

interface ServiceImplementations {
  steering?: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;
  codeHosts?: CodeHostRegistry;
  /** Agent harnesses by runner type; defaults to Codex. */
  harnesses?: Record<string, Harness>;
}

const SOURCE_GUIDANCE = `GitHub is the source of truth. Use only Conveyor MCP tools for source mutations. Never close an issue. Preserve human-authored body text, use managed sections for acceptance criteria and dependencies, and report blockers with a concrete reason.`;
const DASHBOARD_PAGE_SIZE = 20;
const ACTIVITY_RUN_PAGE_SIZE = 1;
const ACTIVITY_EVENT_PAGE_SIZE = 5;
const STOPPED_ISSUE_STATES = new Set(["blocked", "error", "needs-input", "needs-intervention", "rejected"]);

function resultReason(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const direct = (value as { reason?: unknown }).reason;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = (value as { stageResult?: unknown }).stageResult;
  return nested === value ? null : resultReason(nested);
}

/** The durable stop reason survives after the transient issue warning is cleared. */
function latestStopReason(store: ConveyorStore, issueId: string): string | null {
  const latestTransition = [...store.listStageTransitions(issueId)].reverse().find(
    (candidate) => candidate.status === "completed",
  );
  if (latestTransition) {
    return latestTransition.kind === "stopped" ? latestTransition.reason : null;
  }
  return resultReason(store.listIssueRuns(issueId)[0]?.result);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
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
    ...repository.systemLabels.map((name) => ({
      name,
      color: "64748b",
      description: "Project system area",
    })),
  ];
  return [...new Map(labels.map((label) => [label.name, label])).values()];
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
  readonly #statusCommentUpdates = new Set<Promise<void>>();
  readonly #retrying = new Set<string>();
  readonly #steeringActive = new Map<string, AbortController>();
  readonly #mcpGrants = new Map<string, McpGrant>();
  /** Consecutive infrastructure failures per issue, for the stage they happened in. */
  readonly #infrastructureFailures = new Map<string, {
    stageId: string;
    count: number;
    waiting?: IssueWaitingViewModel;
  }>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
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
  #drain: { since: string; reason: string } | null = null;
  #retentionTimer: ReturnType<typeof setInterval> | null = null;
  readonly #harnesses: Record<string, Harness>;
  readonly #runSteering: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;

  constructor(
    readonly config: ConveyorConfig,
    store: ConveyorStore,
    github: GitHubAdapter,
    implementations: ServiceImplementations = {},
  ) {
    this.store = store;
    this.github = github;
    this.#codeHosts = implementations.codeHosts ?? new CodeHostRegistry();
    this.workspaceManager = new WorkspaceManager(config.settings.workspaces);
    this.#runSteering = implementations.steering ?? runCodexSteering;
    this.#harnesses = implementations.harnesses ?? { codex: codexHarness, "claude-code": claudeCodeHarness };
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
    });
  }

  static async create(
    config: ConveyorConfig,
    github: GitHubAdapter,
    codeHosts: CodeHostRegistry,
  ): Promise<ConveyorService> {
    await ensureRuntimeDirectories(config);
    const store = await ConveyorStore.open(config.settings.database);
    const recovered = store.recoverInterruptedExecutions(config.hash);
    if (recovered.runs > 0 || recovered.stages > 0) {
      log.warn("Recovered interrupted work after restart", { runs: recovered.runs, stages: recovered.stages });
    }
    const removedRepositories = store.removeRepositoriesExcept(Object.keys(config.repositories));
    if (removedRepositories.length > 0) {
      log.info("Removed unconfigured repositories from the local index", { repositories: removedRepositories });
    }
    // The snapshot is history, not a credential store: values that came from !secret are redacted.
    store.recordConfigSnapshot(config.hash, redactSecrets(config, config.secrets ?? []));
    const service = new ConveyorService(
      config,
      store,
      github,
      { codeHosts },
    );
    await service.onboardRepositories();
    await service.reconcileAll();
    return service;
  }

  async onboardRepositories(): Promise<void> {
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      this.store.upsertRepository({
        id,
        configName: id,
        source: repository.source,
        address: repository.address,
        folder: repository.folder,
        configHash: this.config.hash,
      });
      try {
        await this.github.ensureLabels(repository.address, labelDefinitions(this.config, id));
        const source = this.config.sources[repository.source];
        if (
          source?.type === "github" &&
          source.autoConfigureWebhook &&
          this.config.web.publicUrl
        ) {
          const secret = this.webhookSecretFor(repository.source);
          if (!secret) throw new Error("a webhook secret is required for webhooks: set webhookSecret on the GitHub items provider (or CONVEYOR_GITHUB_WEBHOOK_SECRET)");
          const url = new URL(source.webhookPath, this.config.web.publicUrl).href;
          await this.github.ensureWebhook({ address: repository.address, url, secret });
        }
        this.#onboardingErrors.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#onboardingErrors.set(id, message);
        log.error("Repository onboarding failed", { repository: id }, error);
      }
    }
  }

  async reconcileAll(): Promise<void> {
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      const pipeline = this.config.pipelines[repository.pipeline]!;
      try {
        await reconcileRepository({
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
          source: this.github,
          expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
        });
        await this.reconcileRelationships(id, repository.address);
        this.restorePendingStatus(id);
        this.#repositoryErrors.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#repositoryErrors.set(id, message);
        log.error("Repository reconciliation failed", { repository: id }, error);
      }
    }
    this.#lastReconciledAt = new Date().toISOString();
    this.interruptIneligibleRuns();
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.config.settings.reconcileIntervalMs);
    const { retention } = this.config.settings;
    if (retention.runHistoryMs !== null || retention.artifactsMs !== null) {
      const prune = () => void this.applyRetention().catch((error: unknown) => log.error("Retention failed", {}, error));
      prune();
      this.#retentionTimer = setInterval(prune, 24 * 60 * 60_000);
    }
  }

  /** Prunes finished work past the retention policy (the configured one by default). */
  async applyRetention(options: { dryRun?: boolean; policy?: RetentionPolicy } = {}): Promise<RetentionReport> {
    const report = await applyRetention({
      store: this.store,
      artifacts: this.config.settings.artifacts,
      policy: options.policy ?? this.config.settings.retention,
      dryRun: options.dryRun === true,
    });
    if (!report.dryRun && (report.runHistory.events > 0 || report.artifacts.directories > 0)) {
      log.info("Pruned finished work past retention", { runs: report.runHistory.runs, events: report.runHistory.events, artifactDirectories: report.artifacts.directories, bytes: report.artifacts.bytes });
    }
    return report;
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#retentionTimer) clearInterval(this.#retentionTimer);
    this.#retentionTimer = null;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
    if (this.#advisoryTimer) clearTimeout(this.#advisoryTimer);
    this.#advisoryTimer = null;
    for (const active of this.#active.values()) active.controller.abort();
    for (const controller of this.#steeringActive.values()) controller.abort();
    // An in-flight reconcile or advisory-CI poll still uses the database; let it finish first.
    while (this.#active.size > 0 || this.#steeringActive.size > 0 || this.#statusCommentUpdates.size > 0 || this.#tickRunning || this.#advisoryPolling) {
      await Bun.sleep(25);
    }
    this.store.close();
  }

  async tick(): Promise<void> {
    if (this.#shuttingDown || this.#tickRunning) return;
    this.#tickRunning = true;
    try {
      await this.reconcileAll();
      this.schedule();
    } finally {
      this.#tickRunning = false;
    }
    // Not awaited: a slow CI provider must not stall reconcile and scheduling.
    void this.pollAdvisoryCi().catch((error) => log.warn("Advisory CI poll failed", {}, error));
  }

  private schedule(): void {
    if (this.#shuttingDown || this.#drain) return;
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
    for (const candidate of selected) {
      const issue = this.store.getIssue(candidate.id);
      if (!issue) continue;
      this.#active.set(issue.id, {
        repositoryId: issue.repositoryId,
        stageId: candidate.stageId,
        controller: new AbortController(),
        lightweight: candidate.lightweight === true,
      });
      const active = this.#active.get(issue.id)!;
      log.info("Stage started", { ...this.itemFields(issue.id), stage: candidate.stageId });
      void this.execute(issue, active.controller.signal).finally(() => {
        this.#active.delete(issue.id);
      });
    }
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    this.refreshStatusComments([
      ...selectedIds,
      ...candidates
        .filter((candidate) => candidate.eligible && candidate.dependenciesSatisfied && !candidate.rollupOnly && !selectedIds.has(candidate.id))
        .map((candidate) => candidate.id),
    ]);
    this.armWakeTimer();
  }

  private schedulerCandidates(): SchedulerCandidate[] {
    return this.store.listIssues().flatMap((issue) => {
      const state = this.store.getStageState(issue.id);
      if (!state?.stageId || issue.queueRank === null) return [];
      const dependenciesSatisfied = this.store.listDependencies(issue.id).every((id) => {
        const blocker = this.store.getIssue(id);
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
          state.status === "ready" &&
          !this.#active.has(issue.id) &&
          this.wakeupReached(issue.id) &&
          !this.#repositoryErrors.has(issue.repositoryId),
        dependenciesSatisfied,
        rollupOnly: this.store.listChildren(issue.id).length > 0,
        lightweight: this.isLightweightStage(issue.repositoryId, state.stageId),
      }];
    });
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
      let update: Promise<void>;
      update = this.updateStatusComment(issueId)
        .catch((error) => log.warn("Status comment refresh failed", this.itemFields(issueId), error))
        .finally(() => this.#statusCommentUpdates.delete(update));
      this.#statusCommentUpdates.add(update);
    }
  }

  /** The current presentation status, derived from durable gate state and live scheduler facts. */
  private currentIssueStatus(issue: StoredIssue): LiveIssueStatus | null {
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

    const candidate = this.schedulerCandidates().find((item) => item.id === issue.id);
    if (!candidate || !candidate.eligible || !candidate.dependenciesSatisfied || candidate.rollupOnly) return null;
    const blockers = capacityBlockers(candidate, this.concurrencyLimits(), this.schedulerOccupants());
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

  private currentCiWaitingReason(issue: StoredIssue, taskInstanceId: string, pending: string | null): string | null {
    if (!pending?.startsWith("Waiting for CI")) return null;
    const indicator = this.store.listIndicators(issue.id).find((item) => item.id === CI_INDICATOR_ID);
    if (!indicator) return null;
    const head = indicator.headSha.slice(0, 7);
    if (indicator.state === "running" || indicator.state === "unknown") {
      return `Waiting for CI at ${head}: ${indicator.detail}.`;
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
    const task = plan.stages
      .find((stage) => stage.id === this.store.getStageState(issue.id)?.stageId)
      ?.exitGate.find((candidate) => candidate.id === taskInstanceId);
    if (task?.task !== "ci.passed") return null;
    const seconds = typeof task.with.settleSeconds === "number" ? task.with.settleSeconds : 120;
    const firstSeen = this.store.executions().ciMarkAt(issue.id, indicator.headSha, "first-seen") ?? indicator.observedAt;
    return new Date(Date.parse(firstSeen) + seconds * 1_000).toISOString();
  }

  /** Polls due advisory CI watches (no permits, no stage state) and re-arms the timer for the next one. */
  private async pollAdvisoryCi(): Promise<void> {
    if (this.#shuttingDown || this.#advisoryPolling) return;
    this.#advisoryPolling = true;
    try { await this.#advisoryWatches.pollDueWatches(Date.now()); }
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

  /** A parked item is schedulable only once its persisted wake-up time has passed. */
  private wakeupReached(issueId: string): boolean {
    const wakeAt = this.store.executions().wakeAt(issueId);
    return wakeAt === null || Date.parse(wakeAt) <= Date.now();
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
      items: this.github,
      repository,
      issueId,
      sourceGuidance: SOURCE_GUIDANCE,
      git: cliGit,
      workspaces: this.workspaceManager,
      mcp: this.mcpFactory(),
      harnesses: this.#harnesses,
      delivery: () => this.loadDeliveryState(issueId, repository.address),
      codeHost: this.codeHostFor(repository.id),
      ci: {
        provider: () => this.ciProvider(repository.id),
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
      source: this.github,
      workspaceManager: this.workspaceManager,
      loadDeliveryState: async (currentIssue, currentRepository) =>
        this.loadDeliveryState(currentIssue.id, currentRepository.address),
      sourceGuidance: SOURCE_GUIDANCE,
      taskDeps: (currentIssue, currentRepository) => this.taskDeps(currentIssue.id, currentRepository, signal),
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
        // A parked poll changes nothing at the source: no reconcile, just the status line.
        this.restorePendingStatus(issue.repositoryId);
        if ((this.store.getIssue(issue.id)?.warning ?? null) !== warningBefore) await this.updateStatusComment(issue.id);
      } else {
        await this.reconcileRepository(issue.repositoryId);
        await this.updateStatusComment(issue.id);
      }
      this.schedule();
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
      source: this.github,
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
    setTimeout(() => {
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
  }

  /** Reconciliation resets warnings; a parked item's pending message is re-applied from its journal. */
  private restorePendingStatus(repositoryId: string): void {
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
    const host = repository ? this.codeHostFor(repository) : null;
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

  private codeHostFor(repositoryId: string): CodeHost | null {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return null;
    const name = repository.codeHost ?? repository.source;
    return this.#codeHosts.get(name) ?? null;
  }

  /** A stage that only runs an in-process source action: no producer or verifier process. */
  private isLightweightStage(repositoryId: string, stageId: string): boolean {
    const repository = this.config.repositories[repositoryId];
    const stage = repository
      ? this.config.pipelines[repository.pipeline]?.stages.find((candidate) => candidate.id === stageId)
      : undefined;
    if (!stage) return false;
    // A native stage is lightweight when it launches no agent or script process.
    if (isNativeStage(stage)) {
      return ![...stage.actions, ...(stage.exitGate ?? [])].some((entry) => /^(agent|script)\.run$/.test(entry.task));
    }
    return stage.run.type === "source-action" && !stage.enterCheck && !stage.exitCheck;
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

  private async reconcileRepository(repositoryId: string): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository) return;
    const pipeline = this.config.pipelines[repository.pipeline]!;
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
      source: this.github,
      expectedPostMergeClosure: (issueId) => this.store.hasMergedPullRequest(issueId),
    });
    await this.reconcileRelationships(repositoryId, repository.address);
    await this.backfillCiIndicators(repositoryId);
    this.restorePendingStatus(repositoryId);
    this.interruptIneligibleRuns();
  }

  private async reconcileRelationships(
    repositoryId: string,
    address: string,
  ): Promise<void> {
    const issues = this.store
      .listIssues(repositoryId)
      .filter(
        (issue) =>
          issue.sourceState === "open" &&
          // Stopped items too: the board must show the dependencies a person
          // added while an item was blocked, and the scheduler needs them the
          // moment it is unblocked.
          !["offboarded", "missing", "done"].includes(issue.projectedState ?? ""),
      );
    const issueByNumber = new Map(
      this.store
        .listIssues(repositoryId)
        .map((issue) => [issue.sourceNumber, issue]),
    );
    const parents = new Map<string, { parentId: string; siblingOrder: number }>();
    for (const parent of issues) {
      const children = await this.github.listSubIssues(address, parent.sourceNumber);
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
      const dependencies = await this.github.listDependencies(address, issue.sourceNumber);
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
          title: dependency.title,
          body: dependency.body,
          sourceState: dependency.state,
          sourceStateReason: dependency.stateReason ?? null,
          labels: dependency.labels,
          sourceUpdatedAt: dependency.updatedAt,
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
    const satisfied = (issueId: string, visited = new Set<string>()): boolean => {
      if (visited.has(issueId)) return false;
      const issue = this.store.getIssue(issueId);
      if (!issue) return false;
      if (
        issue.sourceState === "closed" ||
        (doneLabel !== undefined && issue.labels.includes(doneLabel))
      ) return true;
      const children = this.store.listChildren(issueId);
      if (children.length === 0) return false;
      const next = new Set(visited).add(issueId);
      return children.every((child) => satisfied(child.issueId, next));
    };
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
        .filter((child) => !satisfied(child.issueId));
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
      const children = this.store.listChildren(parent.id);
      if (
        children.length === 0 ||
        parent.sourceState !== "open" ||
        !parent.labels.includes(this.config.labels.enrollment)
      ) {
        continue;
      }
      if (runningIssueIds.has(parent.id)) continue;
      if (this.store.getStageState(parent.id)?.status !== "running") {
        await removeWorkspace({
          store: this.store,
          manager: this.workspaceManager,
          issueId: parent.id,
          repositoryFolder: this.config.repositories[repositoryId]!.folder,
        });
      }

      const allChildrenSatisfied = children.every((child) => satisfied(child.issueId));
      const targetStage = rollupStage(parent.id);
      if (!allChildrenSatisfied && targetStage) {
        const orderPrefix = this.config.labels.metadata.orderTemplate.split("{number}")[0]!;
        const desiredLabels = [
          this.config.labels.enrollment,
          this.config.labels.stageTemplate.replace("{stage}", targetStage),
          ...parent.labels.filter((label) => label.startsWith(orderPrefix)),
        ].sort((left, right) => left.localeCompare(right));
        const currentLabels = parent.labels
          .filter(
            (label) =>
              label === this.config.labels.enrollment ||
              label.startsWith(`${this.config.labels.enrollment}:`),
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
          await applyRollupTransition({
            store: this.store,
            source: this.github,
            sourceName: this.config.repositories[repositoryId]!.source,
            address,
            configHash: this.config.hash,
            transitionId: `rollup-${transitionDigest}`,
            issue: parent,
            targetStageId: targetStage,
            labels: this.config.labels,
            reason: `Following the earliest unfinished child stage: ${targetStage}`,
          });
        }
      }
      if (
        allChildrenSatisfied &&
        doneLabel &&
        (!parent.labels.includes(doneLabel) ||
          !parent.labels.includes(this.config.labels.metadata.closable))
      ) {
        const orderPrefix = this.config.labels.metadata.orderTemplate.split("{number}")[0]!;
        const metadata = parent.labels.filter((label) => label.startsWith(orderPrefix));
        const stageLabel = parent.projectedStage
          ? [this.config.labels.stageTemplate.replace("{stage}", parent.projectedStage)]
          : [];
        await this.github.replaceConveyorLabels(address, parent.sourceNumber, [
          this.config.labels.enrollment,
          ...stageLabel,
          doneLabel,
          this.config.labels.metadata.closable,
          ...metadata,
        ]);
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
          const codeHost = this.codeHostFor(context.repository.id);
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
          const codeHost = this.codeHostFor(context.repository.id);
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
    const codeHost = this.codeHostFor(context.repository.id);
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
      provider: this.ciProvider(context.issue.repositoryId, input),
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
  async handleMcp(payload: unknown, token: string): Promise<unknown> {
    const grant = this.#mcpGrants.get(token);
    if (!grant) throw new Error("expired MCP grant");
    const request = object(payload);
    const context = grant.context;
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
            board: () => this.operatorBoard(),
            itemHistory: (input) => this.operatorItemHistory(input),
            retry: (itemId, note) => this.retryIssue(itemId, note, "AI Operator"),
            moveBacklog: (input) => this.operatorMoveBacklog(input),
          },
        } as TaskDeps);
    const result = await dispatchTool({
      name: string(request.tool, "tool"),
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
    if (context && canonicalToolName(string(request.tool, "tool")) === "agent.askQuestion") {
      await this.updateStatusComment(context.issue.id);
    }
    return result;
  }

  /** A redacted board view for the scoped Operator MCP tools; it intentionally has no credentials or raw config. */
  private operatorBoard(): unknown {
    const activeIssueIds = new Set(this.store.listActiveIssueRuns().map((run) => run.issueId));
    const reference = (issue: StoredIssue) => ({
      id: issue.id,
      repositoryId: issue.repositoryId,
      number: issue.sourceNumber,
      url: issue.sourceUrl,
      title: issue.title,
    });
    const visible = (issue: StoredIssue | null): issue is StoredIssue =>
      Boolean(issue && this.config.repositories[issue.repositoryId] && issue.projectedState !== "offboarded");
    const items = this.store.listIssues().filter(visible).map((issue) => {
      const cursor = this.store.executions().getCursor(issue.id);
      const active = activeIssueIds.has(issue.id);
      const stopped = STOPPED_ISSUE_STATES.has(issue.projectedState ?? "");
      const parent = issue.parentId ? this.store.getIssue(issue.parentId) : null;
      return {
        ...reference(issue),
        stage: this.store.getStageState(issue.id)?.stageId ?? issue.projectedStage,
        state: issue.projectedState ?? issue.sourceState,
        activity: active ? "active" : cursor?.state === "pending" ? "waiting" : "idle",
        queue: issue.queueRank === null ? { status: "not-queued" } : { status: "queued", rank: issue.queueRank },
        waitingOrStopReason: cursor?.state === "pending"
          ? this.store.executions().pendingMessage(issue.id) ?? issue.warning
          : stopped ? latestStopReason(this.store, issue.id) ?? issue.warning : null,
        parent: visible(parent) ? reference(parent) : null,
        dependencies: this.store.listDependencies(issue.id)
          .map((id) => this.store.getIssue(id))
          .filter(visible)
          .map(reference),
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
    if (!issue || !this.config.repositories[issue.repositoryId] || issue.projectedState === "offboarded") {
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
    if (!this.store.recordSourceEvent({ source: "github", deliveryId, eventType, payload })) return;
    if (typeof repositoryAddress !== "string") return;
    // Before the reconcile, so the board shows a finished run within seconds; a failure never fails the delivery.
    if (repository) {
      await this.applyCiWebhook(repository[0], eventType, payload)
        .catch((error) => log.warn("CI indicator webhook update failed", { repository: repository[0], event: eventType }, error));
      await this.reconcileRepository(repository[0]);
    }
    this.schedule();
    if (repository) this.refreshStatusComments(this.store.listIssues(repository[0]).map((issue) => issue.id));
  }

  /**
   * Updates the stored CI indicator from a `workflow_run`, `check_suite` or `pull_request` delivery.
   * Only the change's current head counts: an event for another head is dropped unless the code
   * host confirms it is the head now (then it replaces the old head's indicator).
   */
  private async applyCiWebhook(repositoryId: string, eventType: string, payload: unknown): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository || repository.ci?.mode === "disabled") return;
    const body = object(payload);
    let head: unknown;
    let pullRequests: unknown[] = [];
    if (eventType === "workflow_run" || eventType === "check_suite") {
      const run = object(body[eventType]);
      head = run.head_sha;
      pullRequests = Array.isArray(run.pull_requests) ? run.pull_requests : [];
    } else if (eventType === "pull_request" && ["opened", "reopened", "synchronize"].includes(String(body.action))) {
      const pullRequest = object(body.pull_request);
      head = object(pullRequest.head).sha;
      pullRequests = [pullRequest];
    } else return;
    if (typeof head !== "string" || !head) return;
    const numbers = pullRequests.map((entry) => object(entry).number).filter((value): value is number => typeof value === "number");
    const issueIds = new Set([
      ...numbers.flatMap((number) => this.store.findIssueIdsByPullRequest(repositoryId, number)),
      ...this.store.findIssueIdsByIndicatorHead(repositoryId, CI_INDICATOR_ID, head),
    ]);
    for (const issueId of issueIds) {
      const stored = this.store.getCurrentPullRequest(issueId);
      if (!stored || stored.state === "merged" || stored.mergedAt) continue;
      const indicator = this.store.listIndicators(issueId).find((entry) => entry.id === CI_INDICATOR_ID);
      const known = indicator?.headSha === head;
      if (eventType === "pull_request" && known) continue;
      if (!known && (await this.currentChangeHead(repositoryId, stored.id)) !== head) continue;
      const change = { repository: repository.address, changeId: String(stored.number), url: stored.url };
      const input = { issueId, headSha: head, changeUrl: stored.url, ignoreChecks: repository.ci?.ignoreChecks ?? [], now: new Date(), authoritative: !known };
      if (eventType === "pull_request") { startCiForHead(this.store, input); continue; }
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

  /** Existing open changes acquire a current-head CI indicator after a reconcile or restart. */
  private async backfillCiIndicators(repositoryId: string): Promise<void> {
    const repository = this.config.repositories[repositoryId];
    if (!repository || repository.ci?.mode === "disabled") return;
    const stored = new Map(this.store.listIndicators().filter((entry) => entry.id === CI_INDICATOR_ID).map((entry) => [entry.issueId, entry]));
    for (const issue of this.store.listIssues(repositoryId)) {
      if (issue.sourceState !== "open") continue;
      const pullRequest = this.store.getCurrentPullRequest(issue.id);
      if (!pullRequest || pullRequest.state !== "open" || pullRequest.mergedAt) continue;
      try {
        const head = await this.currentChangeHead(repositoryId, pullRequest.id);
        if (!head) continue;
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
    if (!cursor || cursor.state !== "pending" || cursor.list !== "actions" || run?.stageId !== cursor.stage || !issue) return false;
    const plan = this.config.plans.find((candidate) => candidate.repositoryId === issue.repositoryId)
      ?? compilePipeline({ config: this.config, repositoryId: issue.repositoryId, registry: createTaskRegistry() });
    const stage = plan.stages.find((candidate) => candidate.id === cursor.stage);
    const task = stage?.actions.find((candidate) => candidate.id === cursor.taskInstanceId);
    return stage !== undefined && !stage.legacy && task?.task === "agent.run" && journal.wakeNow(question.issueId);
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const question = this.store.getQuestion(questionId);
    if (!question) throw new Error("question not found");
    this.store.answerQuestion(questionId, "web", { answer });
    const issue = this.store.getIssue(question.issueId);
    if (!issue) return;
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    await this.github.addComment(
      repository.address,
      issue.sourceNumber,
      `<!-- conveyor:answer:${question.id} -->\n**Conveyor answer:** ${answer}`,
    );
    // A stage parked on an agent's question continues where it stopped; legacy stages restart.
    if (this.wakeParkedAgent(question)) {
      await this.updateStatusComment(issue.id);
      this.schedule();
      return;
    }
    const stage = issue.projectedStage;
    if (stage) {
      const metadata = issue.labels.filter((label) =>
        label === this.config.labels.metadata.closable ||
        label.startsWith(this.config.labels.metadata.orderTemplate.split("{number}")[0]!),
      );
      await this.github.replaceConveyorLabels(repository.address, issue.sourceNumber, [
        this.config.labels.enrollment,
        this.config.labels.stageTemplate.replace("{stage}", stage),
        ...metadata,
      ]);
      await this.reconcileRepository(issue.repositoryId);
      await this.updateStatusComment(issue.id);
      this.schedule();
    }
  }

  async startSteering(prompt: string): Promise<string> {
    const request = prompt.trim();
    if (!request || request.length > 12_000) {
      throw new Error("The steering prompt must contain between 1 and 12000 characters");
    }
    if (this.#drain) throw new Error("Conveyor is draining: no new work is admitted");
    const steering = this.config.web?.steering;
    if (!steering) throw new Error("The steering agent is not configured");
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
    void this.executeSteering(runId, request, agent, runner, steering.workspace, controller.signal)
      .finally(() => this.#steeringActive.delete(runId));
    return runId;
  }

  private async executeSteering(
    runId: string,
    userPrompt: string,
    agent: ConveyorConfig["agents"][string],
    runner: Extract<ConveyorConfig["runners"][string], { type: "codex" }>,
    workspace: string,
    signal: AbortSignal,
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
          "You are the authenticated Conveyor steering agent. Work only within the user's request.",
          "Inspect current state before changing it. Never close source issues. Finish with a concise report of actions, verification, and anything still unresolved.",
          "Use agent.reportProgress only for concise user-facing updates. Never expose private reasoning, raw command output, command names, or tool-call mechanics in those updates.",
          "",
          "User request:",
          userPrompt,
        ].join("\n"),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: agent.workspaceAccess === "read-only" ? "read-only" : runner.sandbox,
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

  private async updateStatusComment(issueId: string): Promise<void> {
    const issue = this.store.getIssue(issueId);
    if (!issue) return;
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
    const acceptanceCriteria = criteriaFromBody(issue.body).map((text) => ({
      text,
      passed: false,
    }));
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
      timestamps: { updatedAt: issue.sourceUpdatedAt },
    });
    const digest = createHash("sha256").update(markdown).digest("hex");
    const mutation = this.store.beginSourceMutation({
      idempotencyKey: `status:${issue.id}:${digest}`,
      source: repository.source,
      operation: "comment.status.upsert",
      request: { issueId: issue.id, digest },
    });
    if (mutation.status === "succeeded") return;
    try {
      const commentId = await this.github.upsertStatusComment(
        repository.address,
        issue.sourceNumber,
        markdown,
      );
      this.store.completeSourceMutation(mutation.id, { commentId });
    } catch (error) {
      this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private statusCommentText(status: LiveIssueStatus): string {
    const state = status.kind === "queued" ? "Queued" : "Waiting";
    const nextCheck = status.nextCheckAt ? ` · next check ${status.nextCheckAt}` : "";
    const since = status.kind === "queued" ? ` · queued since ${status.since}` : "";
    return `${state} · ${status.reason}${nextCheck}${since}`;
  }

  dashboard(
    csrfToken: string,
    pagination: DashboardPageSelection = {
      view: "board",
      column: null,
      page: 1,
      doneLimit: 20,
      runId: null,
      issueId: null,
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
    const issues = this.store.listIssues().filter((issue) => issue.projectedState !== "offboarded");
    const repositoryColors = new Map(Object.keys(this.config.repositories).map((repositoryId, index) =>
      [repositoryId, (index % 8) + 1],
    ));
    const activeRuns = this.store.listActiveIssueRuns();
    const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
    const openQuestions = this.store.listOpenQuestions();
    const questionIssueIds = new Set(openQuestions.map((question) => question.issueId));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
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
    const card = (
      issue: StoredIssue,
      options: { reason?: string | null; state?: string } = {},
    ): IssueCardViewModel => {
      const state = this.store.getStageState(issue.id);
      const cost = this.store.costSummary({ issueId: issue.id });
      const children = this.store.listChildren(issue.id)
        .flatMap(({ issueId }) => {
          const child = byId.get(issueId);
          return child ? [relation(child)] : [];
        });
      const dependencies = this.store.listDependencies(issue.id)
        .flatMap((issueId) => {
          const dependency = byId.get(issueId) ?? this.store.getIssue(issueId);
          return dependency ? [relation(dependency)] : [];
        });
      const projectedState = options.state ?? issue.projectedState ?? issue.sourceState;
      const parent = issue.parentId ? byId.get(issue.parentId) : null;
      const cursor = this.store.executions().getCursor(issue.id);
      const parked = !questionIssueIds.has(issue.id) ? this.currentIssueStatus(issue) : null;
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
      const retryable = (issue.sourceState === "open" ||
        (issue.sourceState === "closed" && this.store.hasMergedPullRequest(issue.id))) &&
        issue.labels.includes(this.config.labels.enrollment) &&
        ["blocked", "error", "needs-intervention"].includes(projectedState) &&
        !activeIssueIds.has(issue.id) &&
        children.length === 0;
      return {
        id: issue.id,
        repository: issue.repositoryId,
        repositoryColor: repositoryColors.get(issue.repositoryId) ?? 1,
        number: issue.sourceNumber,
        title: issue.title,
        url: issue.sourceUrl,
        state: projectedState,
        labels: issue.labels,
        acceptanceCriteria: criteriaFromBody(issue.body),
        todos: todosView(todos.get(issue.id)?.items ?? []),
        indicators: indicators.get(issue.id) ?? [],
        activity: cursor?.state === "pending"
          ? `${cursor.stage} › ${cursor.taskInstanceId ?? cursor.list}`
          : state ? `${state.stageId} · ${state.status}` : null,
        // Live waiting/queued text supersedes the persisted warning, which can describe the
        // gate state from before the item became runnable.
        reason: stopReason ?? (waiting ? null : issue.warning ?? options.reason ?? null),
        cost: formatUsage(cost),
        duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
        stateChangedAt: state?.updatedAt ?? issue.sourceUpdatedAt,
        waiting,
        blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(projectedState),
        inconsistent: issue.projectedState === "inconsistent",
        closable: issue.labels.includes(this.config.labels.metadata.closable),
        tone: tone(projectedState),
        parent: parent ? relation(parent) : null,
        children,
        dependencies,
        working: activeIssueIds.has(issue.id),
        needsAttention: questionIssueIds.has(issue.id) || [
          "blocked", "error", "needs-input", "needs-intervention", "rejected",
        ].includes(projectedState),
        retryable,
      };
    };
    const firstStages = new Set(Object.values(this.config.repositories).flatMap((repository) => {
      const first = this.config.pipelines[repository.pipeline]?.stages[0]?.id;
      return first ? [first] : [];
    }));
    const stageNames = new Map<string, string>();
    for (const pipeline of Object.values(this.config.pipelines)) {
      for (const stage of pipeline.stages) {
        if (!stageNames.has(stage.id)) stageNames.set(stage.id, stage.name ?? displayName(stage.id));
      }
    }
    const stages = [...stageNames.keys()];
    const actorsForStage = (stageId: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      const addAgent = (agentId: string) => {
        const agent = this.config.agents[agentId];
        actors.push({
          type: "agent",
          name: agent?.name ?? displayName(agentId),
          title: agent?.title ?? "AI agent",
        });
      };
      for (const pipeline of Object.values(this.config.pipelines)) {
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
      .filter((issue) => this.store.listChildren(issue.id).length > 0)
      .map((issue) => issue.id));
    const closedIssues = issues
      .filter((issue) =>
        (issue.sourceState === "closed" && !remainsInWorkflow(issue)) || finishedRollupIds.has(issue.id)
      )
      .sort((left, right) =>
        right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
        left.repositoryId.localeCompare(right.repositoryId) ||
        right.sourceNumber - left.sourceNumber
      );
    const workflowIssues = issues.filter((issue) =>
      !finishedRollupIds.has(issue.id) && (issue.sourceState !== "closed" || remainsInWorkflow(issue))
    );
    const backlogIssues = workflowIssues.filter((issue) => {
      if (issue.sourceState === "closed") return false;
      if (issue.parentId || !issue.labels.includes(this.config.labels.enrollment)) return false;
      if (sourceStages(issue).length !== 0 || issue.projectedState !== "active") return false;
      const stageState = this.store.getStageState(issue.id);
      return firstStages.has(issue.projectedStage ?? "") &&
        stageState?.status === "ready" &&
        !this.store.getActiveWorkspace(issue.id);
    });
    const backlogIds = new Set(backlogIssues.map((issue) => issue.id));
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
    const column = (
      id: string,
      name: string,
      columnIssues: StoredIssue[],
      cost: string | null,
      issueCard: (issue: StoredIssue) => IssueCardViewModel = (issue) => card(issue),
      actors: readonly StageActorViewModel[] = [],
    ): StageColumnViewModel => {
      const totalPages = Math.max(1, Math.ceil(columnIssues.length / DASHBOARD_PAGE_SIZE));
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
        issues: columnIssues.slice(offset, offset + DASHBOARD_PAGE_SIZE).map(issueCard),
      };
    };
    const questions: QuestionViewModel[] = openQuestions.flatMap((question) => {
      const issue = byId.get(question.issueId);
      if (!issue) return [];
      const options = question.options.flatMap((value) => {
        try {
          const item = object(value);
          return [{ id: string(item.id, "option.id"), label: string(item.label, "option.label") }];
        } catch {
          return [];
        }
      });
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
      }];
    });
    const total = this.store.costSummary();
    const recentSteeringRuns = this.store.listRunsByKind("steering", 10);
    const selectedSteeringId = pagination.runId ?? recentSteeringRuns[0]?.id ?? null;
    const selectedSteeringRun = selectedSteeringId
      ? this.store.getRun(selectedSteeringId)
      : null;
    const selectedSteering = selectedSteeringRun?.kind === "steering"
      ? {
          id: selectedSteeringRun.id,
          status: selectedSteeringRun.status,
          startedAt: selectedSteeringRun.startedAt,
          finishedAt: selectedSteeringRun.finishedAt,
          events: this.store.listRunEvents(selectedSteeringRun.id).flatMap((event) => {
            const visible = userFacingSteeringEvent(event);
            return visible ? [visible] : [];
          }),
        }
      : null;
    const degradedRepositories = new Set([
      ...this.#repositoryErrors.keys(),
      ...this.#onboardingErrors.keys(),
    ]).size;
    return {
      title: "Conveyor",
      project: `${Object.keys(this.config.repositories).length} repositories${degradedRepositories > 0 ? ` · ${degradedRepositories} degraded` : ""}`,
      totalUsage: formatUsage(total) ?? "0 runs",
      harnessUsage,
      updatedAt: this.#lastReconciledAt ?? new Date().toISOString(),
      revision: this.store.dashboardRevision(),
      view: pagination.view,
      counts: {
        board: backlogIssues.length + stagedIssues.length,
        attention: attentionIssues.length,
      },
      activeWork: {
        runnerCount: activeRuns.length,
        runnerCapacity: this.config.settings.runners,
        runs: activeRuns,
      },
      stages: stages.map((stage) => column(
          `stage:${stage}`,
          stageNames.get(stage) ?? displayName(stage),
          stagedIssues.filter((issue) => issue.projectedStage === stage),
          formatUsage(this.store.costSummary({ stageId: stage })),
          (issue) => card(issue),
          actorsForStage(stage),
        )),
      backlog: backlogIssues.map((issue) => card(issue)),
      done: {
        id: "done",
        name: "Done",
        actors: [],
        cost: null,
        totalIssues: closedIssues.length,
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
        .filter((issue) => ["blocked", "error", "needs-input", "needs-intervention", "rejected"].includes(issue.projectedState ?? ""))
        .map((issue) => card(issue)),
      systemWarnings: [
        ...this.#onboardingErrors.entries(),
        ...this.#repositoryErrors.entries(),
      ].map(([repository, message]) => `${repository}: ${message}`),
      steering: {
        enabled: Boolean(this.config.web?.steering),
        agent: this.config.web?.steering?.agent ?? null,
        selected: selectedSteering,
        recent: recentSteeringRuns,
      },
      selectedIssue: pagination.issueId && byId.has(pagination.issueId)
        ? card(byId.get(pagination.issueId)!)
        : null,
      csrfToken,
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
    if (!issue || issue.projectedState === "offboarded") return null;
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
    const nowState = pending ? "waiting" : activeRun ? "running" : stopped ? "stopped" : issue.projectedState ?? issue.sourceState;
    const nowReason = pending
      ? this.store.executions().pendingMessage(issueId) ?? issue.warning
      : stopped ? latestStopReason(this.store, issueId) ?? issue.warning : null;
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
        since: pending
          ? cursor.pendingSince
          : activeRun?.startedAt ?? stageState?.updatedAt ?? issue.sourceUpdatedAt,
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
    };
  }

  async systemStatus(): Promise<SystemStatusViewModel> {
    const memoryTotal = totalmem();
    const memoryFree = freemem();
    const disk = await statfs(this.config.settings.database);
    const diskTotal = disk.blocks * disk.bsize;
    const diskAvailable = disk.bavail * disk.bsize;
    return {
      memory: {
        usedBytes: memoryTotal - memoryFree,
        totalBytes: memoryTotal,
        processBytes: process.memoryUsage().rss,
      },
      disk: {
        usedBytes: diskTotal - diskAvailable,
        totalBytes: diskTotal,
        availableBytes: diskAvailable,
      },
      uptimeSeconds: Math.floor(uptime()),
    };
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
    if (issue.sourceState === "closed" && !this.store.hasMergedPullRequest(issueId)) {
      throw new Error("closed issues cannot be resumed from conversation");
    }
    if (["done", "missing", "inconsistent"].includes(issue.projectedState ?? "")) {
      throw new Error(`issue state ${issue.projectedState} cannot be resumed from conversation`);
    }
    const activeRun = this.store.listActiveIssueRuns().find((run) => run.issueId === issueId);
    const running = this.#active.has(issueId) || Boolean(activeRun);
    if (!running && this.store.listChildren(issueId).length > 0) {
      throw new Error("roll-up parents cannot run directly; message a child issue instead");
    }
    const stageId = issue.projectedStage ?? this.store.getStageState(issueId)?.stageId ?? activeRun?.stageId ?? null;
    if (!stageId) throw new Error("issue has no unambiguous configured stage to resume");
    const recorded = this.store.appendConversationMessage({
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

    const question = this.store.listOpenQuestions().find((candidate) => candidate.issueId === issueId);
    if (question) {
      await this.answerQuestion(question.id, message);
    } else {
      const orderPrefix = this.config.labels.metadata.orderTemplate.split("{number}")[0]!;
      const metadata = issue.labels.filter((label) =>
        label === this.config.labels.metadata.closable || label.startsWith(orderPrefix),
      );
      const labels = [
        this.config.labels.enrollment,
        this.config.labels.stageTemplate.replace("{stage}", stageId),
        ...metadata,
      ];
      const mutation = this.store.beginSourceMutation({
        idempotencyKey: `conversation-resume:${recorded.id}`,
        source: repository.source,
        operation: "issue.labels.resume",
        request: { issueId, issueNumber: issue.sourceNumber, labels },
      });
      if (mutation.status !== "succeeded") {
        try {
          await this.github.replaceConveyorLabels(
            repository.address,
            issue.sourceNumber,
            labels,
          );
          this.store.completeSourceMutation(mutation.id, { labels });
        } catch (error) {
          this.store.failSourceMutation(
            mutation.id,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      }
      await this.reconcileRepository(issue.repositoryId);
      const refreshed = this.store.getIssue(issueId);
      if (refreshed?.queueRank === null) this.store.setQueueRank(issueId, this.store.nextQueueRank());
      this.schedule();
      await this.updateStatusComment(issueId).catch((error) => {
        log.error("Status comment update failed after conversation resume", this.itemFields(issueId), error);
      });
    }

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

  async retryIssue(issueId: string, note: string, username: string): Promise<{ status: "started" | "queued"; stageId: string }> {
    if (this.#retrying.has(issueId)) throw new Error("retry already in progress");
    this.#retrying.add(issueId);
    try {
      const issue = this.store.getIssue(issueId);
      const repository = issue ? this.config.repositories[issue.repositoryId] : undefined;
      if (!issue || !repository || issue.projectedState === "offboarded") throw new Error("issue not found");
      if (note.length > 4_000) throw new Error("retry note must not exceed 4000 characters");
      const expectedPostMergeClosure = this.store.hasMergedPullRequest(issueId);
      if ((issue.sourceState !== "open" && !(issue.sourceState === "closed" && expectedPostMergeClosure)) ||
        !issue.labels.includes(this.config.labels.enrollment)) {
        throw new Error("issue is closed or offboarded");
      }
      if (this.#active.has(issueId) || this.store.listActiveIssueRuns().some((run) => run.issueId === issueId)) {
        throw new Error("issue is already running");
      }
      if (this.store.listChildren(issueId).length > 0) throw new Error("roll-up parents cannot be retried directly");

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
        evaluated.state !== issue.projectedState || evaluated.stage !== issue.projectedStage) {
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
        (label === this.config.settings.labelPrefix || label.startsWith(`${this.config.settings.labelPrefix}:`)) &&
        label !== this.config.labels.states[evaluated.state!],
      );
      try {
        await this.github.replaceConveyorLabels(repository.address, issue.sourceNumber, conveyorLabels);
        this.store.completeSourceMutation(mutation.id, { labels: conveyorLabels });
      } catch (error) {
        this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
        throw error;
      }

      if (note.trim()) {
        this.store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: "user", actorId: username,
          actorName: username, actorTitle: null, message: note.trim(),
        });
      }
      await this.reconcileRepository(issue.repositoryId);
      const refreshed = this.store.getIssue(issueId);
      if (refreshed?.queueRank === null) this.store.setQueueRank(issueId, this.store.nextQueueRank());
      this.schedule();
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
    return Boolean(this.#lastReconciledAt) && !this.#shuttingDown && this.#repositoryErrors.size === 0 && this.#onboardingErrors.size === 0;
  }

  /** Stops admitting new work; running work continues. Idempotent: the first reason is kept. */
  drain(reason: string): { since: string; reason: string } {
    if (!this.#drain) {
      this.#drain = { since: new Date().toISOString(), reason };
      log.info("Admission paused: draining", { reason });
    }
    return this.#drain;
  }

  /** Admits new work again after a drain; false when no drain was in effect. */
  resumeAdmission(): boolean {
    if (!this.#drain) return false;
    this.#drain = null;
    log.info("Admission resumed");
    this.schedule();
    return true;
  }

  draining(): { since: string; reason: string } | null {
    return this.#drain;
  }

  /** Work in flight: items executing a stage, and steering runs. */
  activeWork(): { items: Array<{ issueId: string; repositoryId: string; stageId: string }>; steering: number } {
    return {
      items: [...this.#active.entries()].map(([issueId, active]) => ({ issueId, repositoryId: active.repositoryId, stageId: active.stageId })),
      steering: this.#steeringActive.size,
    };
  }

  /**
   * Pauses an item the way the source does: removes only its enrollment label, so Conveyor stops
   * scheduling it and interrupts its running stage; its stage, worktree and history are kept.
   */
  async pauseIssue(issueId: string, actor: string): Promise<{ stageId: string | null }> {
    const { issue, repository, live } = await this.liveEnrolledIssue(issueId);
    if (!live.labels.includes(this.config.labels.enrollment)) throw new Error("the item is already paused");
    const labels = this.conveyorLabels(live.labels).filter((label) => label !== this.config.labels.enrollment);
    await this.replaceLabelsRecorded(issue, repository, "issue.labels.pause", labels);
    await this.reconcileRepository(issue.repositoryId);
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
    await this.reconcileRepository(issue.repositoryId);
    this.schedule();
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
    const live = await this.github.getIssue(repository.address, issue.sourceNumber);
    if (live.state !== "open") throw new Error("the item is closed");
    if (this.conveyorLabels(live.labels).length === 0) throw new Error("the item is offboarded (it has no Conveyor labels)");
    return { issue, repository, live };
  }

  private conveyorLabels(labels: readonly string[]): string[] {
    const prefix = this.config.settings.labelPrefix;
    return labels.filter((label) => label === prefix || label.startsWith(`${prefix}:`));
  }

  private async replaceLabelsRecorded(issue: StoredIssue, repository: ConveyorConfig["repositories"][string], operation: string, labels: string[]): Promise<void> {
    const mutation = this.store.beginSourceMutation({
      idempotencyKey: `${operation}:${randomUUID()}`,
      source: repository.source,
      operation,
      request: { issueId: issue.id, issueNumber: issue.sourceNumber, labels },
    });
    try {
      await this.github.replaceConveyorLabels(repository.address, issue.sourceNumber, labels);
      this.store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
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
    // An item parked on its review gate re-evaluates now instead of at the next poll.
    const cursor = this.store.executions().getCursor(issueId);
    if (cursor?.state === "pending" && cursor.list === "exit-gate" && this.store.executions().wakeNow(issueId)) this.schedule();
    await this.updateStatusComment(issue.id);
  }

  webDependencies(auth: WebAuthApi, username: string, push: PushConfiguration | null = null): WebHandlerDependencies {
    const githubSource = Object.values(this.config.sources).find((source) => source.type === "github");
    return {
      auth,
      username,
      listAccounts: () => this.store.dashboardAccounts().map(({ id, username, role, avatar }) => ({ id, username, role, avatar })),
      getAccount: (id) => this.store.dashboardAccountById(id),
      getPushPreferences: (id) => this.store.getPushPreferences(id),
      setPushPreferences: (id, preferences) => this.store.setPushPreferences(id, preferences),
      putPushSubscription: (id, endpoint, keys) => this.store.putPushSubscription(id, endpoint, keys),
      deletePushSubscription: (id, endpoint) => this.store.deletePushSubscription(id, endpoint),
      pushPublicKey: push?.publicKey ?? null,
      dispatchPushEvents: () => deliverPushEvents(this.store, async (issueId) => {
        const target = this.store.getIssue(issueId);
        return target && target.projectedState !== "offboarded"
          ? `/issues/${encodeURIComponent(target.repositoryId)}/${target.sourceNumber}`
          : null;
      }, push),
      createAccount: (name, passwordHash) => this.store.createDashboardUser(name, passwordHash),
      changePassword: (id, passwordHash) => this.store.changeDashboardPassword(id, passwordHash),
      changeAvatar: (id, avatar) => this.store.changeDashboardAvatar(id, avatar),
      getDashboard: (csrfToken, pagination) => this.dashboard(csrfToken, pagination),
      getDashboardRevision: () => this.store.dashboardRevision(),
      getConversationRevision: () => this.store.conversationRevision(),
      getActivityRevision: () => this.store.activityRevision(),
      getSystemStatus: () => this.systemStatus(),
      isReady: () => this.isReady(),
      webhookPath: githubSource?.webhookPath ?? "/hooks/github",
      answerQuestion: (id, answer) => this.answerQuestion(id, answer),
      reorderBacklog: (id, direction) => this.reorderBacklog(id, direction),
      moveBacklogIssue: (id, beforeId) => this.moveBacklogIssue(id, beforeId),
      handleWebhook: (body, headers) => this.handleWebhook(body, headers),
      handleMcp: (body, token) => this.handleMcp(body, token),
      startSteering: (prompt) => this.startSteering(prompt),
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
        if (!issue || issue.projectedState === "offboarded") return null;
        return { id: issue.id, repository: issue.repositoryId, number: issue.sourceNumber };
      },
      postIssueMessage: (issueId, message, actor) => this.postIssueMessage(issueId, message, actor),
      retryIssue: (issueId, note, actor) => this.retryIssue(issueId, note, actor),
      dismissFinding: (issueId, findingId, reason, username) => this.dismissFinding(issueId, findingId, reason, username),
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
