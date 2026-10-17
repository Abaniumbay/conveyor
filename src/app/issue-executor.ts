import { randomUUID } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import type { PipelineDependencies } from "../core/pipeline";
import { applyStageTransition, type TransitionSource } from "../core/transition";
import type { ConveyorStore, StoredIssue } from "../db/store";
import { StageExecutor, type ManualGateResolver, type StageOutcome } from "../engine/stage-executor";
import { CONTEXT_SCHEMA_VERSION, type TaskContext } from "../tasks/context";
import { createTaskRegistry } from "../tasks/catalogue";
import type { TaskDeps } from "../tasks/deps";
import type { LegacyRuntime } from "../tasks/legacy";
import { displayName } from "../tasks/agent-support";
import { compilePipeline, stagePlanHash, type CompiledPipeline, type CompiledStage } from "../tasks/plan";
import { createWorkspace } from "../workspace/lifecycle";
import type { WorkspaceManager } from "../workspace/manager";
import type { RuntimeDeliveryState, RuntimeIssueContext } from "./runtime";
import type { WaitKind } from "../events/topics";

export interface IssueExecutorDependencies {
  config: ConveyorConfig;
  store: ConveyorStore;
  sourceName: string;
  source: TransitionSource;
  workspaceManager: Pick<WorkspaceManager, "create">;
  loadDeliveryState?: (
    issue: StoredIssue,
    repository: { id: string; address: string; folder: string; baseBranch: string },
  ) => Promise<RuntimeDeliveryState>;
  runtime: (
    context: RuntimeIssueContext,
    refreshDeliveryState: () => Promise<RuntimeDeliveryState>,
  ) => PipelineDependencies;
  sourceGuidance: string;
  /** Builds the dependencies native-stage tasks receive; legacy stages use `runtime` instead. */
  taskDeps?: (
    issue: StoredIssue,
    repository: { id: string; address: string; folder: string; baseBranch: string },
  ) => TaskDeps;
  /** Resolves the durable human-approval state for native exit gates. */
  manualGate?: ManualGateResolver;
  /** The fallback deadline of an event wait in a repository; null while it must poll. */
  waitFallback?: (repositoryId: string, kind: WaitKind) => number | null;
  signal?: AbortSignal;
}

export class IssueExecutor {
  constructor(private readonly dependencies: IssueExecutorDependencies) {}

