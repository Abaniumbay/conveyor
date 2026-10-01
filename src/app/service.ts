import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { freemem, totalmem, uptime } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import { reconcileRepository } from "../core/reconciler";
import { selectRunnableIssues, type SchedulerCandidate } from "../core/scheduler";
import { applyRollupTransition } from "../core/transition";
import { ConveyorStore, type StoredIssue } from "../db/store";
import { codexHarness } from "../harness/codex";
import type { Harness } from "../harness/types";
import { GitHubAdapter, verifyGitHubSignature } from "../source/github/adapter";
import { GitHubActionsCiProvider, focusGitHubActionsLog, parseGitHubActionsTriggers } from "../source/github/ci-provider";
import type { CiChange, CiProvider } from "./ci-provider";
import { CodeHostRegistry } from "../codehost/registry";
import type { CodeHost } from "../codehost/types";
import { changeAction, pushAndEnsureChange } from "../codehost/actions";
import { renderStatusComment } from "../source/github/status-comment";
import { runCodexSteering, type CodexSteeringInput } from "../runner/codex-steering";
import { WorkspaceManager } from "../workspace/manager";
import { formatDuration } from "../web/format";
import type { DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRelationViewModel, IssueRunEventsViewModel, IssueTone, QuestionViewModel, StageActorViewModel, StageColumnViewModel, SystemStatusViewModel } from "../web/types";
import type { WebAuthApi, WebHandlerDependencies } from "../web/server";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type ScopedMcpLease, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";
import { createTaskRegistry } from "../tasks/catalogue";
import { runTask } from "../tasks/contract";
import type { TaskDeps } from "../tasks/deps";
import { criteriaFromBody } from "../tasks/item";
import { compilePipeline } from "../tasks/plan";
import { cliGit } from "../workspace/git";
import { removeWorkspace } from "../workspace/lifecycle";
import { createCiGateMemory, evaluateCiGate, parseCiGateOptions, type SourceActionOutcome } from "./ci-gate";

interface ActiveRun {
  repositoryId: string;
  stageId: string;
  controller: AbortController;
  /** Runs no runner process; excluded from global and repository permits. */
  lightweight: boolean;
}

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
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
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

/** Legacy MCP tool names served by the `item` tool tasks. */
const ITEM_TOOLS: Record<string, string> = {
  "source.get_issue": "item.get",
  "source.add_comment": "item.comment",
  "source.set_acceptance_criteria": "item.setCriteria",
  "source.set_system_labels": "item.setSystemLabels",
  "source.set_parent": "item.setParent",
  "source.set_dependencies": "item.setDependencies",
  "source.create_child": "item.createChild",
};

/** Legacy MCP tool names served by the `workspace` tool tasks. */
const WORKSPACE_TOOLS: Record<string, string> = {
  "workspace.request_fetch": "workspace.fetch",
  "workspace.request_push": "workspace.push",
};

/** Legacy MCP tool names served by the `change` tool tasks. */
const CHANGE_TOOLS: Record<string, string> = {
  "delivery.get_state": "change.get",
  "source.set_pull_request_metadata": "change.setMetadata",
};

/** Legacy MCP names served by the `agent` tool tasks (`workspace.record_artifact` shares `agent.recordArtifact`). */
const AGENT_TOOLS: Record<string, string> = {
  "run.report_progress": "agent.reportProgress",
  "run.ask_question": "agent.askQuestion",
  "run.report_rationale": "agent.reportRationale",
  "run.report_blocker": "agent.reportBlocker",
  "run.report_result": "agent.reportResult",
  "run.report_milestone": "agent.reportMilestone",
  "run.record_artifact": "agent.recordArtifact",
  "workspace.record_artifact": "agent.recordArtifact",
};

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

