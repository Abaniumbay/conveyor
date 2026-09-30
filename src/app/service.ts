import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { freemem, totalmem, uptime } from "node:os";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { reconcileRepository } from "../core/reconciler";
import { selectRunnableIssues, type SchedulerCandidate } from "../core/scheduler";
import { applyRollupTransition } from "../core/transition";
import { ConveyorStore, type StoredIssue } from "../db/store";
import {
  formatAcceptanceCriteria,
  formatDependencies,
  parseManagedSections,
  upsertManagedSection,
  type AcceptanceCriterion,
} from "../source/github/managed-sections";
import { GhCliTransport, GitHubAdapter, verifyGitHubSignature } from "../source/github/adapter";
import { GitHubActionsCiProvider, focusGitHubActionsLog, parseGitHubActionsTriggers } from "../source/github/ci-provider";
import type { CiChange, CiProvider } from "./ci-provider";
import { GitHubCodeHost } from "../source/github/codehost";
import type { CodeHost } from "../codehost/types";
import { changeAction } from "../codehost/actions";
import { renderStatusComment } from "../source/github/status-comment";
import { runCodexSteering, type CodexSteeringInput } from "../runner/codex-steering";
import { WorkspaceManager } from "../workspace/manager";
import { formatDuration } from "../web/format";
import type { DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueCardViewModel, IssueConversationViewModel, IssueJourneyViewModel, IssueRelationViewModel, IssueRunEventsViewModel, IssueTone, QuestionViewModel, StageActorViewModel, StageColumnViewModel, SystemStatusViewModel } from "../web/types";
import type { WebAuthApi, WebHandlerDependencies } from "../web/server";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type ScopedMcpLease, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";
import { createCiGateMemory, evaluateCiGate, ExternalWaitError, parseCiGateOptions, type SourceActionOutcome } from "./ci-gate";

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

