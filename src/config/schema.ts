import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { agentGrantableTools } from "../mcp/tools";
import { agentToolchainPathsSchema } from "../isolation/toolchain-paths";
import { agentEgressSchema, validateHttpsHosts } from "../isolation/egress-policy";
import { DEFAULT_RUN_ENVIRONMENT, environmentSettingsSchema, type EnvironmentSettings } from "../isolation/run-environment";
import { AGENT_DENIED_TOOLS, canonicalToolName } from "../tasks/aliases";

import type { Route } from "../tasks/contract";

import { parseDuration } from "./duration";
import { EVENT_CLASSES } from "../events/catalogue";

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

/** Deliveries newer than this may still be redelivered, so their record must outlive it. */
export const REDELIVERY_WINDOW_MS = 24 * 60 * 60_000;

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => value.startsWith("/"), "must resolve to an absolute path");

/** An absolute path, or one under the service user's home written as `~/…`. */
const homePathSchema = z
  .string()
  .min(1)
  .transform((value) => (value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value))
  .refine((value) => value.startsWith("/"), "must be an absolute path or start with ~/");

export const identifierSchema = z.string().trim().min(1).max(100);

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

/** An event sink: `jsonl` appends each event as one JSON line to `path`, rotated like the service log. */
const eventSinkSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("jsonl"),
    path: absolutePathSchema,
    /** Which classes of event the sink receives; traces are left out by default. */
    classes: z.array(z.enum(EVENT_CLASSES)).nonempty().default(["fact", "ingest"]),
    /** Whether events that may carry user-written text (titles, bodies, comments) are delivered. */
    includeContent: z.boolean().default(false),
  }).strict(),
]);

/** A `settings` block below the root: repositories and native stages. */
const levelSettingsSchema = z
  .object({ environment: environmentSettingsSchema.default({}) })
  .strict()
  .prefault({});