export class ConveyorService {
  readonly store: ConveyorStore;
  readonly github: GitHubAdapter;
  readonly #codeHosts: CodeHostRegistry;
  readonly workspaceManager: WorkspaceManager;
  readonly #active = new Map<string, ActiveRun>();
  readonly #steeringActive = new Map<string, AbortController>();
  readonly #mcpGrants = new Map<string, McpGrant>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #ciMemory = createCiGateMemory();
  readonly #ciProviders = new Map<string, CiProvider>();
  /** Fires a schedule pass at the earliest persisted wake-up of a parked item. */
  #wakeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastReconciledAt: string | null = null;
  #shuttingDown = false;
  #tickRunning = false;
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
    this.#harnesses = implementations.harnesses ?? { codex: codexHarness };
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
      console.warn(
        `Recovered ${recovered.runs} interrupted run(s) and ${recovered.stages} running stage(s) after restart`,
      );
    }
    const removedRepositories = store.removeRepositoriesExcept(Object.keys(config.repositories));
    if (removedRepositories.length > 0) {
      console.info(
        `Removed unconfigured repositories from the local index: ${removedRepositories.join(", ")}`,
      );
    }
    store.recordConfigSnapshot(config.hash, config);
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
          const secret = process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET;
          if (!secret) throw new Error("CONVEYOR_GITHUB_WEBHOOK_SECRET is required for webhooks");
          const url = new URL(source.webhookPath, this.config.web.publicUrl).href;
          await this.github.ensureWebhook({ address: repository.address, url, secret });
        }
        this.#onboardingErrors.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#onboardingErrors.set(id, message);
        console.error(`Repository ${id} onboarding failed: ${message}`);
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
        console.error(`Repository ${id} reconciliation failed: ${message}`);
      }
    }
    this.#lastReconciledAt = new Date().toISOString();
    this.interruptIneligibleRuns();
  }

  start(): void {
    if (this.#timer) return;
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.config.settings.reconcileIntervalMs);
  }

  async close(): Promise<void> {
    this.#shuttingDown = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
    for (const active of this.#active.values()) active.controller.abort();
    for (const controller of this.#steeringActive.values()) controller.abort();
    while (this.#active.size > 0 || this.#steeringActive.size > 0) await Bun.sleep(25);
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
  }

  private schedule(): void {
    if (this.#shuttingDown) return;
    const issues = this.store.listIssues();
    const candidates: SchedulerCandidate[] = issues.flatMap((issue) => {
      const state = this.store.getStageState(issue.id);
      if (!state?.stageId || issue.queueRank === null) return [];
      const blockers = this.store.listDependencies(issue.id);
      const dependenciesSatisfied = blockers.every((id) => {
        const blocker = this.store.getIssue(id);
        return Boolean(
          blocker &&
          (blocker.sourceState === "closed" || blocker.projectedState === "done"),
        );
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
    const stageLimits: Record<string, number> = {};
    for (const pipeline of Object.values(this.config.pipelines)) {
      for (const stage of pipeline.stages) {
        stageLimits[stage.id] = Math.min(stageLimits[stage.id] ?? Infinity, stage.concurrency);
      }
    }
    const repositoryLimits = Object.fromEntries(
      Object.entries(this.config.repositories).map(([id, repository]) => [id, repository.concurrency]),
    );
    const stageUsage: Record<string, number> = {};
    const repositoryUsage: Record<string, number> = {};
    let processUsage = 0;
    for (const active of this.#active.values()) {
      stageUsage[active.stageId] = (stageUsage[active.stageId] ?? 0) + 1;
      if (active.lightweight) continue;
      processUsage += 1;
      repositoryUsage[active.repositoryId] = (repositoryUsage[active.repositoryId] ?? 0) + 1;
    }
    const selected = selectRunnableIssues(
      candidates,
      {
        global: this.config.settings.runners,
        stages: stageLimits,
        repositories: repositoryLimits,
      },
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
      void this.execute(issue, active.controller.signal).finally(() => {
        this.#active.delete(issue.id);
      });
    }
    this.armWakeTimer();
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
      ci: { provider: () => this.ciProvider(repository.id) },
      notify: (message, stageId) => {
        this.store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator", message,
        });
      },
      ...(signal ? { signal } : {}),
    };
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
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: "active",
        warning: `Execution failed and will retry: ${error instanceof Error ? error.message : String(error)}`,
      });
      await this.updateStatusComment(issue.id).catch((statusError) => {
        console.error(`Status comment for ${issue.id} failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
      });
      setTimeout(() => {
        const current = this.store.getStageState(issue.id);
        if (current?.status === "error") {
          this.store.setStageState({
            issueId: issue.id,
            stageId: current.stageId,
            status: "ready",
            feedbackCycle: current.feedbackCycle,
            configHash: this.config.hash,
          });
          this.schedule();
        }
      }, this.config.settings.retries.minBackoff);
    }
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
          allowedTools: new Set(allowedTools),
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
          allowedTools,
        }), { mode: 0o600 });
        await chmod(contextFile, 0o600);
        return {
          configuration: {
            command: process.execPath,
            args: ["run", path.join(import.meta.dir, "../mcp/cli.ts"), "--context", contextFile],
          },
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
      allowedTools: new Set(allowedTools),
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
      sourceGuidance: "This is a system-scoped steering run. Only explicitly granted reporting tools are available.",
      control: { url: `http://127.0.0.1:${port}/internal/mcp`, token },
      allowedTools,
    }), { mode: 0o600 });
    await chmod(contextFile, 0o600);
    return {
      configuration: {
        command: process.execPath,
        args: ["run", path.join(import.meta.dir, "../mcp/cli.ts"), "--context", contextFile],
      },
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
    const outcome = await evaluateCiGate({
      change: { repository: context.repository.address, changeId: String(pullRequest.number), url: pullRequest.url },
      issueKey: context.issue.id,
      options,
      provider: this.ciProvider(context.issue.repositoryId, input),
      headSha: (await codeHost.getChange({ address: context.repository.address, id: pullRequest.id })).headSha,
      memory: this.#ciMemory,
      now: Date.now(),
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

  private async runItemTool(
    name: string,
    grant: McpGrant,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    const context = grant.context;
    // A system-scoped (steering) grant has no item: only the run-event tools are allowed there.
    const deps: TaskDeps = context
      ? this.taskDeps(context.issue.id, context.repository)
      : ({ store: this.store, config: this.config, issueId: "" } as TaskDeps);
    deps.run = { id: grant.runId, actor: grant.actor };
    const result = await runTask(createTaskRegistry().require(name), {
      config: {},
      context: {},
      deps,
      input,
      ...(grant.actor ? { actor: grant.actor.id } : {}),
      instance: { id: name, stage: grant.stageId, idempotencyKey, resumed: false },
    });
    if (result.status !== "pass") throw new Error(result.status === "fail" || result.status === "pending" ? result.message : name);
    return result.output ?? { accepted: true };
  }

  async handleMcp(payload: unknown, token: string): Promise<unknown> {
    const grant = this.#mcpGrants.get(token);
    if (!grant) throw new Error("expired MCP grant");
    const request = object(payload);
    const tool = string(request.tool, "tool");
    if (!grant.allowedTools.has(tool)) throw new Error(`MCP tool is not granted: ${tool}`);
    const input = object(request.input ?? {});
    if (tool === "conversation.get") {
      if (!grant.context) throw new Error("conversation requires an issue-scoped MCP grant");
      return this.runItemTool("conversation.get", grant, input, "");
    }
    if (AGENT_TOOLS[tool] && tool !== "workspace.record_artifact") {
      if (tool === "run.ask_question") {
        if (!grant.context) throw new Error("structured questions require an issue-scoped MCP grant");
        const result = await this.runItemTool(AGENT_TOOLS[tool]!, grant, input, "");
        await this.updateStatusComment(grant.context.issue.id);
        return result;
      }
      return this.runItemTool(AGENT_TOOLS[tool]!, grant, input, "");
    }

    if (!grant.context) throw new Error(`${tool} requires an issue-scoped MCP grant`);
    const issue = grant.context.issue;
    const address = grant.context.repository.address;

    if (tool === "source.get_issue") {
      return this.runItemTool(ITEM_TOOLS[tool]!, grant, input, "");
    }
    if (tool === "delivery.get_state") {
      return this.runItemTool(CHANGE_TOOLS[tool]!, grant, input, "");
    }
    if (tool === "delivery.get_check_logs") {
      return this.runItemTool("ci.getLogs", grant, input, "");
    }

    const idempotencyKey = `mcp:${grant.runId}:${tool}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
    const mutation = this.store.beginSourceMutation({
      idempotencyKey,
      source: "github",
      operation: tool,
      request: input,
    });
    if (mutation.status === "succeeded") return mutation.response ?? { accepted: true };
    try {
      let result: unknown = { accepted: true };
      const itemTool = ITEM_TOOLS[tool];
      if (itemTool) {
        result = await this.runItemTool(itemTool, grant, input, idempotencyKey);
      } else if (WORKSPACE_TOOLS[tool]) {
        result = await this.runItemTool(WORKSPACE_TOOLS[tool]!, grant, input, idempotencyKey);
      } else if (tool === "workspace.record_artifact") {
        result = await this.runItemTool(AGENT_TOOLS[tool]!, grant, input, idempotencyKey);
      } else if (CHANGE_TOOLS[tool]) {
        result = await this.runItemTool(CHANGE_TOOLS[tool]!, grant, input, idempotencyKey);
      } else {
        throw new Error(`unsupported MCP tool: ${tool}`);
      }
      this.store.completeSourceMutation(mutation.id, result);
      return result;
    } catch (error) {
      this.store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async handleWebhook(rawBody: Uint8Array, headers: Headers): Promise<void> {
    const secret = process.env.CONVEYOR_GITHUB_WEBHOOK_SECRET ?? "";
    if (!verifyGitHubSignature(rawBody, headers.get("x-hub-signature-256"), secret)) {
      throw new Error("invalid GitHub webhook signature");
    }
    const deliveryId = headers.get("x-github-delivery");
    const eventType = headers.get("x-github-event");
    if (!deliveryId || !eventType) throw new Error("missing GitHub webhook headers");
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
    if (!this.store.recordSourceEvent({ source: "github", deliveryId, eventType, payload })) return;
    const repositoryAddress = object(object(payload).repository).full_name;
    if (typeof repositoryAddress !== "string") return;
    const repository = Object.entries(this.config.repositories)
      .find(([, candidate]) => candidate.address.toLowerCase() === repositoryAddress.toLowerCase());
    if (repository) await this.reconcileRepository(repository[0]);
    this.schedule();
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
      lease = await this.steeringMcpLease(runId, workspace, agent.tools);
      const instructions = await readFile(agent.instructions, "utf8");
      const result = await this.#runSteering({
        command: runner.command,
        workspace,
        prompt: [
          instructions.trim(),
          "",
          "You are the authenticated Conveyor steering agent. Work only within the user's request.",
          "Inspect current state before changing it. Never close source issues. Finish with a concise report of actions, verification, and anything still unresolved.",
          "Use run.report_progress only for concise user-facing updates. Never expose private reasoning, raw command output, command names, or tool-call mechanics in those updates.",
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
    if (!issue || issue.parentId) throw new Error("only top-level issues can be reordered");
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
    const markdown = renderStatusComment({
      issue: { number: issue.sourceNumber, title: issue.title, state: issue.sourceState },
      stage: issue.projectedStage ?? "unassigned",
      state: issue.projectedState ?? "unknown",
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
      warnings: issue.warning ? [issue.warning] : [],
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
    const issues = this.store.listIssues().filter((issue) => issue.projectedState !== "offboarded");
    const activeRuns = this.store.listActiveIssueRuns();
    const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
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
      return {
        id: issue.id,
        repository: issue.repositoryId,
        number: issue.sourceNumber,
        title: issue.title,
        url: issue.sourceUrl,
        state: projectedState,
        labels: issue.labels,
        acceptanceCriteria: criteriaFromBody(issue.body),
        activity: state ? `${state.stageId} · ${state.status}` : null,
        reason: issue.warning ?? options.reason ?? null,
        cost:
          cost.runs === 0
            ? null
            : cost.unavailableRuns === cost.runs
              ? `unavailable · ${cost.runs} run${cost.runs === 1 ? "" : "s"}`
              : `$${cost.amount.toFixed(4)} · ${cost.runs} runs`,
        duration: cost.durationMs > 0 ? formatDuration(cost.durationMs) : null,
        blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(issue.projectedState ?? ""),
        inconsistent: issue.projectedState === "inconsistent",
        closable: issue.labels.includes(this.config.labels.metadata.closable),
        tone: tone(projectedState),
        parent: parent ? relation(parent) : null,
        children,
        dependencies,
        working: activeIssueIds.has(issue.id),
      };
    };
    const firstStages = new Set(Object.values(this.config.repositories).flatMap((repository) => {
      const first = this.config.pipelines[repository.pipeline]?.stages[0]?.id;
      return first ? [first] : [];
    }));
    const stages = [...new Set(Object.values(this.config.pipelines).flatMap((pipeline) =>
      pipeline.stages.map((stage) => stage.id),
    ))];
    const actorsForStage = (stageId: string): StageActorViewModel[] => {
      const actors: StageActorViewModel[] = [];
      for (const pipeline of Object.values(this.config.pipelines)) {
        const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
        if (!stage) continue;
        if (isNativeStage(stage) || stage.run?.type !== "agent") {
          actors.push({ type: "script", name: "Script", title: null });
          continue;
        }
        const agent = this.config.agents[stage.run.agent];
        actors.push({
          type: "agent",
          name: agent?.name ?? title(stage.run.agent),
          title: agent?.title ?? "AI agent",
        });
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
    const closedIssues = issues
      .filter((issue) => issue.sourceState === "closed" && !remainsInWorkflow(issue))
      .sort((left, right) =>
        right.sourceUpdatedAt.localeCompare(left.sourceUpdatedAt) ||
        left.repositoryId.localeCompare(right.repositoryId) ||
        right.sourceNumber - left.sourceNumber
      );
    const workflowIssues = issues.filter((issue) =>
      issue.sourceState !== "closed" || remainsInWorkflow(issue)
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
    const title = (value: string) => value
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ");
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
    const questions: QuestionViewModel[] = this.store.listOpenQuestions().flatMap((question) => {
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
        issueNumber: issue.sourceNumber,
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
      project: `${Object.keys(this.config.repositories).length} repositories${degradedRepositories > 0 ? ` · ${degradedRepositories} degraded` : ""} · ${total.runs} runs · ${total.unavailableRuns === total.runs && total.runs > 0 ? "cost unavailable" : `$${total.amount.toFixed(4)}`}`,
      updatedAt: this.#lastReconciledAt ?? new Date().toISOString(),
      revision: this.store.dashboardRevision(),
      view: pagination.view,
      counts: {
        board: backlogIssues.length + stagedIssues.length + closedIssues.length,
        attention: attentionIssues.length,
      },
      activeWork: {
        runnerCount: activeRuns.length,
        runnerCapacity: this.config.settings.runners,
        runs: activeRuns,
      },
      stages: stages.map((stage) => column(
          `stage:${stage}`,
          title(stage),
          stagedIssues.filter((issue) => issue.projectedStage === stage),
          (() => {
          const summary = this.store.costSummary({ stageId: stage });
          if (summary.runs === 0) return null;
          return summary.unavailableRuns === summary.runs
            ? `${summary.runs} runs · cost unavailable`
            : `$${summary.amount.toFixed(4)} · ${summary.runs} runs`;
          })(),
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
          state: issue.sourceStateReason === "completed" ? "completed" : "closed",
          reason: issue.sourceStateReason && issue.sourceStateReason !== "completed"
            ? `GitHub close reason: ${issue.sourceStateReason.replaceAll("_", " ")}.`
            : null,
        })),
      },
      attention: column(
        "attention",
        "Needs attention",
        attentionIssues,
        null,
        (issue) => card(issue, {
          reason: issue.projectedStage
            ? "The issue has conflicting or invalid Conveyor labels."
            : "No valid configured stage label is present.",
        }),
      ),
      questions,
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
        console.error(`Status comment for ${issueId} failed after conversation resume: ${error instanceof Error ? error.message : String(error)}`);
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

  webDependencies(auth: WebAuthApi, username: string): WebHandlerDependencies {
    const githubSource = Object.values(this.config.sources).find((source) => source.type === "github");
    return {
      auth,
      username,
      getDashboard: (csrfToken, pagination) => this.dashboard(csrfToken, pagination),
      getDashboardRevision: () => this.store.dashboardRevision(),
      getConversationRevision: () => this.store.conversationRevision(),
      getActivityRevision: () => this.store.activityRevision(),
      getSystemStatus: () => this.systemStatus(),
      isReady: () =>
        Boolean(this.#lastReconciledAt) &&
        !this.#shuttingDown &&
        this.#repositoryErrors.size === 0 &&
        this.#onboardingErrors.size === 0,
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
      postIssueMessage: (issueId, message, actor) => this.postIssueMessage(issueId, message, actor),
    };
  }
}
