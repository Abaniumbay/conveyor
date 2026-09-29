import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { reconcileRepository } from "../core/reconciler";
import { selectRunnableIssues, type SchedulerCandidate } from "../core/scheduler";
import { ConveyorStore, type StoredIssue } from "../db/store";
import { formatAcceptanceCriteria, formatDependencies, parseManagedSections } from "../source/github/managed-sections";
import { GhCliTransport, GitHubAdapter, verifyGitHubSignature } from "../source/github/adapter";
import { WorkspaceManager } from "../workspace/manager";
import type { DashboardViewModel, IssueCardViewModel, QuestionViewModel } from "../web/types";
import type { WebAuthApi, WebHandlerDependencies } from "../web/server";
import { ConfiguredStageRuntime, ensureRuntimeDirectories, type RuntimeIssueContext, type ScopedMcpFactory, type SourceActionHandler } from "./runtime";
import { IssueExecutor } from "./issue-executor";

interface ActiveRun {
  repositoryId: string;
  stageId: string;
}

interface McpGrant {
  runId: string;
  stageId: string;
  context: RuntimeIssueContext;
  allowedTools: Set<string>;
}

const SOURCE_GUIDANCE = `GitHub is the source of truth. Use only Conveyor MCP tools for source mutations. Never close an issue. Preserve human-authored body text, use managed sections for acceptance criteria and dependencies, and report blockers with a concrete reason.`;

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
  readonly #mcpGrants = new Map<string, McpGrant>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastReconciledAt: string | null = null;
  #shuttingDown = false;
  #tickRunning = false;

  constructor(
    readonly config: ConveyorConfig,
    store: ConveyorStore,
    github: GitHubAdapter,
  ) {
    this.store = store;
    this.github = github;
    this.workspaceManager = new WorkspaceManager(config.settings.workspaces);
  }

  static async create(config: ConveyorConfig): Promise<ConveyorService> {
    await ensureRuntimeDirectories(config);
    const store = await ConveyorStore.open(config.settings.database);
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
    }
  }

  async reconcileAll(): Promise<void> {
    for (const [id, repository] of Object.entries(this.config.repositories)) {
      const pipeline = this.config.pipelines[repository.pipeline]!;
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
    }
    this.#lastReconciledAt = new Date().toISOString();
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
    while (this.#active.size > 0) await Bun.sleep(25);
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
          !this.#active.has(issue.id),
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
      });
      void this.execute(issue).finally(() => {
        this.#active.delete(issue.id);
      });
    }
  }

  private async execute(issue: StoredIssue): Promise<void> {
    const repository = this.config.repositories[issue.repositoryId];
    if (!repository) return;
    const executor = new IssueExecutor({
      config: this.config,
      store: this.store,
      sourceName: repository.source,
      source: this.github,
      workspaceManager: this.workspaceManager,
      sourceGuidance: SOURCE_GUIDANCE,
      runtime: (context) => new ConfiguredStageRuntime(
        this.config,
        this.store,
        context,
        this.mcpFactory(),
        this.sourceActions(context),
      ),
    });
    try {
      await executor.execute(issue);
      await this.reconcileRepository(issue.repositoryId);
      this.schedule();
    } catch (error) {
      this.store.setIssueProjection(issue.id, {
        stage: issue.projectedStage,
        state: "active",
        warning: `Execution failed and will retry: ${error instanceof Error ? error.message : String(error)}`,
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
  }

  private async reconcileRelationships(
    repositoryId: string,
    address: string,
  ): Promise<void> {
    const issues = this.store
      .listIssues(repositoryId)
      .filter((issue) => issue.projectedState !== "offboarded");
    const parents = new Map<string, { parentId: string; siblingOrder: number }>();
    for (const parent of issues) {
      const children = await this.github.listSubIssues(address, parent.sourceNumber);
      for (const [index, child] of children.entries()) {
        if (this.store.getIssue(child.id)) {
          parents.set(child.id, { parentId: parent.id, siblingOrder: index + 1 });
        }
      }
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
        await this.github.replaceConveyorLabels(address, parent.sourceNumber, [
          this.config.labels.enrollment,
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
      this.schedule();
    }
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

  dashboard(csrfToken: string): DashboardViewModel {
    const issues = this.store.listIssues().filter((issue) => issue.projectedState !== "offboarded");
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const card = (issue: StoredIssue, visited = new Set<string>()): IssueCardViewModel => {
      if (visited.has(issue.id)) throw new Error(`issue hierarchy cycle at ${issue.id}`);
      const nextVisited = new Set(visited).add(issue.id);
      const state = this.store.getStageState(issue.id);
      const cost = this.store.costSummary({ issueId: issue.id });
      const children = this.store.listChildren(issue.id)
        .flatMap(({ issueId }) => {
          const child = byId.get(issueId);
          return child ? [card(child, nextVisited)] : [];
        });
      return {
        id: issue.id,
        number: issue.sourceNumber,
        title: issue.title,
        url: issue.sourceUrl,
        state: issue.projectedState ?? issue.sourceState,
        labels: issue.labels,
        acceptanceCriteria: criteriaFromBody(issue.body),
        activity: state ? `${state.stageId} · ${state.status}` : null,
        reason: issue.warning,
        cost:
          cost.runs === 0
            ? null
            : cost.unavailableRuns === cost.runs
              ? `unavailable · ${cost.runs} run${cost.runs === 1 ? "" : "s"}`
              : `$${cost.amount.toFixed(4)} · ${cost.runs} runs`,
        duration: cost.durationMs > 0 ? `${Math.round(cost.durationMs / 1000)}s` : null,
        blocked: ["blocked", "error", "needs-input", "needs-intervention"].includes(issue.projectedState ?? ""),
        inconsistent: Boolean(issue.warning),
        closable: issue.labels.includes(this.config.labels.metadata.closable),
        children,
      };
    };
    const topLevel = issues.filter((issue) => !issue.parentId);
    const firstStages = new Set(Object.values(this.config.repositories).flatMap((repository) => {
      const first = this.config.pipelines[repository.pipeline]?.stages[0]?.id;
      return first ? [first] : [];
    }));
    const stages = [...new Set(Object.values(this.config.pipelines).flatMap((pipeline) =>
      pipeline.stages.map((stage) => stage.id),
    ))].filter((stage) => !firstStages.has(stage));
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
    return {
      title: "Conveyor",
      project: `${Object.keys(this.config.repositories).length} repositories · ${total.runs} runs · ${total.unavailableRuns === total.runs && total.runs > 0 ? "cost unavailable" : `$${total.amount.toFixed(4)}`}`,
      updatedAt: this.#lastReconciledAt ?? new Date().toISOString(),
      stages: stages.map((stage) => ({
        name: stage,
        issues: topLevel.filter((issue) => issue.projectedStage === stage).map((issue) => card(issue)),
      })),
      backlog: topLevel.filter((issue) => issue.projectedStage && firstStages.has(issue.projectedStage)).map((issue) => card(issue)),
      questions,
      csrfToken,
    };
  }

  webDependencies(auth: WebAuthApi, username: string): WebHandlerDependencies {
    const githubSource = Object.values(this.config.sources).find((source) => source.type === "github");
    return {
      auth,
      username,
      getDashboard: (csrfToken) => this.dashboard(csrfToken),
      isReady: () => Boolean(this.#lastReconciledAt) && !this.#shuttingDown,
      webhookPath: githubSource?.webhookPath ?? "/hooks/github",
      answerQuestion: (id, answer) => this.answerQuestion(id, answer),
      reorderBacklog: (id, direction) => this.reorderBacklog(id, direction),
      handleWebhook: (body, headers) => this.handleWebhook(body, headers),
      handleMcp: (body, token) => this.handleMcp(body, token),
    };
  }
}
