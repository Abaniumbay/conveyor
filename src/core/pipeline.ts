import type { RunEnvelope } from "../runner/result";

export interface CheckResult {
  decision: "pass" | "fail";
  status: string;
  reason: string | null;
  evidence: string[];
  requiredFixes: string[];
  criteria: Array<{ id: string; passed: boolean; evidence: string }>;
}

export interface PipelineStage {
  id: string;
  run:
    | { type: "agent"; agent: string }
    | { type: "script"; runner: string; script: string }
    | { type: "source-action"; action: string; input?: Record<string, unknown> | undefined };
  concurrency: number;
  enterCheck?: string | undefined;
  exitCheck?: string | undefined;
  feedbackCycles?: number | undefined;
  childrenStartAt?: string | undefined;
  successStatuses?: string[] | undefined;
  failureStatuses?: string[] | undefined;
  failureState?: string | undefined;
  failurePolicies: Record<string, { action: "returnToPrevious" }>;
  afterSuccess: Array<{
    sourceAction: string;
    with?: Record<string, unknown> | undefined;
  }>;
}

export interface PipelineDefinition {
  successStatuses: string[];
  failureStatuses: string[];
  stages: PipelineStage[];
}

export interface StageExecutionInput {
  issue: Record<string, unknown>;
  workspace: string | null;
}

export interface ProducerFeedback {
  reason: string;
  requiredFixes: string[];
  evidence: string[];
}

export interface ProducerContext extends StageExecutionInput {
  stageId: string;
  attempt: number;
  feedback: ProducerFeedback | null;
}

export interface CheckContext extends ProducerContext {
  producerResult: RunEnvelope | null;
}

export interface PipelineDependencies {
  runCheck(
    checkId: string,
    phase: "enter" | "exit",
    context: CheckContext,
  ): Promise<CheckResult>;
  runProducer(stage: PipelineStage, context: ProducerContext): Promise<RunEnvelope>;
  runAction(
    action: PipelineStage["afterSuccess"][number],
    context: ProducerContext & { producerResult: RunEnvelope },
  ): Promise<void>;
}

export type StageExecutionResult =
  | {
      kind: "advance";
      stageId: string;
      nextStageId: string | null;
      result: RunEnvelope;
      feedbackCycles: number;
    }
  | {
      kind: "stopped";
      stageId: string;
      state: string;
      reason: string;
      requiredFixes: string[];
      feedbackCycles: number;
      result: RunEnvelope | null;
    }
  | {
      kind: "correction";
      stageId: string;
      targetStageId: string;
      reason: string;
      requiredFixes: string[];
      evidence: string[];
      result: RunEnvelope | null;
    };

export class PipelineExecutionError extends Error {
  override readonly name = "PipelineExecutionError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

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
        const prior = this.pipeline.stages[stageIndex - 1];
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
        const prior = this.pipeline.stages[stageIndex - 1];
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
          if (feedbackCycles >= maximumFeedbackCycles) {
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
