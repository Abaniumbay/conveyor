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
  failurePolicies: Record<string, { action: "returnToPrevious"; stage?: string | undefined }>;
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
      result: RunEnvelope | null;
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
