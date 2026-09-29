import { randomUUID } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { PipelineEngine, type PipelineDependencies, type StageExecutionResult } from "../core/pipeline";
import { applyStageTransition, type TransitionSource } from "../core/transition";
import type { ConveyorStore, StoredIssue } from "../db/store";
import type { WorkspaceManager } from "../workspace/manager";
import type { RuntimeIssueContext } from "./runtime";

export interface IssueExecutorDependencies {
  config: ConveyorConfig;
  store: ConveyorStore;
  sourceName: string;
  source: TransitionSource;
  workspaceManager: Pick<WorkspaceManager, "create">;
  loadDeliveryState?: (
    issue: StoredIssue,
    repository: { id: string; address: string; folder: string; baseBranch: string },
  ) => Promise<{ pullRequest: unknown | null; checks: unknown[] }>;
  runtime: (context: RuntimeIssueContext) => PipelineDependencies;
  sourceGuidance: string;
  signal?: AbortSignal;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "issue";
}

export class IssueExecutor {
  constructor(private readonly dependencies: IssueExecutorDependencies) {}

  async execute(issue: StoredIssue): Promise<StageExecutionResult> {
    const repositoryEntry = Object.entries(this.dependencies.config.repositories)
      .find(([, repository]) => repository.address && issue.repositoryId === repository.address);
    const fallbackEntry = Object.entries(this.dependencies.config.repositories)
      .find(([name]) => name === issue.repositoryId);
    const [repositoryId, repository] = repositoryEntry ?? fallbackEntry ?? [];
    if (!repositoryId || !repository) {
      throw new Error(`issue ${issue.id} references unknown repository ${issue.repositoryId}`);
    }
    const pipeline = this.dependencies.config.pipelines[repository.pipeline];
    if (!pipeline) throw new Error(`unknown pipeline: ${repository.pipeline}`);
    const stageId = issue.projectedStage ?? pipeline.stages[0]?.id;
    if (!stageId) throw new Error(`pipeline ${repository.pipeline} has no stage`);
    const state = this.dependencies.store.getStageState(issue.id);
    if (state?.status !== "ready" || state.stageId !== stageId) {
      throw new Error(`issue ${issue.id} is not ready at stage ${stageId}`);
    }

    const enrollment = this.dependencies.store.activateEnrollment(issue.id);
    let workspace = this.dependencies.store.getActiveWorkspace(issue.id);
    if (!workspace) {
      const created = await this.dependencies.workspaceManager.create({
        repositoryPath: repository.folder,
        repositoryId,
        issueNumber: issue.sourceNumber,
        enrollment: enrollment.generation,
        slug: slug(issue.title),
        baseBranch: repository.baseBranch,
      });
      this.dependencies.store.recordWorkspace({
        id: randomUUID(),
        enrollmentId: enrollment.id,
        path: created.path,
        branch: created.branch,
        status: "active",
      });
      workspace = this.dependencies.store.getActiveWorkspace(issue.id);
    }
    if (!workspace) throw new Error(`workspace for issue ${issue.id} was not recorded`);

    this.dependencies.store.setStageState({
      issueId: issue.id,
      stageId,
      status: "running",
      feedbackCycle: state.feedbackCycle,
      configHash: this.dependencies.config.hash,
    });
    const runtimeRepository = {
      id: repositoryId,
      address: repository.address,
      folder: repository.folder,
      baseBranch: repository.baseBranch,
    };
    const storedPullRequest = this.dependencies.store.getCurrentPullRequest(issue.id);
    const delivery = this.dependencies.loadDeliveryState
      ? await this.dependencies.loadDeliveryState(issue, runtimeRepository)
      : {
          pullRequest: storedPullRequest
            ? {
                number: storedPullRequest.number,
                url: storedPullRequest.url,
                state: storedPullRequest.state,
                mergedAt: storedPullRequest.mergedAt,
              }
            : null,
          checks: [],
        };
    const context: RuntimeIssueContext = {
      issue,
      repository: runtimeRepository,
      workspace: { path: workspace.path, branch: workspace.branch },
      sourceGuidance: this.dependencies.sourceGuidance,
      delivery,
    };
    const engine = new PipelineEngine(
      pipeline,
      this.dependencies.runtime(context),
      this.dependencies.config.settings.feedbackCycles,
    );
    const transitionId = randomUUID();
    try {
      this.dependencies.signal?.throwIfAborted();
      const result = await engine.executeStage(stageId, {
        issue: issue as unknown as Record<string, unknown>,
        workspace: workspace.path,
      });
      this.dependencies.signal?.throwIfAborted();
      await applyStageTransition({
        store: this.dependencies.store,
        source: this.dependencies.source,
        sourceName: this.dependencies.sourceName,
        address: repository.address,
        configHash: this.dependencies.config.hash,
        transitionId,
        issue,
        stages: pipeline.stages.map((stage) => stage.id),
        labels: this.dependencies.config.labels,
        result,
        actor: (() => {
          const stage = pipeline.stages.find((candidate) => candidate.id === stageId);
          if (stage?.run.type === "agent") {
            const agent = this.dependencies.config.agents[stage.run.agent];
            return {
              name: agent?.name ?? stage.run.agent,
              title: agent?.title ?? "AI Agent",
            };
          }
          return {
            name: "Conveyor",
            title: stage?.run.type === "script" ? "Script" : "Orchestrator",
          };
        })(),
      });
      return result;
    } catch (error) {
      this.dependencies.store.setStageState({
        issueId: issue.id,
        stageId,
        status: this.dependencies.signal?.aborted ? "interrupted" : "error",
        feedbackCycle: state.feedbackCycle,
        configHash: this.dependencies.config.hash,
      });
      throw error;
    }
  }
}
