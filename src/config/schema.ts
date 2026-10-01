import { z } from "zod";

import { agentGrantableTools } from "../mcp/tools";
import { agentEgressSchema, validateHttpsHosts } from "../isolation/egress-policy";
import { AGENT_DENIED_TOOLS, canonicalToolName } from "../tasks/aliases";

import type { Route } from "../tasks/contract";

import { parseDuration } from "./duration";

const durationSchema = z
  .union([z.number().int().positive(), z.string().min(1)])
  .transform((value, context) => {
    try {
      return parseDuration(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });

const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "must resolve to an absolute path");

const identifierSchema = z.string().trim().min(1).max(100);

const retrySchema = z
  .object({
    infrastructureAttempts: z.number().int().nonnegative().default(5),
    usageLimitAttempts: z
      .union([z.number().int().nonnegative(), z.literal("unlimited")])
      .default("unlimited"),
    minBackoff: durationSchema.prefault("30s"),
    maxBackoff: durationSchema.prefault("30m"),
  })
  .strict()
  .prefault({});

/** A duration, or "unlimited" which normalises to null. */
const waitTimeoutSchema = z.union([z.literal("unlimited"), durationSchema]).transform((value) =>
  value === "unlimited" ? null : value,
);

const settingsSchema = z
  .object({
    runners: z.number().int().positive().default(1),
    database: absolutePathSchema,
    logs: absolutePathSchema,
    workspaces: absolutePathSchema,
    artifacts: absolutePathSchema,
    reconcileInterval: durationSchema.prefault("5m"),
    feedbackCycles: z.number().int().nonnegative().default(2),
    labelPrefix: identifierSchema.default("conveyor"),
    interruptGrace: durationSchema.prefault("10s"),
    retries: retrySchema,
    maxReturns: z.number().int().nonnegative().default(5),
    /** Input tokens (cached included) above which a finished agent run posts a warning; the run is never stopped. */
    agentRunTokenWarning: z.number().int().positive().default(15_000_000),
    taskDefaults: z
      .object({
        wait: z
          .object({
            timeout: waitTimeoutSchema.prefault("30m"),
            poll: durationSchema.prefault("1m"),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({})
      .transform(({ wait }) => ({ wait: { timeoutMs: wait.timeout, pollMs: wait.poll } })),
    history: z
      .object({ contextSummaryBytes: z.number().int().positive().default(65536) })
      .strict()
      .prefault({}),
  })
  .strict()
  .transform(({ reconcileInterval, interruptGrace, ...settings }) => ({
    ...settings,
    reconcileIntervalMs: reconcileInterval,
    interruptGraceMs: interruptGrace,
  }));

const steeringSchema = z
  .object({
    agent: identifierSchema,
    workspace: absolutePathSchema,
  })
  .strict();

const webSchema = z
  .object({
    listen: z.string().min(3).default("127.0.0.1:4300"),
    publicUrl: z.url().optional(),
    steering: steeringSchema.optional(),
  })
  .strict()
  .prefault({});

const githubSourceSchema = z
  .object({
    type: z.literal("github"),
    webhookPath: z.string().startsWith("/").default("/hooks/github"),
    autoConfigureWebhook: z.boolean().default(false),
    allowedHumanLogins: z.array(identifierSchema).default([]),
  })
  .strict();

const sourceSchema = z.discriminatedUnion("type", [githubSourceSchema]);

const githubCodeHostSchema = z.object({ type: z.literal("github") }).strict();
const codeHostSchema = z.discriminatedUnion("type", [githubCodeHostSchema]);

const codexRunnerSchema = z
  .object({
    type: z.literal("codex"),
    command: z.string().min(1).default("codex"),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
    automaticApprovals: z.boolean().default(true),
    /** Hosts the Codex process itself may reach when egress is enforced (default: ChatGPT and OpenAI). */
    controlPlaneHosts: z
      .array(z.string())
      .optional()
      .superRefine((hosts, context) => {
        for (const issue of validateHttpsHosts(hosts ?? [])) {
          context.addIssue({ code: "custom", message: issue.message.replace("agentEgress.httpsHosts", "controlPlaneHosts") });
        }
      }),
  })
  .strict();

const claudeCodeRunnerSchema = z
  .object({
    type: z.literal("claude-code"),
    command: z.string().min(1).default("claude"),
    /** Claude Code's config directory (login and sessions); defaults to ~/.claude, the service user's login. */
    configDir: absolutePathSchema.optional(),
  })
  .strict();

const processRunnerSchema = z
  .object({
    type: z.literal("json-process"),
  })
  .strict();

const runnerSchema = z.discriminatedUnion("type", [
  codexRunnerSchema,
  claudeCodeRunnerSchema,
  processRunnerSchema,
]);

const agentSchema = z
  .object({
    name: identifierSchema.optional(),
    title: identifierSchema.optional(),
    runner: identifierSchema,
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    instructions: absolutePathSchema,
    workspaceAccess: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
    /** The exact grant: canonical camelCase tool task names. Defaults to every grantable tool. */
    tasks: z.array(z.string()).optional(),
    /** Legacy snake_case grant; normalised to `tasks` through the alias table. */
    tools: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.tasks && agent.tools) {
      context.addIssue({ code: "custom", path: ["tools"], message: 'use either "tasks" or the legacy "tools", not both' });
      return;
    }
    const key = agent.tasks ? "tasks" : "tools";
    const granted = new Set<string>();
    (agent.tasks ?? agent.tools ?? []).forEach((entry, index) => {
      const name = agent.tasks ? entry : canonicalToolName(entry);
      const fail = (message: string) => context.addIssue({ code: "custom", path: [key, index], message });
      if (entry === "source.set_labels") {
        fail("source.set_labels is no longer available: workflow labels are engine-owned, so remove it from the grant");
      } else if (AGENT_DENIED_TOOLS.includes(name)) {
        fail(`${name} can never be granted to an agent`);
      } else if (!agentGrantableTools().includes(name)) {
        fail(`unknown task "${entry}"`);
      } else if (granted.has(name) && agent.tasks) {
        fail(`task "${name}" is granted more than once`);
      }
      granted.add(name);
    });
  })
  .transform(({ tasks, tools, ...agent }) => ({
    ...agent,
    tasks: tasks ?? (tools ? [...new Set(tools.map(canonicalToolName))] : agentGrantableTools()),
  }));


const checkSchema = z
  .object({
    script: absolutePathSchema.optional(),
    verifier: identifierSchema,
  })
  .strict();

const agentRunSchema = z
  .object({ agent: identifierSchema })
  .strict()
  .transform(({ agent }) => ({ type: "agent" as const, agent }));

const scriptRunSchema = z
  .object({
    runner: identifierSchema,
    script: absolutePathSchema,
  })
  .strict()
  .transform(({ runner, script }) => ({ type: "script" as const, runner, script }));

const sourceActionRunSchema = z
  .object({
    sourceAction: identifierSchema,
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .transform(({ sourceAction, with: input }) => ({
    type: "source-action" as const,
    action: sourceAction,
    ...(input ? { input } : {}),
  }));

const stageRunSchema = z.union([
  agentRunSchema,
  scriptRunSchema,
  sourceActionRunSchema,
]);

const lifecycleActionSchema = z
  .object({
    sourceAction: identifierSchema,
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const failurePolicySchema = z
  .object({
    action: z.literal("returnToPrevious"),
    /** Earlier stage to return to; defaults to the immediately preceding stage. */
    stage: identifierSchema.optional(),
  })
  .strict();

const stageSchema = z
  .object({
    id: identifierSchema,
    name: identifierSchema.optional(),
    run: stageRunSchema,
    concurrency: z.number().int().positive(),
    enterCheck: identifierSchema.optional(),
    exitCheck: identifierSchema.optional(),
    feedbackCycles: z.number().int().nonnegative().optional(),
    childrenStartAt: identifierSchema.optional(),
    successStatuses: z.array(identifierSchema).min(1).optional(),
    failureStatuses: z.array(identifierSchema).min(1).optional(),
    failureState: identifierSchema.optional(),
    failurePolicies: z.record(identifierSchema, failurePolicySchema).default({}),
    afterSuccess: z.array(lifecycleActionSchema).default([]),
  })
  .strict();

const waitSchema = z
  .object({
    timeout: waitTimeoutSchema.optional(),
    poll: durationSchema.optional(),
  })
  .strict()
  .transform(({ timeout, poll }) => ({
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
    ...(poll !== undefined ? { pollMs: poll } : {}),
  }));

const onFailSchema = z
  .union([
    z.literal("retry"),
    z.object({ return: identifierSchema }).strict(),
    z.object({ stop: identifierSchema }).strict(),
  ])
  .transform((value): Route => (value === "retry" ? { retry: true } : value));

const taskOverrideSchema = z
  .object({
    with: z.record(z.string(), z.unknown()).optional(),
    wait: waitSchema.optional(),
    onFail: onFailSchema.optional(),
  })
  .strict();

const taskEntrySchema = z
  .object({
    id: identifierSchema.optional(),
    task: identifierSchema,
    when: z.enum(["ci.enabled", "ci.required", "ci.advisory"]).optional(),
  })
  .extend(taskOverrideSchema.shape)
  .strict();

const nativeStageSchema = z
  .object({
    id: identifierSchema,
    name: identifierSchema.optional(),
    concurrency: z.number().int().positive(),
    retries: z.number().int().nonnegative().default(2),
    childrenStartAt: identifierSchema.optional(),
    actions: z.array(taskEntrySchema),
    "exit-gate": z.array(taskEntrySchema).min(1),
  })
  .strict()
  .transform(({ "exit-gate": exitGate, ...stage }) => ({ ...stage, exitGate }));

/** Accepts a native (task-chain) or legacy (`run`) stage; mixing the two is an error. */
const anyStageSchema = z.unknown().transform((value, context) => {
  const fail = (message: string) => {
    context.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("stage must be an object");
  }
  const native = "actions" in value || "exit-gate" in value;
  const legacy = "run" in value;
  if (native && legacy) return fail('a stage is either native (actions/exit-gate) or legacy (run), not both');
  const parsed = (native ? nativeStageSchema : stageSchema).safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return parsed.data;
});

const pipelineSchema = z
  .object({
    successStatuses: z.array(identifierSchema).min(1).optional(),
    failureStatuses: z.array(identifierSchema).min(1).optional(),
    stages: z.array(anyStageSchema).min(1),
  })
  .strict()
  .superRefine((pipeline, context) => {
    if (pipeline.stages.some((stage) => "run" in stage)) {
      for (const key of ["successStatuses", "failureStatuses"] as const) {
        if (!pipeline[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when the pipeline has legacy (run) stages`,
          });
        }
      }
    }
    const seen = new Set<string>();
    for (const [index, stage] of pipeline.stages.entries()) {
      if (seen.has(stage.id)) {
        context.addIssue({
          code: "custom",
          path: ["stages", index, "id"],
          message: `duplicate stage id "${stage.id}"`,
        });
      }
      seen.add(stage.id);
    }
  });

const ciTriggerSchema = z.object({
  label: identifierSchema,
  workflow: z.string().regex(/^[\w.-]+\.ya?ml$/, "must be a workflow file name"),
  check: identifierSchema,
  replaces: z.array(identifierSchema).default([]),
}).strict();

const ciProviderSchema = z.object({
  type: z.literal("github-actions"),
  triggers: z.array(ciTriggerSchema).default([]),
}).strict();

const ciModeSchema = z.enum(["required", "advisory", "disabled"]);

/** A legacy provider name, or an object; normalised to { provider, mode, ignoreChecks }. */
const repositoryCiSchema = z
  .union([
    identifierSchema,
    z
      .object({
        provider: identifierSchema.optional(),
        mode: ciModeSchema,
        ignoreChecks: z.array(identifierSchema).default([]),
      })
      .strict(),
  ])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return { provider: null as string | null, mode: "required" as z.infer<typeof ciModeSchema>, ignoreChecks: [] as string[] };
    }
    if (typeof value === "string") {
      return { provider: value as string | null, mode: "required" as z.infer<typeof ciModeSchema>, ignoreChecks: [] as string[] };
    }
    return { provider: (value.provider ?? null) as string | null, mode: value.mode, ignoreChecks: value.ignoreChecks };
  });

const repositorySchema = z
  .object({
    source: identifierSchema,
    codeHost: identifierSchema.optional(),
    address: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must use owner/repository format"),
    folder: absolutePathSchema,
    baseBranch: identifierSchema.default("main"),
    pipeline: identifierSchema,
    ci: repositoryCiSchema,
    overrides: z
      .object({
        stages: z
          .record(
            identifierSchema,
            z
              .object({
                actions: z.record(identifierSchema, taskOverrideSchema).optional(),
                "exit-gate": z.record(identifierSchema, taskOverrideSchema).optional(),
              })
              .strict()
              .transform(({ "exit-gate": exitGate, ...stage }) => ({
                ...stage,
                ...(exitGate ? { exitGate } : {}),
              })),
          )
          .default({}),
      })
      .strict()
      .optional(),
    agentEgress: agentEgressSchema.optional(),
    concurrency: z.number().int().positive().default(1),
    systemLabels: z.array(identifierSchema).default([]),
  })
  .strict();

const labelsSchema = z
  .object({
    enrollment: identifierSchema.default("conveyor"),
    stageTemplate: z.string().includes("{stage}"),
    states: z.record(identifierSchema, identifierSchema),
    metadata: z
      .object({
        closable: identifierSchema,
        orderTemplate: z.string().includes("{number}"),
      })
      .strict(),
  })
  .strict();

export const configSchema = z
  .object({
    settings: settingsSchema,
    web: webSchema,
    sources: z.record(identifierSchema, sourceSchema).default({}),
    ci: z.record(identifierSchema, ciProviderSchema).default({}),
    codeHosts: z.record(identifierSchema, codeHostSchema).default({}),
    runners: z.record(identifierSchema, runnerSchema).default({}),
    agents: z.record(identifierSchema, agentSchema).default({}),
    checks: z.record(identifierSchema, checkSchema).default({}),
    labels: labelsSchema,
    pipelines: z.record(identifierSchema, pipelineSchema).default({}),
    repositories: z.record(identifierSchema, repositorySchema).default({}),
  })
  .strict();

export type ConveyorConfigData = z.output<typeof configSchema>;
export type PipelineStageConfig = ConveyorConfigData["pipelines"][string]["stages"][number];
export type NativeStageConfig = z.output<typeof nativeStageSchema>;
export type StageConfig = z.output<typeof stageSchema>;
export type StageRunConfig = StageConfig["run"];
export type TaskEntryConfig = z.output<typeof taskEntrySchema>;
export type TaskOverrideConfig = z.output<typeof taskOverrideSchema>;

export function isNativeStage(stage: PipelineStageConfig): stage is NativeStageConfig {
  return "actions" in stage;
}
