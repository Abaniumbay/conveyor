// The `script` task group. `script.run` runs an operator script under the recovery protocol
// documented in docs/tasks.md; `script.succeeded` checks the captured result. A script that ran
// to completion always lets `script.run` pass, even when it reported failure: whether that is
// acceptable is the exit gate's decision (`script.succeeded`), not the action's.

import { z } from "zod";

import { RunnerProcessError, runProcess } from "../runner/json-process";
import type { ScriptContext, ScriptRecoveryObservation, ScriptRecoveryRequest } from "./context";
import { defineGroup, fail, InfrastructureError, pass, type TaskArgs, type TaskDefinition } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;
type ScriptResult = ScriptContext["results"][string];
type Recovery = ScriptResult["recovery"];

const OUTPUT_TAIL_BYTES = 4096;

const runConfig = z
  .object({
    script: z.string().min(1, "script must be a path"),
    recovery: z.enum(["replay-safe", "reconcile"], {
      error: 'recovery is required and must be "replay-safe" or "reconcile"',
    }),
  })
  .strict();
type RunConfig = z.output<typeof runConfig>;

const succeededConfig = z.object({ run: z.string().min(1, "run must name a script.run instance") }).strict();

/** Today's producer-result JSON, optionally extended with an operation id and an artifact URL. */
const applyOutput = z
  .object({
    outcome: z.enum(["success", "failure"]),
    summary: z.string().trim().min(1),
    reason: z.string().nullable().optional(),
    externalOperationId: z.string().min(1).nullable().optional(),
    artifactUrl: z.string().min(1).nullable().optional(),
  })
  .passthrough();
type ApplyOutput = z.output<typeof applyOutput>;

const observeOutput: z.ZodType<ScriptRecoveryObservation> = z.discriminatedUnion("state", [
  z.object({ state: z.literal("already-applied"), operationId: z.string().min(1).nullable(), result: applyOutput }),
  z.object({ state: z.literal("not-applied") }),
  z.object({ state: z.literal("indeterminate"), reason: z.string().min(1) }),
]) as never;

function tail(text: string): string {
  let out = text.trim().slice(-OUTPUT_TAIL_BYTES);
  while (Buffer.byteLength(out) > OUTPUT_TAIL_BYTES) out = out.slice(1);
  return out;
}

function parseOutput<T>(task: string, phase: string, schema: z.ZodType<T>, stdout: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw new InfrastructureError(`${task} ${phase} output is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "output"}: ${i.message}`).join("; ");
    throw new InfrastructureError(`${task} ${phase} output is invalid: ${issues}`);
  }
  return parsed.data;
}

const toResult = (recovery: Recovery, output: ApplyOutput, operationId: string | null, outputTail: string): ScriptResult => ({
  passed: output.outcome === "success",
  recovery,
  externalOperationId: operationId ?? output.externalOperationId ?? null,
  summary: output.summary,
  reason: output.reason?.trim() || null,
  artifactUrl: output.artifactUrl ?? null,
  outputTail,
  finishedAt: new Date().toISOString(),
});

const run: TaskDefinition<RunConfig, unknown, Deps> = {
  name: "script.run",
  kind: "act",
  description:
    "Runs `bun run <script>` in the workspace (or the repository folder) with the script protocol on stdin. `replay-safe` scripts are applied every time; `reconcile` scripts are applied on the first run and, after a restart, observed first and applied only when not yet applied (an indeterminate observation stops for intervention). A script that completes always passes this task; the bounded result is captured per instance in `script`.",
  reads: ["repository", "run"],
  writes: ["script"],
  invalidates: [],
  config: runConfig,
  async run({ context, config, deps, instance }: TaskArgs<RunConfig, unknown, Deps>) {
    const issue = deps.store.getIssue(deps.issueId);
    if (!issue) throw new InfrastructureError(`issue ${deps.issueId} is not stored`);
    const workspace = deps.store.getActiveWorkspace(deps.issueId)?.path ?? null;
    const call = async (phase: ScriptRecoveryRequest["phase"]) => {
      const request: ScriptRecoveryRequest = { phase, idempotencyKey: instance.idempotencyKey, taskInstanceId: instance.id };
      try {
        return await runProcess({
          command: ["bun", "run", config.script],
          cwd: workspace ?? deps.repository.folder,
          // The legacy fields keep stage scripts written for `run: { type: script }` working unchanged.
          input: {
            ...request, context,
            issue, workspace, repository: context.repository ?? deps.repository,
            runId: instance.idempotencyKey, stageId: instance.stage,
            attempt: context.run?.attempt, feedback: context.run?.feedback ?? null,
          },
          interruptGraceMs: deps.config?.settings?.interruptGraceMs ?? 10_000,
          ...(deps.signal ? { signal: deps.signal } : {}),
        });
      } catch (error) {
        if (error instanceof RunnerProcessError) throw new InfrastructureError(`script.run ${phase} failed: ${error.message}`, { cause: error });
        throw error;
      }
    };
    const apply = async () => {
      const { stdout } = await call("apply");
      return pass(toResult(config.recovery, parseOutput("script.run", "apply", applyOutput, stdout), null, tail(stdout)));
    };

    if (config.recovery === "replay-safe" || !instance.resumed) return apply();

    const { stdout } = await call("observe");
    const observation = parseOutput("script.run", "observe", observeOutput, stdout);
    if (observation.state === "not-applied") return apply();
    if (observation.state === "indeterminate") {
      return fail(observation.reason, { route: { stop: "needs-intervention" } });
    }
    const applied = applyOutput.parse(observation.result);
    return pass(toResult("reconcile", applied, observation.operationId, tail(stdout)));
  },
};

const succeeded: TaskDefinition<z.output<typeof succeededConfig>> = {
  name: "script.succeeded",
  kind: "check",
  description: "Passes when the named `script.run` instance's captured result passed; otherwise fails with the script's reason (falling back to its summary) and output tail.",
  reads: ["script"],
  writes: [],
  invalidates: [],
  config: succeededConfig,
  run({ context, config }) {
    const result = context.script?.results[config.run];
    if (!result) return fail(`script ${config.run} has no result`);
    return result.passed ? pass() : fail(result.reason?.trim() || result.summary, { details: result.outputTail });
  },
};

export const scriptGroup = defineGroup("script", [run, succeeded]);