  #plan(repositoryId: string): CompiledPipeline {
    const { config } = this.dependencies;
    return config.plans.find((plan) => plan.repositoryId === repositoryId)
      ?? compilePipeline({ config, repositoryId, registry: createTaskRegistry() });
  }

  async execute(issue: StoredIssue): Promise<StageOutcome> {
    const { config, store, signal } = this.dependencies;
    const repositoryEntry = Object.entries(config.repositories)
      .find(([, repository]) => repository.address && issue.repositoryId === repository.address);
    const fallbackEntry = Object.entries(config.repositories)
      .find(([name]) => name === issue.repositoryId);
    const [repositoryId, repository] = repositoryEntry ?? fallbackEntry ?? [];
    if (!repositoryId || !repository) {
      throw new Error(`issue ${issue.id} references unknown repository ${issue.repositoryId}`);
    }
    const pipeline = config.pipelines[repository.pipeline];
    if (!pipeline) throw new Error(`unknown pipeline: ${repository.pipeline}`);
    const plan = this.#plan(repositoryId);
    const stageId = issue.projectedStage ?? plan.stages[0]?.id;
    if (!stageId) throw new Error(`pipeline ${repository.pipeline} has no stage`);
    const stage = plan.stages.find((candidate) => candidate.id === stageId);
    if (!stage) throw new Error(`unknown stage "${stageId}"`);
    const state = store.getStageState(issue.id);
    if (state?.status !== "ready" || state.stageId !== stageId) {
      throw new Error(`issue ${issue.id} is not ready at stage ${stageId}`);
    }

    store.activateEnrollment(issue.id);
    let workspace = store.getActiveWorkspace(issue.id);
    // Legacy stages get today's pre-created workspace; native stages ensure their own.
    if (!workspace && stage.legacy) {
      workspace = await createWorkspace({
        store,
        manager: this.dependencies.workspaceManager,
        issue,
        repository: { id: repositoryId, folder: repository.folder, baseBranch: repository.baseBranch },
      });
    }

    const journal = store.executions();
    this.#restartOnPlanChange(issue.id, stage);
    const executionEpoch = store.claimStageExecution({
      issueId: issue.id,
      stageId,
      feedbackCycle: state.feedbackCycle,
      configHash: config.hash,
    });
    const runtimeRepository = {
      id: repositoryId,
      address: repository.address,
      folder: repository.folder,
      baseBranch: repository.baseBranch,
    };
    const refreshDeliveryState = async (): Promise<RuntimeDeliveryState> => {
      if (this.dependencies.loadDeliveryState) {
        return this.dependencies.loadDeliveryState(issue, runtimeRepository);
      }
      const storedPullRequest = store.getCurrentPullRequest(issue.id);
      return {
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
    };
    const transitionId = randomUUID();
    try {
      signal?.throwIfAborted();
      let deps: unknown = this.dependencies.taskDeps?.(issue, runtimeRepository) ?? {};
      if (stage.legacy) {
        const delivery = await refreshDeliveryState();
        const runtime = this.dependencies.runtime({
          issue,
          repository: runtimeRepository,
          workspace: workspace ? { path: workspace.path, branch: workspace.branch } : null,
          sourceGuidance: this.dependencies.sourceGuidance,
          delivery,
        }, refreshDeliveryState);
        deps = {
          runCheck: (...args) => runtime.runCheck(...args),
          runProducer: (...args) => runtime.runProducer(...args),
          runAction: (...args) => runtime.runAction(...args),
          input: { issue: issue as unknown as Record<string, unknown>, workspace: workspace!.path },
        } satisfies LegacyRuntime;
      }
      let ownStatus: string | null = journal.pendingMessage(issue.id);
      const executor = new StageExecutor({
        registry: createTaskRegistry(),
        journal,
        clock: () => new Date(),
        // Legacy stages keep the conversation notes ConfiguredStageRuntime already posts.
        notify: (message) => {
          if (stage.legacy) return;
          store.appendConversationMessage({
            issueId: issue.id, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
            actorName: "Conveyor", actorTitle: "Orchestrator", message,
          });
        },
        setStatus: (message) => {
          const current = store.getIssue(issue.id);
          if (!current) return;
          // Clear only the pending message this executor (or its parked predecessor) set.
          if (message === null && (current.warning === null || current.warning !== ownStatus)) return;
          ownStatus = message;
          store.setIssueProjection(issue.id, {
            stage: current.projectedStage,
            state: current.projectedState ?? "active",
            warning: message,
          });
        },
        ...(this.dependencies.manualGate ? { manualGate: this.dependencies.manualGate } : {}),
        ...(this.dependencies.waitFallback ? { fallbackMs: (kind: WaitKind) => this.dependencies.waitFallback!(issue.repositoryId, kind) } : {}),
        settings: { maxReturns: config.settings.maxReturns },
      });
      const result = await executor.execute({
        issueId: issue.id,
        pipeline: plan,
        stageId,
        baseContext: baseContext(issue, config.hash, stagePlanHash(stage), {
          ...runtimeRepository,
          ciMode: repository.ci.mode,
          systemLabels: repository.systemLabels,
          ...(repository.refinement ? { refinement: repository.refinement } : {}),
        }),
        deps,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      if (result.kind === "parked") {
        if (result.reason === "pending") {
          store.setStageState({
            issueId: issue.id, stageId, status: "ready", feedbackCycle: state.feedbackCycle, configHash: config.hash,
          });
        } else {
          store.releaseFencedStageExecution({ issueId: issue.id, stageId, stageEpoch: executionEpoch });
        }
        return result;
      }
      await applyStageTransition({
        store,
        source: this.dependencies.source,
        sourceName: this.dependencies.sourceName,
        address: repository.address,
        configHash: config.hash,
        transitionId,
        issue,
        stages: pipeline.stages.map((candidate) => candidate.id),
        labels: config.labels,
        result,
        actor: (() => {
          const configured = pipeline.stages.find((candidate) => candidate.id === stageId);
          if (configured && !isNativeStage(configured) && configured.run.type === "agent") {
            const agent = config.agents[configured.run.agent];
            return {
              name: agent?.name ?? configured.run.agent,
              title: agent?.title ?? "AI Agent",
            };
          }
          return {
            name: "Conveyor",
            title: configured && !isNativeStage(configured) && configured.run.type === "script" ? "Script" : "Orchestrator",
          };
        })(),
      });
      if (result.kind === "advance") {
        // Successful stages are part of the story too: without this the conversation goes quiet after review.
        const name = (id: string) => pipeline.stages.find((candidate) => candidate.id === id)?.name ?? displayName(id);
        store.appendConversationMessage({
          issueId: issue.id, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
          actorName: "Conveyor", actorTitle: "Orchestrator",
          message: stageAdvanceMessage(name(stageId), result.nextStageId && result.nextStageId !== stageId ? name(result.nextStageId) : null),
        });
      }
      return result;
    } catch (error) {
      store.setStageState({
        issueId: issue.id,
        stageId,
        status: signal?.aborted ? "interrupted" : "error",
        feedbackCycle: state.feedbackCycle,
        configHash: config.hash,
      });
      throw error;
    }
  }

  /**
   * A stage parked mid-way belongs to the plan it started under. When that stage's plan
   * changed since, resuming against the new plan could point the cursor at a task that no
   * longer exists, so the stage starts fresh (a new epoch drops the cursor and journal keys).
   * Changes elsewhere in the configuration leave it, and any approval it holds, in place.
   */
  #restartOnPlanChange(issueId: string, stage: CompiledStage): void {
    const { store, config } = this.dependencies;
    const stageId = stage.id;
    const journal = store.executions();
    const stored = journal.getContext(issueId);
    const cursor = journal.getCursor(issueId);
    if (!stored || !cursor || cursor.stage !== stageId) return;
    // A context written before stage plan hashes existed, or last written by another stage,
    // carries no hash for this stage, so it falls back to the whole configuration.
    const { stagePlanHash: storedPlanHash, run } = stored.context;
    const unchanged = storedPlanHash !== undefined && run?.stage === stageId
      ? storedPlanHash === stagePlanHash(stage)
      : stored.context.configHash === config.hash;
    if (unchanged) return;
    journal.onStageChange(issueId);
    const message = `The pipeline plan changed since ${stageId} started; the stage restarted from the beginning.`;
    store.appendConversationMessage({
      issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message,
    });
    store.recordJourneyEvent({ issueId, stage: stageId, kind: "restarted", reason: message });
  }
}

function baseContext(
  issue: StoredIssue,
  configHash: string,
  planHash: string,
  repository: TaskContext["repository"],
): TaskContext {
  return {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    configHash,
    stagePlanHash: planHash,
    run: {
      stage: "", stageEpoch: 0, attempt: 1, maxAttempts: 1, taskInstanceId: "",
      enteredAt: new Date().toISOString(), feedback: null,
    },
    repository,
    item: {
      id: issue.id, number: issue.sourceNumber, title: issue.title, url: issue.sourceUrl,
      labels: issue.labels, state: issue.sourceState, criteria: [], children: [], dependencies: [], systemLabels: [],
    },
    checkpoints: { ciPassed: null, reviewPassed: null },
  };
}

/** The conversation note for a completed stage: what finished and what comes next, or that the item is done. */
export function stageAdvanceMessage(stage: string, next: string | null): string {
  return next ? `✅ ${stage} completed. Next: ${next}.` : `✅ ${stage} completed. The item is done.`;
}
