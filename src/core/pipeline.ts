import type { RunEnvelope } from "../runner/result";
import type { Feedback } from "../tasks/context";

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
    | { type: "script"; runner: string; script: string; interpreter?: string[] }
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
      /** A configured cross-stage retry route retained after an intervention stop. */
      retryTargetStage?: string;
      /** The failure report to give the retry destination's first run. */
      retryFeedback?: Feedback;
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

/**
 * The board's column order for a set of pipelines: a topological order of every "runs before"
 * pair in any pipeline, so no stage appears after one it runs before. Among stages free to go
 * next, the one seen first goes first, which keeps a single stage list exactly as written. Pipelines
 * that contradict each other cannot all be honoured; the earliest-seen stage goes first then.
 */
export function boardStageOrder(pipelines: Iterable<{ stages: readonly { id: string }[] }>): string[] {
  const seen: string[] = [];
  const before = new Map<string, Set<string>>();
  for (const pipeline of pipelines) {
    let previous: string | undefined;
    for (const { id } of pipeline.stages) {
      if (!before.has(id)) {
        before.set(id, new Set());
        seen.push(id);
      }
      if (previous !== undefined && previous !== id) before.get(id)!.add(previous);
      previous = id;
    }
  }
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < seen.length) {
    const remaining = seen.filter((id) => !placed.has(id));
    const next = remaining.find((id) => [...before.get(id)!].every((earlier) => placed.has(earlier))) ?? remaining[0]!;
    placed.add(next);
    order.push(next);
  }
  return order;
}
