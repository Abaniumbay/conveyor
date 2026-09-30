// The original PipelineEngine, kept as the reference implementation that the task-chain
// executor is proven equivalent to (see legacy-equivalence.test.ts). Not used by src/.

import {
  PipelineExecutionError,
  type CheckResult,
  type PipelineDefinition,
  type PipelineDependencies,
  type PipelineStage,
  type ProducerContext,
  type ProducerFeedback,
  type StageExecutionInput,
  type StageExecutionResult,
} from "../../src/core/pipeline";
import type { RunEnvelope } from "../../src/runner/result";

function feedbackFrom(check: CheckResult): ProducerFeedback {
  return {
    reason: check.reason ?? "verification failed",
    requiredFixes: check.requiredFixes,
    evidence: check.evidence,
  };
}

export class PipelineEngine {
  constructor(
    private readonly pipeline: PipelineDefinition,
    private readonly dependencies: PipelineDependencies,
    private readonly defaultFeedbackCycles: number,
  ) {
    if (pipeline.stages.length === 0) {
      throw new PipelineExecutionError("pipeline must define at least one stage");
    }
  }

  async executeStage(
    stageId: string,
    input: StageExecutionInput,
  ): Promise<StageExecutionResult> {
    const stageIndex = this.pipeline.stages.findIndex((stage) => stage.id === stageId);
    const stage = this.pipeline.stages[stageIndex];
    if (!stage) throw new PipelineExecutionError(`unknown stage "${stageId}"`);

    const initialContext: ProducerContext = {
      ...input,
      stageId,
      attempt: 1,
      feedback: null,
    };
    if (stage.enterCheck) {
      const enter = await this.dependencies.runCheck(stage.enterCheck, "enter", {
        ...initialContext,
        producerResult: null,
      });
      if (enter.decision === "fail") {
        const policy = stage.failurePolicies[enter.status];
        const prior = this.returnTarget(stageIndex, policy);
        if (policy?.action === "returnToPrevious" && prior) {
          return {
            kind: "correction",
            stageId,
            targetStageId: prior.id,
            reason: enter.reason ?? "stage entry verification failed",
            requiredFixes: enter.requiredFixes,
            evidence: enter.evidence,
            result: null,
          };
        }
        return {
          kind: "stopped",
          stageId,
          state: stage.failureState ?? enter.status,
          reason: enter.reason ?? "stage entry verification failed",
          requiredFixes: enter.requiredFixes,
          feedbackCycles: 0,
          result: null,
        };
      }
    }

    const maximumFeedbackCycles = stage.feedbackCycles ?? this.defaultFeedbackCycles;
    let feedbackCycles = 0;
    let attempt = 1;
    let feedback: ProducerFeedback | null = null;

    while (true) {
      const producerContext: ProducerContext = {
        ...input,
        stageId,
        attempt,
        feedback,
      };
      const producerResult = await this.dependencies.runProducer(stage, producerContext);
      this.validateProducerResult(stage, producerResult);

      if (producerResult.stageResult.outcome === "failure") {
        const policy = stage.failurePolicies[producerResult.stageResult.status];
        const prior = this.returnTarget(stageIndex, policy);
        if (policy?.action === "returnToPrevious" && prior) {
          return {
            kind: "correction",
            stageId,
            targetStageId: prior.id,
            reason:
              producerResult.stageResult.reason ?? producerResult.stageResult.summary,
            requiredFixes: [
              producerResult.stageResult.reason ?? producerResult.stageResult.summary,
            ],
            evidence: [],
            result: producerResult,
          };
        }
        return {
          kind: "stopped",
          stageId,
          state: stage.failureState ?? producerResult.stageResult.status,
          reason:
            producerResult.stageResult.reason ?? producerResult.stageResult.summary,
          requiredFixes: [],
          feedbackCycles,
          result: producerResult,
        };
      }

      if (stage.exitCheck) {
        const exit = await this.dependencies.runCheck(stage.exitCheck, "exit", {
          ...producerContext,
          producerResult,
        });
        if (exit.decision === "fail") {
          if (stage.run.type === "source-action" || feedbackCycles >= maximumFeedbackCycles) {
            return {
              kind: "stopped",
              stageId,
              state: stage.failureState ?? exit.status,
              reason: exit.reason ?? "stage exit verification failed",
              requiredFixes: exit.requiredFixes,
              feedbackCycles,
              result: producerResult,
            };
          }
          feedbackCycles += 1;
          attempt += 1;
          feedback = feedbackFrom(exit);
          continue;
        }
      }

      for (const action of stage.afterSuccess) {
        try {
          await this.dependencies.runAction(action, {
            ...producerContext,
            producerResult,
          });
        } catch (error) {
          throw new PipelineExecutionError(
            `afterSuccess action "${action.sourceAction}" failed for stage "${stageId}": ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }

      return {
        kind: "advance",
        stageId,
        nextStageId: this.pipeline.stages[stageIndex + 1]?.id ?? null,
        result: producerResult,
        feedbackCycles,
      };
    }
  }

  private returnTarget(
    stageIndex: number,
    policy: PipelineStage["failurePolicies"][string] | undefined,
  ): PipelineStage | undefined {
    if (policy?.stage) {
      const index = this.pipeline.stages.findIndex((candidate) => candidate.id === policy.stage);
      return index >= 0 && index < stageIndex ? this.pipeline.stages[index] : undefined;
    }
    return this.pipeline.stages[stageIndex - 1];
  }

  private validateProducerResult(stage: PipelineStage, result: RunEnvelope): void {
    const statuses =
      result.stageResult.outcome === "success"
        ? (stage.successStatuses ?? this.pipeline.successStatuses)
        : (stage.failureStatuses ?? this.pipeline.failureStatuses);
    if (!statuses.includes(result.stageResult.status)) {
      throw new PipelineExecutionError(
        `stage "${stage.id}" returned ${result.stageResult.outcome} status "${result.stageResult.status}" which is not configured`,
      );
    }
  }
}
