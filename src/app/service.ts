import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { reconcileRepository } from "../core/reconciler";
import { selectRunnableIssues, type SchedulerCandidate } from "../core/scheduler";
import { ConveyorStore, type StoredIssue } from "../db/store";
import { formatAcceptanceCriteria, formatDependencies, parseManagedSections } from "../source/github/managed-sections";
import { GhCliTransport, GitHubAdapter, verifyGitHubSignature } from "../source/github/adapter";
import { renderStatusComment } from "../source/github/status-comment";
import { runCodexSteering, type CodexSteeringInput } from "../runner/codex-steering";
import { WorkspaceManager } from "../workspace/manager";
import type { DashboardPageSelection, DashboardViewModel, IssueActivityViewModel, IssueCardViewModel, IssueRelationViewModel, IssueTone, QuestionViewModel, StageColumnViewModel } from "../web/types";
import type { WebAuthApi, WebHandlerDependencies } from "../web/server";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";

interface ActiveRun {
  repositoryId: string;
  stageId: string;
  controller: AbortController;
}

interface McpGrant {
  runId: string;
  stageId: string;
  context: RuntimeIssueContext;
  allowedTools: Set<string>;
}

interface ServiceImplementations {
  steering?: (input: CodexSteeringInput) => ReturnType<typeof runCodexSteering>;
}

const SOURCE_GUIDANCE = `GitHub is the source of truth. Use only Conveyor MCP tools for source mutations. Never close an issue. Preserve human-authored body text, use managed sections for acceptance criteria and dependencies, and report blockers with a concrete reason.`;
const DASHBOARD_PAGE_SIZE = 20;

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