function acceptanceCriteria(value: unknown, name = "criteria"): AcceptanceCriterion[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((entry) => {
    const criterion = object(entry);
    return {
      id: string(criterion.id, "criterion.id"),
      text: string(criterion.text, "criterion.text"),
      completed: criterion.completed === true,
    };
  });
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

async function git(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
}

function criteriaFromBody(body: string): string[] {
  try {
    const markdown = parseManagedSections(body).sections["acceptance-criteria"];
    if (!markdown) return [];
    return markdown.split(/\r?\n/).flatMap((line) => {
      const match = /^- \[[ xX]\]\s+(.+?)(?:\s+<!-- conveyor:criterion:[^>]+ -->)?$/.exec(line.trim());
      return match?.[1] ? [match[1]] : [];
    });
  } catch {
    return [];
  }
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

export class ConveyorService {
  readonly store: ConveyorStore;
  readonly github: GitHubAdapter;
  readonly #codeHosts = new Map<string, CodeHost>();
  readonly workspaceManager: WorkspaceManager;
  readonly #active = new Map<string, ActiveRun>();
  readonly #steeringActive = new Map<string, AbortController>();
  readonly #mcpGrants = new Map<string, McpGrant>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #ciMemory = createCiGateMemory();
  readonly #ciProviders = new Map<string, CiProvider>();
  /** Issues polling an external condition (CI); not schedulable before this time. */
  readonly #deferredUntil = new Map<string, number>();
  /** Why a deferred issue is waiting; re-applied after reconciliation resets warnings. */
  readonly #waitReasons = new Map<string, string>();
  #lastReconciledAt: string | null = null;
  #shuttingDown = false;
  #tickRunning = false;
  readonly #runSteering: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;

  constructor(
    readonly config: ConveyorConfig,
    store: ConveyorStore,
    github: GitHubAdapter,
    implementations: ServiceImplementations = {},
  ) {
    this.store = store;
    this.github = github;
    for (const [name, definition] of Object.entries(config.codeHosts ?? {})) {
      if (definition.type === "github") this.#codeHosts.set(name, new GitHubCodeHost(github));
    }
    for (const [name, source] of Object.entries(config.sources ?? {})) {
      if (source.type === "github" && !this.#codeHosts.has(name)) {
        this.#codeHosts.set(name, new GitHubCodeHost(github));
      }
    }
    this.workspaceManager = new WorkspaceManager(config.settings.workspaces);
    this.#runSteering = implementations.steering ?? runCodexSteering;
  }

  static async create(config: ConveyorConfig): Promise<ConveyorService> {
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
      new GitHubAdapter(new GhCliTransport(), config.settings.labelPrefix),
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
          (this.#deferredUntil.get(issue.id) ?? 0) <= Date.now() &&
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
      await executor.execute(issue);
      await this.reconcileRepository(issue.repositoryId);
      await this.updateStatusComment(issue.id);
      this.schedule();
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ExternalWaitError) {
        await this.deferForExternalWait(issue, error);
        return;
      }
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

  private restoreWaitReasons(repositoryId: string): void {
    for (const [issueId, reason] of this.#waitReasons) {
      const issue = this.store.getIssue(issueId);
      if (!issue || issue.repositoryId !== repositoryId) continue;
      if (issue.projectedState !== "active") {
        this.#waitReasons.delete(issueId);
        this.#deferredUntil.delete(issueId);
        continue;
      }
      if (issue.warning) continue;
      this.store.setIssueProjection(issueId, {
        stage: issue.projectedStage,
        state: issue.projectedState,
        warning: reason,
      });
    }
  }

  /** Park an issue whose stage is waiting on an external system; no permit is held meanwhile. */
  private async deferForExternalWait(issue: StoredIssue, error: ExternalWaitError): Promise<void> {
    const current = this.store.getStageState(issue.id);
    if (current) {
      this.store.setStageState({
        issueId: issue.id,
        stageId: current.stageId,
        status: "ready",
        feedbackCycle: current.feedbackCycle,
        configHash: this.config.hash,
      });
    }
    const previous = this.store.getIssue(issue.id)?.warning ?? null;
    this.store.setIssueProjection(issue.id, {
      stage: issue.projectedStage,
      state: "active",
      warning: error.message,
    });
    if (previous !== error.message) {
      await this.updateStatusComment(issue.id).catch((statusError) => {
        console.error(`Status comment for ${issue.id} failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`);
      });
    }
    this.#deferredUntil.set(issue.id, Date.now() + error.retryAfterMs);
    this.#waitReasons.set(issue.id, error.message);
    setTimeout(() => this.schedule(), error.retryAfterMs + 50);
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
    const change: CiChange = { repository: address, changeId: String(stored.number), url: delivery.pullRequest.url };
    const checks = await this.ciProvider(this.store.getIssue(issueId)?.repositoryId ?? "").list(change, delivery.pullRequest.headSha);
    return { change: delivery.change, pullRequest: delivery.pullRequest, checks };
  }

  private ciProvider(repositoryId: string, stageInput?: Record<string, unknown>): CiProvider {
    const repository = this.config.repositories[repositoryId];
    if (!repository) throw new Error(`unknown repository: ${repositoryId}`);
    const providerName = repository.ci ?? "actions";
    // Unreferenced named providers are inert. An omitted repository reference
    // selects its source-native provider with no named-provider configuration.
    const configured = repository.ci ? this.config.ci[repository.ci] : undefined;
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
    return Boolean(stage && stage.run.type === "source-action" && !stage.enterCheck && !stage.exitCheck);
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
    this.restoreWaitReasons(repositoryId);
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
      const workspace = this.store.getActiveWorkspace(parent.id);
      const parentStage = this.store.getStageState(parent.id);
      if (workspace && parentStage?.status !== "running") {
        await this.workspaceManager.remove({
          repositoryPath: this.config.repositories[repositoryId]!.folder,
          workspacePath: workspace.path,
          branch: workspace.branch,
          deleteBranch: true,
        });
        this.store.markWorkspaceRemoved(workspace.id);
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
          const stored = this.store.getActiveWorkspace(context.issue.id);
          if (!stored) return;
          await this.workspaceManager.remove({
            repositoryPath: context.repository.folder,
            workspacePath: stored.path,
            branch: stored.branch,
            deleteBranch: true,
          });
          this.store.markWorkspaceRemoved(stored.id);
          return;
        }
        if (!workspace) throw new Error(`${action.sourceAction} requires a workspace`);
        if (changeOperation === "ensure") {
          const codeHost = this.codeHostFor(context.repository.id);
          if (!codeHost) throw new Error(`repository ${context.repository.id} has no supported code host`);
          const pushed = await codeHost.pushBranch({ address: context.repository.address, workspace });
          if (!pushed.pushed) return { outcome: "failure", status: pushed.status, reason: pushed.reason, summary: pushed.reason };
          const pullRequest = await codeHost.ensureChange({
            address: context.repository.address,
            issueNumber: context.issue.sourceNumber,
            branch: workspace.branch,
            base: context.repository.baseBranch,
            title: context.issue.title,
            closes: action.with?.closingReference !== false,
          });
          this.store.upsertPullRequest({
            issueId: context.issue.id,
            id: pullRequest.id,
            number: pullRequest.number,
            url: pullRequest.url,
            state: pullRequest.state,
          });
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
    const pushed = await codeHost.pushBranch({ address: context.repository.address, workspace });
    if (!pushed.pushed) return { outcome: "failure", status: pushed.status, reason: pushed.reason, summary: pushed.reason };
    const pullRequest = await codeHost.ensureChange({
      address: context.repository.address,
      issueNumber: context.issue.sourceNumber,
      branch: workspace.branch,
      base: context.repository.baseBranch,
      title: context.issue.title,
      closes: input?.closingReference !== false,
    });
    this.store.upsertPullRequest({
      issueId: context.issue.id,
      id: pullRequest.id,
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state,
    });
    const outcome = await evaluateCiGate({
      change: { repository: context.repository.address, changeId: String(pullRequest.number), url: pullRequest.url },
      issueKey: context.issue.id,
      options,
      provider: this.ciProvider(context.issue.repositoryId, input),
      headSha: (await codeHost.getChange({ address: context.repository.address, id: pullRequest.id })).headSha,
      memory: this.#ciMemory,
      now: Date.now(),
    });
    this.#deferredUntil.delete(context.issue.id);
    this.#waitReasons.delete(context.issue.id);
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

  /** Failing (or named) CI job logs for the issue's PR head, read on the agent's behalf. */
  private async checkLogs(
    issueId: string,
    address: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const stored = this.store.getCurrentPullRequest(issueId);
    if (!stored) return { change: null, pullRequest: null, checks: [], note: "No pull request exists yet; CI runs after implementation opens it." };
    const repositoryId = this.store.getIssue(issueId)?.repositoryId;
    const codeHost = repositoryId ? this.codeHostFor(repositoryId) : null;
    if (!codeHost) throw new Error(`no code host configured for ${issueId}`);
    const { headSha: sha } = await codeHost.getChange({ address, id: stored.id });
    const requested = typeof input.checkName === "string" ? input.checkName : null;
    const lines = Math.min(Math.max(typeof input.lines === "number" ? Math.floor(input.lines) : 200, 20), 1_000);
    const change: CiChange = { repository: address, changeId: String(stored.number), url: stored.url };
    const provider = this.ciProvider(this.store.getIssue(issueId)?.repositoryId ?? "");
    const runs = await provider.list(change, sha);
    const selected = runs.filter((run) => requested
      ? run.name === requested
      : run.state === "failed" || run.state === "cancelled");
    const checks = [];
    for (const run of selected.slice(0, 5)) {
      let log: string | null = null;
      if (run.hasLog) {
        log = await provider.log(change, run.id, lines)
          .catch((error) => `(log unavailable: ${error instanceof Error ? error.message : String(error)})`);
      }
      checks.push({ ...run, log });
    }
    const changeRequest = await codeHost.getChange({ address, id: stored.id });
    return {
      change: changeRequest,
      pullRequest: { number: stored.number, url: stored.url, headSha: sha },
      checks,
    };
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
      const requestedLimit = input.limit === undefined ? 100 : number(input.limit, "limit");
      return {
        issueId: grant.context.issue.id,
        messages: this.store.listConversationMessages(
          grant.context.issue.id,
          Math.min(requestedLimit, 100),
        ),
      };
    }
    if (tool.startsWith("run.report_") || tool === "run.ask_question" || tool === "run.record_artifact" || tool === "run.report_milestone") {
      if (tool === "run.ask_question") {
        if (!grant.context) throw new Error("structured questions require an issue-scoped MCP grant");
        const issue = grant.context.issue;
        const options = Array.isArray(input.options) ? input.options : [];
        const question = this.store.openQuestion({
          issueId: issue.id,
          runId: grant.runId,
          prompt: string(input.prompt, "prompt"),
          reason: string(input.reason, "reason"),
          options,
          minSelections: typeof input.minSelections === "number" ? input.minSelections : 1,
          maxSelections: typeof input.maxSelections === "number" ? input.maxSelections : 1,
          allowFreeText: input.allowFreeText === true,
        });
        this.store.appendRunEvent(grant.runId, "question", { questionId: question.id });
        await this.updateStatusComment(issue.id);
        return { accepted: true, questionId: question.id };
      }
      this.store.appendRunEvent(grant.runId, tool.slice("run.".length), input);
      if (tool === "run.report_progress" && grant.context && grant.actor) {
        this.store.appendConversationMessage({
          issueId: grant.context.issue.id,
          runId: grant.runId,
          stageId: grant.stageId,
          actorType: "agent",
          actorId: grant.actor.id,
          actorName: grant.actor.name,
          actorTitle: grant.actor.title,
          message: string(input.message, "message"),
        });
      }
      return { accepted: true };
    }

    if (!grant.context) throw new Error(`${tool} requires an issue-scoped MCP grant`);
    const issue = grant.context.issue;
    const address = grant.context.repository.address;

    if (tool === "source.get_issue") {
      return this.github.getIssue(address, issue.sourceNumber);
    }
    if (tool === "delivery.get_state") {
      return this.loadDeliveryState(issue.id, address);
    }
    if (tool === "delivery.get_check_logs") {
      return this.checkLogs(issue.id, address, input);
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
      if (tool === "source.add_comment") {
        result = { commentId: await this.github.addComment(address, issue.sourceNumber, string(input.markdown, "markdown")) };
      } else if (tool === "source.set_acceptance_criteria") {
        const criteria = acceptanceCriteria(input.criteria);
        const current = await this.github.getIssue(address, issue.sourceNumber);
        const updated = await this.github.updateManagedSection({
          address,
          issueNumber: issue.sourceNumber,
          section: "acceptance-criteria",
          markdown: formatAcceptanceCriteria(criteria),
          expectedRevision: this.github.managedRevision(current.body),
        });
        result = { revision: this.github.managedRevision(updated.body) };
      } else if (tool === "source.create_child") {
        const repository = this.config.repositories[issue.repositoryId]!;
        const pipeline = this.config.pipelines[repository.pipeline]!;
        const currentIndex = pipeline.stages.findIndex((stage) => stage.id === grant.stageId);
        const nextStage = pipeline.stages[currentIndex + 1]?.id ?? pipeline.stages[currentIndex]?.id;
        const requestedLabels = Array.isArray(input.systemLabels)
          ? input.systemLabels.filter((value): value is string => typeof value === "string" && repository.systemLabels.includes(value))
          : [];
        const criteria = acceptanceCriteria(input.acceptanceCriteria, "acceptanceCriteria");
        if (criteria.length === 0) {
          throw new Error("acceptanceCriteria must contain at least one criterion");
        }
        const suppliedBody = typeof input.body === "string" ? input.body : "";
        const body = upsertManagedSection(
          suppliedBody,
          "acceptance-criteria",
          formatAcceptanceCriteria(criteria),
          parseManagedSections(suppliedBody).revision,
        );
        const child = await this.github.createChildIssue({
          address,
          parentNumber: issue.sourceNumber,
          title: string(input.title, "title"),
          body,
          labels: [
            this.config.labels.enrollment,
            ...(nextStage ? [this.config.labels.stageTemplate.replace("{stage}", nextStage)] : []),
            ...requestedLabels,
          ],
        });
        result = child;
      } else if (tool === "source.set_parent") {
        await this.github.setParent({
          address,
          childNumber: issue.sourceNumber,
          parentNumber: number(input.parentNumber, "parentNumber"),
        });
      } else if (tool === "source.set_dependencies") {
        const dependencies = Array.isArray(input.issueNumbers)
          ? input.issueNumbers.map((value) => number(value, "dependency issue number"))
          : [];
        for (const blockerNumber of dependencies) {
          await this.github.addDependency({
            address,
            issueNumber: issue.sourceNumber,
            blockerNumber,
          });
        }
        const current = await this.github.getIssue(address, issue.sourceNumber);
        await this.github.updateManagedSection({
          address,
          issueNumber: issue.sourceNumber,
          section: "dependencies",
          markdown: formatDependencies(dependencies.map((value) => ({ number: value }))),
          expectedRevision: this.github.managedRevision(current.body),
        });
      } else if (tool === "source.set_labels") {
        const labels = Array.isArray(input.labels)
          ? input.labels.filter((value): value is string =>
              typeof value === "string" &&
              (value === this.config.labels.enrollment || value.startsWith(`${this.config.labels.enrollment}:`)),
            )
          : [];
        await this.github.replaceConveyorLabels(address, issue.sourceNumber, labels);
      } else if (tool === "source.set_system_labels") {
        const repository = this.config.repositories[issue.repositoryId]!;
        const selected = Array.isArray(input.labels)
          ? input.labels.filter((value): value is string =>
              typeof value === "string" && repository.systemLabels.includes(value)
            )
          : [];
        await this.github.replaceManagedProjectLabels(
          address,
          issue.sourceNumber,
          repository.systemLabels,
          selected,
        );
      } else if (tool === "workspace.request_fetch" || tool === "workspace.request_push") {
        if (!grant.context.workspace) throw new Error("run has no workspace");
        const forceWithLease = tool === "workspace.request_push" && input.forceWithLease === true;
        await git(
          grant.context.workspace.path,
          tool.endsWith("fetch")
            ? ["fetch", "origin", grant.context.repository.baseBranch]
            : [
                "push",
                "--set-upstream",
                ...(forceWithLease ? ["--force-with-lease"] : []),
                "origin",
                grant.context.workspace.branch,
              ],
        );
      } else if (tool === "workspace.record_artifact" || tool === "source.set_pull_request_metadata") {
        this.store.appendRunEvent(grant.runId, tool, input);
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
        if (stage.run?.type !== "agent") {
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
      const stage = pipeline?.stages.find((candidate) => candidate.id === stageId);
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
