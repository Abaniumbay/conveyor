import { homedir } from "node:os";
import path from "node:path";

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

/** An absolute path, or one under the service user's home written as `~/…`. */
const homePathSchema = z
  .string()
  .min(1)
  .transform((value) => (value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value))
  .refine((value) => value.startsWith("/"), "must be an absolute path or start with ~/");

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
    /**
     * How long finished work is kept: run events (agent transcripts, tool calls) and per-run
     * artifacts of items that are closed, done or offboarded. Open items are never pruned.
     */
    retention: z
      .object({
        runHistory: waitTimeoutSchema.prefault("unlimited"),
        artifacts: waitTimeoutSchema.prefault("unlimited"),
      })
      .strict()
      .prefault({})
      .transform(({ runHistory, artifacts }) => ({ runHistoryMs: runHistory, artifactsMs: artifacts })),
    /** Service logs: stdout/stderr, and <logs>/conveyor.log rotated by size. */
    logging: z
      .object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        /** stdout/stderr format; the file is always JSON lines. */
        format: z.enum(["text", "json"]).default("text"),
        /** conveyor.log is rotated when it would exceed this size. */
        maxFileMegabytes: z.number().positive().max(1024).default(10),
        /** Rotated files kept (conveyor.log.1 ... .N); older ones are deleted. */
        keepFiles: z.number().int().min(0).max(100).default(5),
      })
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
    listen: z.string().min(3).default("127.0.0.1:7788"),
    publicUrl: z.url().optional(),
    steering: steeringSchema.optional(),
    /** Signs dashboard sessions; when unset, Conveyor generates one and keeps it beside the database. */
    sessionSecret: z.string().min(32, "sessionSecret must be at least 32 characters").optional(),
    /** VAPID keys for browser push notifications; the CONVEYOR_VAPID_* variables are the fallback. */
    push: z
      .object({
        publicKey: z.string().min(1),
        privateKey: z.string().min(1),
        subject: z.string().regex(/^(https:\/\/|mailto:)/, "subject must be an https: or mailto: URL"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .prefault({});

const githubSourceSchema = z
  .object({
    type: z.literal("github"),
    webhookPath: z.string().startsWith("/").default("/hooks/github"),
    autoConfigureWebhook: z.boolean().default(false),
    /** Verifies webhook deliveries; CONVEYOR_GITHUB_WEBHOOK_SECRET is the fallback. */
    webhookSecret: z.string().min(1).optional(),
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

/** A value home-expanded like a path when it starts with ~/, kept as is otherwise (environment values). */
const homeExpandedSchema = z
  .string()
  .transform((value) => (value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value));

/** An MCP server an agent may use beside Conveyor's own, such as a code index. */
const agentMcpServerSchema = z
  .object({
    command: z.string().min(1),
    /** `{workspace}` is replaced with the run's worktree path. */
    args: z.array(z.string()).default([]),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), homeExpandedSchema).default({}),
    startupTimeoutSec: z.number().positive().optional(),
    /**
     * The only tools the agent may call on this server. A server runs outside the agent's sandbox, so
     * limit it to what the agent's access allows (lookups only for a read-only agent). Absent: all.
     */
    enabledTools: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Patterns for files the server writes inside the worktree (caches, project files). Conveyor adds
     * them to the repository's local git exclude before the agent runs, so they are never committed
     * and never count as uncommitted changes.
     */
    gitExclude: z.array(z.string().min(1)).default([]),
  })
  .strict();

const CODEX_CONFIG_KEY = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
/** Codex settings Conveyor derives from the agent's other fields; codexConfig must not override them. */
const CONVEYOR_CODEX_KEYS = /^(mcp_servers|sandbox_mode|sandbox_workspace_write|approvals_reviewer|model_reasoning_effort|web_search)(\.|$)/;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const agentSchema = z
  .object({
    name: identifierSchema.optional(),
    title: identifierSchema.optional(),
    runner: identifierSchema,
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    instructions: absolutePathSchema,
    workspaceAccess: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
    /** Live web search; a workspace-write agent's own commands also get the network (installs, registries). */
    network: z.boolean().default(false),
    /** Extra directories a workspace-write agent's commands may write, such as package caches. Missing ones are skipped. */
    writableRoots: z.array(homePathSchema).default([]),
    /** Extra Codex settings, passed as `-c key=value` (Codex agents only), e.g. model_auto_compact_token_limit. */
    codexConfig: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    /** MCP servers the agent may use beside Conveyor's own (Codex agents only), keyed by server name. */
    mcpServers: z.record(z.string(), agentMcpServerSchema).default({}),
    /** The exact grant: canonical camelCase tool task names. Defaults to every grantable tool. */
    tasks: z.array(z.string()).optional(),
    /** Legacy snake_case grant; normalised to `tasks` through the alias table. */
    tools: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((agent, context) => {
    for (const key of Object.keys(agent.codexConfig)) {
      if (!CODEX_CONFIG_KEY.test(key)) {
        context.addIssue({ code: "custom", path: ["codexConfig", key], message: "must be a dotted Codex config key" });
      } else if (CONVEYOR_CODEX_KEYS.test(key)) {
        context.addIssue({ code: "custom", path: ["codexConfig", key], message: "is set by Conveyor from the agent's other settings" });
      }
    }
    for (const name of Object.keys(agent.mcpServers)) {
      if (name === "conveyor") {
        context.addIssue({ code: "custom", path: ["mcpServers", name], message: "conveyor is reserved for Conveyor's own server" });
      } else if (!MCP_SERVER_NAME.test(name)) {
        context.addIssue({ code: "custom", path: ["mcpServers", name], message: "must be a plain server name (letters, digits, _ and -)" });
      }
    }
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


/** The argv prefix a script path is appended to (default `bun run`); `[]` executes the script itself. */
const interpreterSchema = z.array(z.string().min(1)).optional();

const checkSchema = z
  .object({
    script: absolutePathSchema.optional(),
    interpreter: interpreterSchema,
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
    interpreter: interpreterSchema,
  })
  .strict()
  .transform(({ runner, script, interpreter }): { type: "script"; runner: string; script: string; interpreter?: string[] } =>
    interpreter ? { type: "script", runner, script, interpreter } : { type: "script", runner, script });

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

/** What refinement may write on the issue page and what it must fill before leaving the stage. */
const refinementOutputsSchema = z
  .object({
    /** Organization issue fields refinement may write (for example Effort, Priority). */
    fields: z.array(identifierSchema).default([]),
    require: z
      .object({
        type: z.boolean().default(false),
        /** Organization issue fields that must have a value (a subset of `fields`). */
        fields: z.array(identifierSchema).default([]),
        section: z.boolean().default(false),
      })
      .strict()
      .default({ type: false, fields: [], section: false }),
  })
  .strict()
  .superRefine((outputs, context) => {
    const allowed = new Set(outputs.fields.map((name) => name.toLocaleLowerCase()));
    for (const name of outputs.require.fields) {
      if (!allowed.has(name.toLocaleLowerCase())) {
        context.addIssue({ code: "custom", path: ["require", "fields"], message: `required field ${name} must also be listed in fields` });
      }
    }
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
    refinement: refinementOutputsSchema.default({ fields: [], require: { type: false, fields: [], section: false } }),
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