function steeringProgress(event: unknown): string | null {
  try {
    const record = object(event);
    if (record.type === "error" && typeof record.message === "string") {
      return record.message;
    }
    if (record.type !== "item.started" && record.type !== "item.completed") {
      return null;
    }
    const item = object(record.item);
    const prefix = record.type === "item.started" ? "Running" : "Completed";
    if (item.type === "command_execution" && typeof item.command === "string") {
      return `${prefix}: ${item.command}`;
    }
    if (item.type === "mcp_tool_call" && typeof item.tool === "string") {
      return `${prefix} tool: ${item.tool}`;
    }
    if (item.type === "file_change") return "Updated files in the configured workspace.";
    return null;
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
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }
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
  readonly workspaceManager: WorkspaceManager;
  readonly #active = new Map<string, ActiveRun>();
  readonly #steeringActive = new Map<string, AbortController>();
  readonly #mcpGrants = new Map<string, McpGrant>();
  readonly #repositoryErrors = new Map<string, string>();
  readonly #onboardingErrors = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
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
          !this.#repositoryErrors.has(issue.repositoryId),
        dependenciesSatisfied,
        rollupOnly: this.store.listChildren(issue.id).length > 0,
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
    for (const active of this.#active.values()) {
      stageUsage[active.stageId] = (stageUsage[active.stageId] ?? 0) + 1;
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
        global: this.#active.size,
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
      sourceGuidance: SOURCE_GUIDANCE,
      signal,
      runtime: (context) => new ConfiguredStageRuntime(
        this.config,
        this.store,
        context,
        this.mcpFactory(),
        this.sourceActions(context),
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
          issue.sourceState === "open" && issue.projectedState === "active",
      );
    const parents = new Map<string, { parentId: string; siblingOrder: number }>();
    for (const parent of issues) {
      const children = await this.github.listSubIssues(address, parent.sourceNumber);
      for (const [index, child] of children.entries()) {
        if (this.store.getIssue(child.id)) {
          parents.set(child.id, { parentId: parent.id, siblingOrder: index + 1 });
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
      for (const dependency of dependencies) {
        if (this.store.getIssue(dependency.id)) continue;
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
      }
      this.store.replaceRelationships(
        issue.id,
        parents.get(issue.id) ?? null,
        dependencies.map((dependency) => dependency.id),
      );
    }
    const doneLabel = this.config.labels.states.done;
    if (!doneLabel) return;
    const satisfied = (issueId: string, visited = new Set<string>()): boolean => {
      if (visited.has(issueId)) return false;
      const issue = this.store.getIssue(issueId);
      if (!issue) return false;
      if (issue.sourceState === "closed" || issue.labels.includes(doneLabel)) return true;
      const children = this.store.listChildren(issueId);
      if (children.length === 0) return false;
      const next = new Set(visited).add(issueId);
      return children.every((child) => satisfied(child.issueId, next));
    };
    for (const parent of issues) {
      const children = this.store.listChildren(parent.id);
      if (
        children.length === 0 ||
        !parent.labels.includes(this.config.labels.enrollment)
      ) {
        continue;
      }
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
      if (
        children.every((child) => satisfied(child.issueId)) &&
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
      create: async ({ runId, stageId, context, allowedTools }) => {
        const token = randomBytes(32).toString("base64url");
        this.#mcpGrants.set(token, {
          runId,
          stageId,
          context,
          allowedTools: new Set(allowedTools),
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

  private sourceActions(context: RuntimeIssueContext): SourceActionHandler {
    return {
      run: async (action) => {
        const workspace = context.workspace;
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
        if (action.sourceAction === "pullRequest.ensure") {
          await git(workspace.path, ["push", "--set-upstream", "origin", workspace.branch]);
          const pullRequest = await this.github.ensurePullRequest({
            address: context.repository.address,
            issueNumber: context.issue.sourceNumber,
            branch: workspace.branch,
            baseBranch: context.repository.baseBranch,
            title: context.issue.title,
            closingReference: action.with?.closingReference !== false,
          });
          this.store.upsertPullRequest({
            issueId: context.issue.id,
            id: `github:${context.repository.address}#pr-${pullRequest.number}`,
            number: pullRequest.number,
            url: pullRequest.url,
            state: pullRequest.state,
          });
          return;
        }
        if (action.sourceAction === "pullRequest.squashMerge") {
          const pullRequest = await this.github.ensurePullRequest({
            address: context.repository.address,
            issueNumber: context.issue.sourceNumber,
            branch: workspace.branch,
            baseBranch: context.repository.baseBranch,
            title: context.issue.title,
            closingReference: true,
          });
          const merged = await this.github.squashMerge(context.repository.address, pullRequest.number);
          if (!merged.merged) throw new Error(`GitHub did not merge pull request #${pullRequest.number}`);
          this.store.upsertPullRequest({
            issueId: context.issue.id,
            id: `github:${context.repository.address}#pr-${pullRequest.number}`,
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

  async handleMcp(payload: unknown, token: string): Promise<unknown> {
    const grant = this.#mcpGrants.get(token);
    if (!grant) throw new Error("expired MCP grant");
    const request = object(payload);
    const tool = string(request.tool, "tool");
    if (!grant.allowedTools.has(tool)) throw new Error(`MCP tool is not granted: ${tool}`);
    const input = object(request.input ?? {});
    const issue = grant.context.issue;
    const address = grant.context.repository.address;

    if (tool.startsWith("run.report_") || tool === "run.ask_question" || tool === "run.record_artifact" || tool === "run.report_milestone") {
      if (tool === "run.ask_question") {
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
      return { accepted: true };
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
        const criteria = (Array.isArray(input.criteria) ? input.criteria : []).map((value) => {
          const criterion = object(value);
          return {
            id: string(criterion.id, "criterion.id"),
            text: string(criterion.text, "criterion.text"),
            completed: criterion.completed === true,
          };
        });
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
        const requestedLabels = Array.isArray(input.labels)
          ? input.labels.filter((value): value is string => typeof value === "string" && repository.systemLabels.includes(value))
          : [];
        const child = await this.github.createChildIssue({
          address,
          parentNumber: issue.sourceNumber,
          title: string(input.title, "title"),
          body: typeof input.body === "string" ? input.body : "",
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
      } else if (tool === "workspace.request_fetch" || tool === "workspace.request_push") {
        if (!grant.context.workspace) throw new Error("run has no workspace");
        await git(
          grant.context.workspace.path,
          tool.endsWith("fetch")
            ? ["fetch", "origin", grant.context.repository.baseBranch]
            : ["push", "--set-upstream", "origin", grant.context.workspace.branch],
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
    try {
      const instructions = await readFile(agent.instructions, "utf8");
      const result = await this.#runSteering({
        command: runner.command,
        workspace,
        prompt: [
          instructions.trim(),
          "",
          "You are the authenticated Conveyor steering agent. Work only within the user's request.",
          "Inspect current state before changing it. Never close source issues. Finish with a concise report of actions, verification, and anything still unresolved.",
          "",
          "User request:",
          userPrompt,
        ].join("\n"),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: agent.workspaceAccess === "read-only" ? "read-only" : runner.sandbox,
        automaticApprovals: runner.automaticApprovals,
        interruptGraceMs: this.config.settings.interruptGraceMs,
        signal,
        onEvent: (event) => {
          const text = steeringProgress(event);
          if (text) this.store.appendRunEvent(runId, "activity", { text });
        },
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
      try {
        const payload = object(event.payload);
        return typeof payload.text === "string"
          ? [{ ...event, text: payload.text }]
          : [];
      } catch {
        return [];
      }
    });
  }

  reorderBacklog(issueId: string, direction: "up" | "down"): void {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.parentId) throw new Error("only top-level issues can be reordered");
    const repository = this.config.repositories[issue.repositoryId];
    const firstStage = repository
      ? this.config.pipelines[repository.pipeline]?.stages[0]?.id
      : undefined;
    if (!firstStage || issue.projectedStage !== firstStage) {
      throw new Error("only backlog issues can be reordered");
    }
    this.store.moveQueueIssue(issueId, direction);
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
    },
  ): DashboardViewModel {
    const issues = this.store.listIssues().filter((issue) => issue.projectedState !== "offboarded");
    const activeRuns = this.store.listActiveIssueRuns();
    const activeIssueIds = new Set(activeRuns.map((run) => run.issueId));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const relation = (issue: StoredIssue): IssueRelationViewModel => ({
      number: issue.sourceNumber,
      title: issue.title,
      url: issue.sourceUrl,
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
        duration: cost.durationMs > 0 ? `${Math.round(cost.durationMs / 1000)}s` : null,
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
    const configuredStages = new Set(stages);
    const closedIssues = issues.filter((issue) => issue.sourceState === "closed");
    const openIssues = issues.filter((issue) => issue.sourceState !== "closed");
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
    const backlogIssues = openIssues.filter((issue) => {
      if (issue.parentId || !issue.labels.includes(this.config.labels.enrollment)) return false;
      if (sourceStages(issue).length !== 0 || issue.projectedState !== "active") return false;
      const stageState = this.store.getStageState(issue.id);
      return firstStages.has(issue.projectedStage ?? "") &&
        stageState?.status === "ready" &&
        !this.store.getActiveWorkspace(issue.id);
    });
    const backlogIds = new Set(backlogIssues.map((issue) => issue.id));
    const stagedIssues = openIssues.filter((issue) =>
      !backlogIds.has(issue.id) &&
      issue.projectedStage !== null &&
      configuredStages.has(issue.projectedStage) &&
      issue.projectedState !== "inconsistent" &&
      (sourceStages(issue).length === 1 || issue.projectedState === "active"),
    );
    const stagedIds = new Set(stagedIssues.map((issue) => issue.id));
    const attentionIssues = openIssues.filter((issue) =>
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
    ): StageColumnViewModel => {
      const totalPages = Math.max(1, Math.ceil(columnIssues.length / DASHBOARD_PAGE_SIZE));
      const requestedPage = pagination.column === id ? pagination.page : 1;
      const page = Math.min(Math.max(1, requestedPage), totalPages);
      const offset = (page - 1) * DASHBOARD_PAGE_SIZE;
      return {
        id,
        name,
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
            try {
              const payload = object(event.payload);
              return typeof payload.text === "string"
                ? [{
                    sequence: event.sequence,
                    type: event.type,
                    text: payload.text,
                    createdAt: event.createdAt,
                  }]
                : [];
            } catch {
              return [];
            }
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
        )),
      backlog: backlogIssues.map((issue) => card(issue)),
      done: {
        id: "done",
        name: "Done",
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
      csrfToken,
    };
  }

  issueActivity(issueId: string): IssueActivityViewModel | null {
    const issue = this.store.getIssue(issueId);
    if (!issue || issue.projectedState === "offboarded") return null;
    return {
      issueId,
      runs: this.store.listIssueRuns(issueId).map((run) => ({
        id: run.id,
        stageId: run.stageId,
        attempt: run.attempt,
        kind: run.kind,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        result: run.result,
        events: this.store.listRunEvents(run.id),
      })),
    };
  }

  webDependencies(auth: WebAuthApi, username: string): WebHandlerDependencies {
    const githubSource = Object.values(this.config.sources).find((source) => source.type === "github");
    return {
      auth,
      username,
      getDashboard: (csrfToken, pagination) => this.dashboard(csrfToken, pagination),
      getDashboardRevision: () => this.store.dashboardRevision(),
      isReady: () =>
        Boolean(this.#lastReconciledAt) &&
        !this.#shuttingDown &&
        this.#repositoryErrors.size === 0 &&
        this.#onboardingErrors.size === 0,
      webhookPath: githubSource?.webhookPath ?? "/hooks/github",
      answerQuestion: (id, answer) => this.answerQuestion(id, answer),
      reorderBacklog: (id, direction) => this.reorderBacklog(id, direction),
      handleWebhook: (body, headers) => this.handleWebhook(body, headers),
      handleMcp: (body, token) => this.handleMcp(body, token),
      startSteering: (prompt) => this.startSteering(prompt),
      getSteeringRun: (runId) => this.getSteeringRun(runId),
      getSteeringEvents: (runId, after) => this.getSteeringEvents(runId, after),
      getIssueActivity: (issueId) => this.issueActivity(issueId),
    };
  }
}
