import { z } from "zod";

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
  })
  .strict()
  .transform(({ reconcileInterval, interruptGrace, ...settings }) => ({
    ...settings,
    reconcileIntervalMs: reconcileInterval,
    interruptGraceMs: interruptGrace,
  }));

const webSchema = z
  .object({
    listen: z.string().min(3).default("127.0.0.1:4300"),
    publicUrl: z.url().optional(),
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

const codexRunnerSchema = z
  .object({
    type: z.literal("codex"),
    command: z.string().min(1).default("codex"),
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
    automaticApprovals: z.boolean().default(true),
  })
  .strict();

const processRunnerSchema = z
  .object({
    type: z.literal("json-process"),
  })
  .strict();

const runnerSchema = z.discriminatedUnion("type", [
  codexRunnerSchema,
  processRunnerSchema,
]);

const agentSchema = z
  .object({
    runner: identifierSchema,
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    instructions: absolutePathSchema,
    workspaceAccess: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  })
  .strict();

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
  .object({ action: z.literal("returnToPrevious") })
  .strict();

const stageSchema = z
  .object({
    id: identifierSchema,
    run: stageRunSchema,
    concurrency: z.number().int().positive(),
    enterCheck: identifierSchema,
    exitCheck: identifierSchema,
    feedbackCycles: z.number().int().nonnegative().optional(),
    childrenStartAt: identifierSchema.optional(),
    successStatuses: z.array(identifierSchema).min(1).optional(),
    failureStatuses: z.array(identifierSchema).min(1).optional(),
    failureState: identifierSchema.optional(),
    failurePolicies: z.record(identifierSchema, failurePolicySchema).default({}),
    afterSuccess: z.array(lifecycleActionSchema).default([]),
  })
  .strict();

const pipelineSchema = z
  .object({
    successStatuses: z.array(identifierSchema).min(1),
    failureStatuses: z.array(identifierSchema).min(1),
    stages: z.array(stageSchema).min(1),
  })
  .strict()
  .superRefine((pipeline, context) => {
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

const repositorySchema = z
  .object({
    source: identifierSchema,
    address: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must use owner/repository format"),
    folder: absolutePathSchema,
    baseBranch: identifierSchema.default("main"),
    pipeline: identifierSchema,
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
    runners: z.record(identifierSchema, runnerSchema).default({}),
    agents: z.record(identifierSchema, agentSchema).default({}),
    checks: z.record(identifierSchema, checkSchema).default({}),
    labels: labelsSchema,
    pipelines: z.record(identifierSchema, pipelineSchema).default({}),
    repositories: z.record(identifierSchema, repositorySchema).default({}),
  })
  .strict();

export type ConveyorConfigData = z.output<typeof configSchema>;
export type StageConfig = ConveyorConfigData["pipelines"][string]["stages"][number];
export type StageRunConfig = StageConfig["run"];