const settingsSchema = z
  .object({
    /** The variables every run starts with; the repository, stage, harness, agent and script add to them. */
    environment: environmentSettingsSchema.default(() => ({ ...DEFAULT_RUN_ENVIRONMENT })),
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
     * How long run events (agent transcripts, tool calls) and non-home per-run artifacts of closed,
     * done items are kept. Terminal private homes are reclaimed independently.
     */
    retention: z
      .object({
        runHistory: waitTimeoutSchema.prefault("unlimited"),
        artifacts: waitTimeoutSchema.prefault("unlimited"),
        /** How long stored webhook deliveries are kept; never shorter than the redelivery window. */
        webhookDeliveries: durationSchema
          .refine((ms) => ms >= REDELIVERY_WINDOW_MS, { message: "must be at least 24h, the redelivery window" })
          .prefault("7d"),
      })
      .strict()
      .prefault({})
      .transform(({ runHistory, artifacts, webhookDeliveries }) => ({ runHistoryMs: runHistory, artifactsMs: artifacts, webhookDeliveriesMs: webhookDeliveries })),
    /** The event log: how long it keeps events, and where else it delivers them. */
    events: z
      .object({
        retention: durationSchema.prefault("30d"),
        /** Consumers outside Conveyor; each receives every event at least once, in order. */
        sinks: z.array(eventSinkSchema).default([]),
        /**
         * How long a task waiting for a webhook event sleeps when none comes, by kind of wait.
         * Used only while the repository's webhooks are healthy; otherwise tasks poll.
         */
        fallback: z
          .object({
            default: durationSchema.prefault("15m"),
            ci: durationSchema.prefault("5m"),
            change: durationSchema.prefault("10m"),
            dependencies: durationSchema.prefault("30m"),
          })
          .strict()
          .prefault({}),
        /** Deprecated, no effect: managed-webhook repositories are not read periodically. */
        reconcileInterval: durationSchema.optional(),
        /** Deprecated, no effect. */
        fullReconcileInterval: durationSchema.optional(),
      })
      .strict()
      .prefault({})
      .transform(({ retention, sinks, fallback }) => ({
        retentionMs: retention,
        sinks,
        fallbackMs: { default: fallback.default, ci: fallback.ci, change: fallback.change, dependencies: fallback.dependencies },
      })),
    /** How long Conveyor's copy of GitHub data is used before it is read again, by kind of data. */
    githubCache: z
      .object({
        issue: durationSchema.prefault("1h"),
        change: durationSchema.prefault("1h"),
        permission: durationSchema.prefault("1h"),
        /** A commit's check runs while one still runs. */
        runningChecks: durationSchema.prefault("15m"),
        /** A commit whose check runs all finished ("unlimited": a re-run arrives by delivery). */
        finishedChecks: waitTimeoutSchema.prefault("unlimited"),
        other: durationSchema.prefault("1h"),
      })
      .strict()
      .prefault({})
      .transform((lifetimes) => ({ ...lifetimes, finishedChecks: lifetimes.finishedChecks ?? Number.POSITIVE_INFINITY })),
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
    /** Optional autonomous health check for stopped board items. */
    periodic: z
      .object({
        interval: durationSchema,
      })
      .strict()
      .transform(({ interval }) => ({ intervalMs: interval }))
      .optional(),
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

/**
 * An item source, code host or CI provider as the core sees it: its `type` picks the plugin, and the
 * plugin's own schema validates and completes the rest when the configuration is loaded (#670).
 */
export const providerEntrySchema = z.object({ type: z.string().trim().min(1) }).catchall(z.unknown());
export type ProviderEntry = z.output<typeof providerEntrySchema>;

/** Hosts a harness process itself may reach when egress is enforced: a setting of the harness plugins' runners. */
export const controlPlaneHostsSchema = z
  .array(z.string())
  .optional()
  .superRefine((hosts, context) => {
    for (const issue of validateHttpsHosts(hosts ?? [])) {
      context.addIssue({ code: "custom", message: issue.message.replace("agentEgress.httpsHosts", "controlPlaneHosts") });
    }
  });

/** The runner type of a JSON process (script stages): a core runner, not an agent harness. */
export const JSON_PROCESS_RUNNER = "json-process";

const processRunnerSchema = z
  .object({
    type: z.literal(JSON_PROCESS_RUNNER),
  })
  .strict();

/**
 * What the core reads from a harness runner once its plugin's schema completed it; a harness
 * plugin's schema produces at least this. Which optional settings apply follows the plugin's
 * profile: `sandbox` and `automaticApprovals` when the run's sandbox comes from the runner,
 * `configDir` when the profile names a config-directory variable.
 */
export type HarnessRunnerConfig = {
  type: string;
  /** The harness's executable. */
  command: string;
  /** Hosts the harness process itself may reach when egress is enforced; absent: the profile's. */
  controlPlaneHosts?: string[] | undefined;
  /** The harness's own configuration directory (its login and sessions). */
  configDir?: string | undefined;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  automaticApprovals?: boolean;
  /** The harness entry's `settings.environment`: it reaches the harness program, never its commands. */
  environment?: EnvironmentSettings;
  /** The harness entry's own keys of `settings`: the defaults of its agents' harness settings. */
  settings?: HarnessSettings;
};

export type JsonProcessRunnerConfig = { type: typeof JSON_PROCESS_RUNNER };

/**
 * A configured runner. A harness entry is complete only when the configuration was loaded with the
 * plugins; without them it holds only what was written.
 */
export type RunnerConfig = JsonProcessRunnerConfig | HarnessRunnerConfig;

/** Whether a runner is an agent harness rather than the core's JSON process. */
export function isHarnessRunner(runner: RunnerConfig): runner is HarnessRunnerConfig {
  return runner.type !== JSON_PROCESS_RUNNER;
}

/**
 * A runner as the core sees it: a JSON process, validated here, or an agent harness, whose `type`
 * picks the harness plugin whose schema validates and completes the rest when the configuration is
 * loaded. The type is not trimmed: it must name a runner type exactly.
 */
const runnerSchema = z
  .object({ type: z.string().min(1) })
  .catchall(z.unknown())
  .superRefine((entry, context) => {
    if (entry.type !== JSON_PROCESS_RUNNER) return;
    for (const issue of processRunnerSchema.safeParse(entry).error?.issues ?? []) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  })
  // Typed as the loader leaves it once the harness plugins completed the entry.
  .transform((entry) => entry as RunnerConfig);

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

/** An agent's settings for its harness: the runner's harness plugin defines and validates the keys. */
export const harnessSettingsSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type HarnessSettings = z.infer<typeof harnessSettingsSchema>;

/**
 * The `settings` of a harness entry or an agent: `environment`, and keys the harness plugin defines
 * (validated when the configuration loads with the plugins).
 */
export const harnessLevelSettingsSchema = z
  .object({ environment: environmentSettingsSchema.optional() })
  .catchall(z.union([z.string(), z.number(), z.boolean()]));
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const agentSchema = z
  .object({
    name: identifierSchema.optional(),
    title: identifierSchema.optional(),
    runner: identifierSchema,
    model: z.string().min(1).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
    instructions: absolutePathSchema,
    workspaceAccess: z.enum(["read-only", "workspace-write", "confined"]).default("workspace-write"),
    /** Live web search; a workspace-write agent's own commands also get the network (installs, registries). */
    network: z.boolean().default(false),
    /** Extra directories a workspace-write agent's commands may write, such as package caches. Missing ones are skipped. */
    writableRoots: z.array(homePathSchema).default([]),
    /** Deprecated name of `settings.environment`, still accepted (with a warning). */
    env: environmentSettingsSchema.optional(),
    /** `false` takes the shell away, for a harness that can run without one (the loader refuses it otherwise). */
    shell: z.boolean().default(true),
    /**
     * The agent's settings: `environment`, added to its repository's, stage's and harness's, and its
     * harness's own keys, validated by the harness plugin when the configuration loads.
     */
    settings: harnessLevelSettingsSchema.optional(),
    /** Deprecated: the harness's keys of `settings`, still accepted (with a warning). */
    harnessSettings: harnessSettingsSchema.optional(),
    /** Deprecated name of `harnessSettings`, still accepted (with a warning) for Codex agents. */
    codexConfig: harnessSettingsSchema.optional(),
    /** MCP servers the agent may use beside Conveyor's own, keyed by server name. */
    mcpServers: z.record(z.string(), agentMcpServerSchema).default({}),
    /** The exact grant: canonical camelCase tool task names. Defaults to every grantable tool. */
    tasks: z.array(z.string()).optional(),
    /** Legacy snake_case grant; normalised to `tasks` through the alias table. */
    tools: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((agent, context) => {
    if (agent.harnessSettings && agent.codexConfig) {
      context.addIssue({ code: "custom", path: ["codexConfig"], message: 'is the deprecated name of harnessSettings: set only "harnessSettings"' });
    }
    const { environment, ...harnessKeys } = agent.settings ?? {};
    if (agent.env && environment) {
      context.addIssue({ code: "custom", path: ["env"], message: 'is the deprecated name of settings.environment: set only "settings.environment"' });
    }
    const legacy = agent.harnessSettings ? "harnessSettings" : agent.codexConfig ? "codexConfig" : undefined;
    if (legacy && Object.keys(harnessKeys).length > 0) {
      context.addIssue({ code: "custom", path: [legacy], message: 'is the deprecated place of the harness keys in settings: set them only in "settings"' });
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
  .transform(({ tasks, tools, harnessSettings, codexConfig, env, settings, ...agent }) => {
    const { environment, ...harnessKeys } = settings ?? {};
    return {
      ...agent,
      environment: environment ?? env ?? {},
      harnessSettings: harnessSettings ?? codexConfig ?? harnessKeys,
      tasks: tasks ?? (tools ? [...new Set(tools.map(canonicalToolName))] : agentGrantableTools()),
    };
  });


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
    /** A short sentence the dashboard shows in the stage's information dialog. */
    description: z.string().trim().min(1).max(280).optional(),
    /** An emoji the dashboard shows beside the stage's name. */
    icon: z.string().trim().min(1).max(16).optional(),
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
    /** A native exit gate that requires an operator approval after its automatic check passes. */
    manual: z.boolean().optional(),
    when: z.enum(["ci.enabled", "ci.required", "ci.advisory"]).optional(),
  })
  .extend(taskOverrideSchema.shape)
  .strict();

/** A native (task-chain) stage: `actions` and `exit-gate`. */
export const nativeStageSchema = z
  .object({
    id: identifierSchema,
    name: identifierSchema.optional(),
    /** A short sentence the dashboard shows in the stage's information dialog. */
    description: z.string().trim().min(1).max(280).optional(),
    /** An emoji the dashboard shows beside the stage's name. */
    icon: z.string().trim().min(1).max(16).optional(),
    approval: z.literal("manual").optional(),
    concurrency: z.number().int().positive(),
    retries: z.number().int().nonnegative().default(2),
    /** Settings for the stage's runs: `environment`, added to the repository's. */
    settings: levelSettingsSchema,
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

const ciModeSchema = z.enum(["required", "advisory", "disabled"]);

const junitReportSchema = z.object({
  artifact: z.string().trim().min(1, "must name an artifact").max(256),
  path: z.string().trim().min(1, "must name a report path").max(512).refine(
    (value) => !value.startsWith("/") && !value.split("/").includes(".."),
    "must be a relative path pattern without '..'",
  ),
}).strict();

/** A legacy provider name, or an object; normalised to { provider, mode, ignoreChecks, junit }. */
const repositoryCiSchema = z
  .union([
    identifierSchema,
    z
      .object({
        provider: identifierSchema.optional(),
        mode: ciModeSchema,
        ignoreChecks: z.array(identifierSchema).default([]),
        junit: junitReportSchema.optional(),
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
    return { provider: (value.provider ?? null) as string | null, mode: value.mode, ignoreChecks: value.ignoreChecks, ...(value.junit === undefined ? {} : { junit: value.junit }) };
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
    /** Absent when the repository follows the installation-wide `stages:` list. */
    pipeline: identifierSchema.optional(),
    ci: repositoryCiSchema,
    overrides: z
      .object({
        stages: z
          .record(
            identifierSchema,
            z
              .object({
                /** `true` passes the stage through without running it; it stays in the stage list. */
                skip: z.literal(true).optional(),
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
    agentToolchainPaths: agentToolchainPathsSchema.optional(),
    /** Settings for the repository's runs: `environment`, added to the root's. */
    settings: levelSettingsSchema,
    concurrency: z.number().int().positive().default(1),
    inFlight: z
      .object({
        limit: z.number().int().positive(),
        from: identifierSchema,
      })
      .strict()
      .optional(),
    extraTrustedLogins: z.array(
      z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\[bot\])?$/i, "must be a GitHub login"),
    ).default([]),
    systemLabels: z.array(identifierSchema).default([]),
    refinement: refinementOutputsSchema.optional(),
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
        noSplit: identifierSchema.optional(),
        paused: identifierSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .transform((labels) => ({
    ...labels,
    metadata: {
      ...labels.metadata,
      noSplit: labels.metadata.noSplit ?? `${labels.enrollment}:no-split`,
      paused: labels.metadata.paused ?? `${labels.enrollment}:paused`,
    },
  }));

/** How Conveyor treats GitHub being unavailable. */
const githubSchema = z
  .object({
    /** How long an item waits out a GitHub outage before it needs intervention. */
    outageWaitLimit: durationSchema.prefault("2h"),
  })
  .strict()
  .prefault({});

const baseConfigSchema = z
  .object({
    settings: settingsSchema,
    github: githubSchema,
    web: webSchema,
    sources: z.record(identifierSchema, providerEntrySchema).default({}),
    ci: z.record(identifierSchema, providerEntrySchema).default({}),
    codeHosts: z.record(identifierSchema, providerEntrySchema).default({}),
    runners: z.record(identifierSchema, runnerSchema).default({}),
    agents: z.record(identifierSchema, agentSchema).default({}),
    checks: z.record(identifierSchema, checkSchema).default({}),
    labels: labelsSchema,
    /** The installation-wide stage list that repositories without `pipeline:` follow. */
    stages: z.array(anyStageSchema).min(1).optional(),
    pipelines: z.record(identifierSchema, pipelineSchema).default({}),
    repositories: z.record(identifierSchema, repositorySchema).default({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.stages === undefined) return;
    if (Object.keys(config.pipelines).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["stages"],
        message: "stages and pipelines are both defined: use only one (stages is the installation-wide stage list; pipelines is deprecated)",
      });
    }
    const seen = new Set<string>();
    for (const [index, stage] of config.stages.entries()) {
      if (!isNativeStage(stage)) {
        context.addIssue({ code: "custom", path: ["stages", index, "run"], message: "legacy (run) stages are not allowed in stages; use actions and exit-gate" });
      }
      if (seen.has(stage.id)) {
        context.addIssue({ code: "custom", path: ["stages", index, "id"], message: `duplicate stage id "${stage.id}"` });
      }
      seen.add(stage.id);
    }
  });

type ParsedConfig = z.output<typeof baseConfigSchema>;
type ParsedRepository = ParsedConfig["repositories"][string];

/** The pipeline name a top-level `stages:` list is compiled under. */
export const STAGES_PIPELINE = "stages";

/**
 * A repository without `pipeline:` follows the top-level `stages:` list, which is carried as the
 * pipeline named `stages` so every consumer reads one shape.
 */
export const configSchema = baseConfigSchema.transform((config, context) => {
  const repositories: Record<string, Omit<ParsedRepository, "pipeline"> & { pipeline: string }> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    const pipeline = repository.pipeline ?? (config.stages ? STAGES_PIPELINE : undefined);
    if (pipeline === undefined) {
      context.addIssue({ code: "custom", path: ["repositories", id, "pipeline"], message: "is required when no top-level stages list is defined" });
      return z.NEVER;
    }
    repositories[id] = { ...repository, pipeline };
  }
  const pipelines = config.stages ? { ...config.pipelines, [STAGES_PIPELINE]: { stages: config.stages } } : config.pipelines;
  return { ...config, pipelines, repositories };
});

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
