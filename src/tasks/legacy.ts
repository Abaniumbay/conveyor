// Compatibility compiler: a legacy stage (`run`, `enterCheck`, `exitCheck`, `feedbackCycles`,
// `failurePolicies`, `failureState`, `afterSuccess`) becomes a compiled task plan that the
// task-chain executor runs with the same behaviour as PipelineEngine. The `legacy.*` acts wrap
// the existing PipelineDependencies; each computes its failure route explicitly so the plan never
// depends on executor defaults.

import { ExternalWaitError } from "../app/ci-gate";
import {
  PipelineExecutionError,
  type CheckContext,
  type CheckResult,
  type PipelineDependencies,
  type PipelineStage,
  type ProducerContext,
  type ProducerFeedback,
  type StageExecutionInput,
} from "../core/pipeline";
import type { RunEnvelope } from "../runner/result";
import type { Feedback } from "./context";
import { defineGroup, fail, pass, pending, type Route, type TaskArgs, type TaskDefinition, type TaskResult } from "./contract";
import type { CompiledStage, CompiledTask } from "./plan";

/** The runtime a legacy act needs: today's pipeline dependencies and the stage input. */
export interface LegacyRuntime extends PipelineDependencies {
  input: StageExecutionInput;
}

export interface LegacyPipeline {
  successStatuses: string[];
  failureStatuses: string[];
  stages: Array<{ id: string }>;
  /** `settings.feedbackCycles`, used when a stage sets none. */
  feedbackCycles: number;
}

/** The `with` block of every legacy task; only the fields a task needs are present. */
interface LegacyWith {
  stage: PipelineStage;
  stageIds: string[];
  check?: string;
  successStatuses?: string[];
  failureStatuses?: string[];
  maxFeedbackCycles?: number;
  sourceAction?: string;
  with?: Record<string, unknown>;
}

type Args = TaskArgs<LegacyWith, unknown, LegacyRuntime>;

const POLL_MS = 60_000;

function returnTarget(stage: PipelineStage, stageIds: string[], policy: PipelineStage["failurePolicies"][string] | undefined): string | undefined {
  const index = stageIds.indexOf(stage.id);
  if (policy?.stage) {
    const target = stageIds.indexOf(policy.stage);
    return target >= 0 && target < index ? policy.stage : undefined;
  }
  return stageIds[index - 1];
}

/** Policy correction for a failure status, else a stop in the stage's failure state. */
function failureRoute(config: LegacyWith, status: string): Route {
  const policy = config.stage.failurePolicies[status];
  const target = policy?.action === "returnToPrevious" ? returnTarget(config.stage, config.stageIds, policy) : undefined;
  return target ? { return: target } : { stop: config.stage.failureState ?? status };
}

function producerContext({ context, deps, config }: Args): ProducerContext {
  const run = context.run!;
  const feedback = run.feedback ? (run.feedback.details as ProducerFeedback | undefined) ?? null : null;
  return { ...deps.input, stageId: config.stage.id, attempt: run.attempt, feedback };
}

function checkFailure(check: CheckResult, message: string, route: Route): TaskResult {
  return fail(message, {
    route,
    details: { reason: check.reason ?? "verification failed", requiredFixes: check.requiredFixes, evidence: check.evidence },
  });
}

const enterCheck: TaskDefinition<LegacyWith, unknown, LegacyRuntime> = {
  name: "legacy.enterCheck",
  kind: "act",
  description: "Runs the legacy entry check once, on the first attempt.",
  reads: ["run"], writes: [], invalidates: [],
  async run(args) {
    if (args.context.run!.attempt > 1) return pass();
    const { config, deps } = args;
    const enter = await deps.runCheck(config.check!, "enter", { ...producerContext(args), producerResult: null });
    if (enter.decision !== "fail") return pass();
    return fail(enter.reason ?? "stage entry verification failed", {
      route: failureRoute(config, enter.status),
      details: { requiredFixes: enter.requiredFixes, evidence: enter.evidence },
    });
  },
};

function validateStatus(config: LegacyWith, result: RunEnvelope): void {
  const outcome = result.stageResult.outcome;
  const statuses = outcome === "success" ? config.successStatuses : config.failureStatuses;
  if (!statuses?.includes(result.stageResult.status)) {
    throw new PipelineExecutionError(
      `stage "${config.stage.id}" returned ${outcome} status "${result.stageResult.status}" which is not configured`,
    );
  }
}

const produce: TaskDefinition<LegacyWith, unknown, LegacyRuntime> = {
  name: "legacy.produce",
  kind: "act",
  description: "Runs the legacy producer (agent, script or source action) and captures its envelope.",
  reads: ["run"], writes: ["legacy"], invalidates: [],
  async run(args) {
    const { config, deps } = args;
    let result: RunEnvelope;
    try {
      result = await deps.runProducer(config.stage, producerContext(args));
    } catch (error) {
      if (!(error instanceof ExternalWaitError)) throw error;
      return pending(error.message, { after: error.retryAfterMs });
    }
    validateStatus(config, result);
    const stageResult = result.stageResult;
    if (stageResult.outcome === "success") return pass(result);
    const reason = stageResult.reason ?? stageResult.summary;
    const route = failureRoute(config, stageResult.status);
    return fail(reason, {
      route,
      details: { requiredFixes: "return" in route ? [reason] : [], evidence: [], legacy: result },
    });
  },
};

const exitCheck: TaskDefinition<LegacyWith, unknown, LegacyRuntime> = {
  name: "legacy.exitCheck",
  kind: "act",
  description: "Runs the legacy exit check; a failure feeds back to a fresh producer attempt while cycles remain.",
  reads: ["run", "legacy"], writes: [], invalidates: [],
  async run(args) {
    const { config, deps, context } = args;
    const exit = await deps.runCheck(config.check!, "exit", {
      ...producerContext(args), producerResult: context.legacy ?? null,
    } satisfies CheckContext);
    if (exit.decision !== "fail") return pass();
    const message = exit.reason ?? "stage exit verification failed";
    const cyclesLeft = context.run!.attempt - 1 < config.maxFeedbackCycles!;
    if (config.stage.run.type !== "source-action" && cyclesLeft) return checkFailure(exit, message, { retry: true });
    return checkFailure(exit, message, { stop: config.stage.failureState ?? exit.status });
  },
};

const afterSuccess: TaskDefinition<LegacyWith, unknown, LegacyRuntime> = {
  name: "legacy.afterSuccess",
  kind: "act",
  description: "Runs one afterSuccess source action; errors are infrastructure errors.",
  reads: ["run", "legacy"], writes: [], invalidates: [],
  async run(args) {
    const { config, deps, context } = args;
    const action = { sourceAction: config.sourceAction!, ...(config.with ? { with: config.with } : {}) };
    try {
      await deps.runAction(action, { ...producerContext(args), producerResult: context.legacy! });
    } catch (error) {
      throw new PipelineExecutionError(
        `afterSuccess action "${action.sourceAction}" failed for stage "${config.stage.id}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return pass();
  },
};

const succeeded: TaskDefinition = {
  name: "legacy.succeeded",
  kind: "check",
  description: "Passes when the captured legacy producer outcome is success.",
  reads: ["legacy"], writes: [], invalidates: [],
  run: ({ context }) =>
    context.legacy?.stageResult.outcome === "success" ? pass() : fail("the producer did not succeed"),
};

export const legacyGroup = defineGroup("legacy", [enterCheck, produce, exitCheck, afterSuccess, succeeded]);

const definitions = new Map(legacyGroup.definitions.map((definition) => [definition.name, definition]));

function describeRun(run: PipelineStage["run"]): string {
  if (run.type === "agent") return `agent ${run.agent}`;
  if (run.type === "script") return `script ${run.runner} ${run.script}`;
  return `source action ${run.action}`;
}

function routingNotes(stage: PipelineStage, stageIds: string[]): string[] {
  const notes = Object.entries(stage.failurePolicies).map(([status, policy]) => {
    const target = returnTarget(stage, stageIds, policy);
    return `${status} ${target ? `returns to ${target}` : "stops (no earlier stage)"}`;
  });
  if (stage.failureState) notes.push(`failures stop as ${stage.failureState}`);
  return notes;
}

function compiledTask(name: string, id: string, config: LegacyWith, label: string, onFail: Route | null = null): CompiledTask {
  const definition = definitions.get(name)!;
  return {
    id, task: name, kind: definition.kind, with: config as unknown as Record<string, unknown>, label,
    wait: { timeoutMs: null, pollMs: POLL_MS }, onFail,
    reads: [...definition.reads], writes: [...definition.writes], invalidates: [...definition.invalidates],
    implicitLoads: [],
  };
}

/** Translates one legacy stage into the compiled actions and exit gate that reproduce PipelineEngine. */
export function translateLegacyStage(stage: PipelineStage, pipeline: LegacyPipeline): CompiledStage {
  const stageIds = pipeline.stages.map((candidate) => candidate.id);
  const maxFeedbackCycles = stage.feedbackCycles ?? pipeline.feedbackCycles;
  const base = { stage, stageIds };
  const notes = routingNotes(stage, stageIds);
  const actions: CompiledTask[] = [];
  if (stage.enterCheck) {
    actions.push(compiledTask("legacy.enterCheck", "legacy.enterCheck", { ...base, check: stage.enterCheck }, [`check ${stage.enterCheck}`, ...notes].join("; ")));
  }
  actions.push(
    compiledTask(
      "legacy.produce", "legacy.produce",
      {
        ...base,
        successStatuses: stage.successStatuses ?? pipeline.successStatuses,
        failureStatuses: stage.failureStatuses ?? pipeline.failureStatuses,
      },
      [describeRun(stage.run), ...notes].join("; "),
    ),
  );
  if (stage.exitCheck) {
    const cycles = stage.run.type === "source-action" ? "no feedback cycles" : `feedback cycles ${maxFeedbackCycles}`;
    actions.push(compiledTask("legacy.exitCheck", "legacy.exitCheck", { ...base, check: stage.exitCheck, maxFeedbackCycles }, `check ${stage.exitCheck}; ${cycles}`));
  }
  stage.afterSuccess.forEach((action, index) => {
    const id = stage.afterSuccess.length === 1 ? "legacy.afterSuccess" : `afterSuccess${index + 1}`;
    const config: LegacyWith = { ...base, sourceAction: action.sourceAction, ...(action.with ? { with: action.with } : {}) };
    actions.push(compiledTask("legacy.afterSuccess", id, config, action.sourceAction));
  });
  return {
    id: stage.id,
    concurrency: stage.concurrency,
    retries: maxFeedbackCycles,
    childrenStartAt: stage.childrenStartAt ?? null,
    legacy: true,
    actions,
    exitGate: [compiledTask("legacy.succeeded", "legacy.succeeded", base, "producer outcome is success", { stop: stage.failureState ?? "blocked" })],
  };
}
