import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import type {
  CheckContext,
  CheckResult,
  PipelineDependencies,
  PipelineStage,
  ProducerContext,
} from "../core/pipeline";
import type { ConveyorStore, StoredIssue } from "../db/store";
import { verifierToolGrant } from "../mcp/tools";
import type { EgressInput } from "../isolation/run-network";
import { agentEgressFor } from "../isolation/agent-egress";
import { runCodex, type CodexMcpConfiguration, type CodexRunInput } from "../runner/codex";
import {
  runCodexCheck,
  type CodexCheckInput,
  type CodexCheckRunResult,
} from "../runner/codex-check";
import { runJsonProcess } from "../runner/json-process";
import { EMPTY_USAGE, UNAVAILABLE_COST, type RunEnvelope } from "../runner/result";
import {
  agentActor,
  agentMessage,
  concise,
  conversationForPrompt,
  conveyorMessage,
  displayName,
  failedEnvelope,
  finishRun,
  producerConversationMessage,
  prompt,
  sentence,
  startRun,
} from "../tasks/agent-support";
import { scriptCommand } from "../self";
import { ExternalWaitError, type SourceActionOutcome } from "./ci-gate";

export interface RuntimeRepository {
  id: string;
  address: string;
  folder: string;
  baseBranch: string;
}

export interface RuntimeIssueContext {
  issue: StoredIssue;
  repository: RuntimeRepository;
  workspace: { path: string; branch: string } | null;
  sourceGuidance: string;
  delivery?: { pullRequest: unknown | null; checks: unknown[] };
}

export type RuntimeDeliveryState = NonNullable<RuntimeIssueContext["delivery"]>;

export interface ScopedMcpLease {
  configuration: CodexMcpConfiguration;
  close(): Promise<void> | void;
}

export interface ScopedMcpFactory {
  create(input: {
    runId: string;
    stageId: string;
    context: RuntimeIssueContext;
    allowedTools: readonly string[];
    actor: { id: string; name: string; title: string };
  }): Promise<ScopedMcpLease>;
}

export interface SourceActionHandler {
  run(
    action: { sourceAction: string; with?: Record<string, unknown> | undefined },
    context: ProducerContext & { producerResult?: RunEnvelope },
  ): Promise<void | SourceActionOutcome>;
}

export interface RuntimeImplementations {
  codex?: (input: CodexRunInput) => Promise<RunEnvelope>;
  codexCheck?: (input: CodexCheckInput) => Promise<CodexCheckRunResult>;
  jsonProcess?: typeof runJsonProcess;
}

function issueFrom(context: ProducerContext | CheckContext): StoredIssue {
  const issue = context.issue as Partial<StoredIssue>;
  if (!issue.id || typeof issue.sourceNumber !== "number") {
    throw new Error("runtime issue context is invalid");
  }
  return issue as StoredIssue;
}

function verifierConversationMessage(
  stageId: string,
  phase: "enter" | "exit",
  result: CheckResult,
): string {
  const reason = result.reason ? sentence(result.reason, 700) : "No reason was provided.";
  const fixes = result.requiredFixes.length > 0
    ? ` Required: ${sentence(result.requiredFixes.join("; "), 700)}`
    : "";
  const evidence = result.evidence.length > 0
    ? ` Evidence: ${sentence(result.evidence.join("; "), 700)}`
    : "";
  return `${displayName(stageId)} ${phase} verification failed: ${reason}${fixes}${evidence}`;
}

async function evidenceScript(
  script: string,
  interpreter: readonly string[] | undefined,
  cwd: string,
  input: unknown,
): Promise<unknown> {
  const child = Bun.spawn(scriptCommand(script, interpreter), {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  child.stdin.write(JSON.stringify(input));
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `evidence script ${script} exited with ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  try {
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(
      `evidence script ${script} must return one JSON value: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class ConfiguredStageRuntime implements PipelineDependencies {
  readonly #codex: (input: CodexRunInput) => Promise<RunEnvelope>;
  readonly #codexCheck: (input: CodexCheckInput) => Promise<CodexCheckRunResult>;
  readonly #jsonProcess: typeof runJsonProcess;

  constructor(
    private readonly config: ConveyorConfig,
    private readonly store: ConveyorStore,
    private readonly context: RuntimeIssueContext,
    private readonly mcp: ScopedMcpFactory,
    private readonly actions: SourceActionHandler,
    private readonly refreshDeliveryState?: () => Promise<RuntimeDeliveryState>,
    implementations: RuntimeImplementations = {},
    private readonly signal?: AbortSignal,
  ) {
    this.#codex = implementations.codex ?? runCodex;
    this.#codexCheck = implementations.codexCheck ?? runCodexCheck;
    this.#jsonProcess = implementations.jsonProcess ?? runJsonProcess;
  }

  private egressInput(runner: { controlPlaneHosts?: string[] | undefined }): { egress?: EgressInput } {
    const egress = agentEgressFor(this.config, this.context.repository.id, runner);
    return egress ? { egress } : {};
  }

  private configuredStatuses(stageId: string): {
    allowedSuccessStatuses: string[];
    allowedFailureStatuses: string[];
  } {
    const repository = this.config.repositories[this.context.repository.id];
    const pipeline = repository ? this.config.pipelines[repository.pipeline] : undefined;
    const found = pipeline?.stages.find((candidate) => candidate.id === stageId);
    const stage = found && !isNativeStage(found) ? found : undefined;
    return {
      allowedSuccessStatuses: [...(stage?.successStatuses ?? pipeline?.successStatuses ?? [])],
      allowedFailureStatuses: [...(stage?.failureStatuses ?? pipeline?.failureStatuses ?? [])],
    };
  }

  async runProducer(stage: PipelineStage, context: ProducerContext): Promise<RunEnvelope> {
    const issue = issueFrom(context);
    if (stage.run.type === "source-action") {
      const started = performance.now();
      try {
        const outcome = await this.actions.run(
          {
            sourceAction: stage.run.action,
            ...(stage.run.input ? { with: stage.run.input } : {}),
          },
          context,
        );
        const stageResult = outcome
          ? {
              outcome: outcome.outcome,
              status: outcome.status,
              summary: outcome.summary,
              reason: outcome.reason,
              metrics: {},
            }
          : {
              outcome: "success" as const,
              status: stage.successStatuses?.[0] ?? "done",
              summary: `Completed source action ${stage.run.action}`,
              reason: null,
              metrics: {},
            };
        this.conveyorMessage(
          issue.id,
          stage.id,
          null,
          outcome ? outcome.summary : `${displayName(stage.id)} completed.`,
        );
        return {
          stageResult,
          sessionId: null,
          usage: { ...EMPTY_USAGE },
          cost: { ...UNAVAILABLE_COST },
          durationMs: Math.max(0, Math.round(performance.now() - started)),
          exitCode: 0,
          artifacts: [],
          stderr: "",
        };
      } catch (error) {
        // A pending external condition is polled quietly, apart from its one-off announcement.
        if (error instanceof ExternalWaitError) {
          if (error.announcement) this.conveyorMessage(issue.id, stage.id, null, error.announcement);
        } else {
          this.conveyorMessage(issue.id, stage.id, null, `${displayName(stage.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    const kind = "producer";
    const runId = startRun(this.store, { issueId: issue.id, stageId: stage.id, kind, configHash: this.config.hash });
    const started = performance.now();
    let producerAgentId: string | null = null;

    try {
      let result: RunEnvelope;
      if (stage.run.type === "script") {
        this.conveyorMessage(issue.id, stage.id, runId, `${displayName(stage.id)} script started.`);
        result = await this.#jsonProcess({
          command: scriptCommand(stage.run.script, stage.run.interpreter),
          cwd: this.context.workspace?.path ?? this.context.repository.folder,
          input: { ...context, runId, repository: this.context.repository },
          interruptGraceMs: this.config.settings.interruptGraceMs,
          ...(this.signal ? { signal: this.signal } : {}),
        });
      } else {
        producerAgentId = stage.run.agent;
        const agent = this.config.agents[stage.run.agent];
        if (!agent) throw new Error(`unknown agent: ${stage.run.agent}`);
        const runner = this.config.runners[agent.runner];
        if (!runner || runner.type !== "codex") {
          throw new Error(`agent ${stage.run.agent} must use a Codex runner in v0.1`);
        }
        const workspace = this.context.workspace?.path;
        if (!workspace) throw new Error(`agent stage ${stage.id} requires a workspace`);
        this.conveyorMessage(
          issue.id,
          stage.id,
          runId,
          `${displayName(stage.id)} started — ${agent.name ?? displayName(stage.run.agent)} (${agent.title ?? "AI Agent"}).`,
        );
        const lease = await this.mcp.create({
          runId,
          stageId: stage.id,
          context: this.context,
          allowedTools: agent.tasks,
          actor: this.agentActor(stage.run.agent),
        });
        try {
          const instructions = await readFile(agent.instructions, "utf8");
          result = await this.#codex({
            command: runner.command,
            workspace,
            artifactsDirectory: path.join(this.config.settings.artifacts, runId),
            prompt: prompt(
              {
                issue,
                repository: this.context.repository,
                stageId: stage.id,
                attempt: context.attempt,
                feedback: context.feedback,
                ...this.configuredStatuses(stage.id),
                conversation: conversationForPrompt(this.store, issue.id),
              },
              instructions,
              { progressReporting: agent.tasks.includes("agent.reportProgress"), grantedTools: agent.tasks },
            ),
            ...(agent.model ? { model: agent.model } : {}),
            ...(agent.effort ? { effort: agent.effort } : {}),
            sandbox:
              agent.workspaceAccess === "read-only" ? "read-only" : runner.sandbox,
            automaticApprovals: runner.automaticApprovals,
            mcp: lease.configuration,
            ...this.egressInput(runner),
            interruptGraceMs: this.config.settings.interruptGraceMs,
            ...(this.signal ? { signal: this.signal } : {}),
            onEvent: (event) => {
              this.store.appendRunEvent(runId, "harness", event);
            },
          });
        } finally {
          await lease.close();
        }
      }
      this.finishRun(runId, "succeeded", result);
      if (producerAgentId) {
        this.agentMessage(
          issue.id,
          stage.id,
          runId,
          producerAgentId,
          producerConversationMessage(stage.id, result),
        );
      } else {
        this.conveyorMessage(
          issue.id,
          stage.id,
          runId,
          `${displayName(stage.id)} script completed: ${sentence(result.stageResult.summary)}`,
        );
      }
      return result;
    } catch (error) {
      const failure = failedEnvelope(
        error,
        Math.max(0, Math.round(performance.now() - started)),
      );
      this.finishRun(runId, "failed", failure);
      this.conveyorMessage(
        issue.id,
        stage.id,
        runId,
        `${displayName(stage.id)} ${stage.run.type === "script" ? "script" : "runner"} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async runCheck(
    checkId: string,
    phase: "enter" | "exit",
    context: CheckContext,
  ): Promise<CheckResult> {
    const definition = this.config.checks[checkId];
    if (!definition) throw new Error(`unknown check: ${checkId}`);
    const agent = this.config.agents[definition.verifier];
    if (!agent) throw new Error(`unknown verifier agent: ${definition.verifier}`);
    const runner = this.config.runners[agent.runner];
    if (!runner || runner.type !== "codex") {
      throw new Error(`verifier ${definition.verifier} must use a Codex runner in v0.1`);
    }
    const issue = issueFrom(context);
    const workspace = this.context.workspace?.path ?? this.context.repository.folder;
    if (this.refreshDeliveryState) {
      try {
        this.context.delivery = await this.refreshDeliveryState();
      } catch (error) {
        this.conveyorMessage(
          issue.id,
          context.stageId,
          null,
          `${displayName(context.stageId)} delivery refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
    let evidence: unknown = null;
    if (definition.script) {
      try {
        evidence = await evidenceScript(definition.script, definition.interpreter, workspace, {
          phase,
          stageId: context.stageId,
          issue,
          producerResult: context.producerResult,
        });
      } catch (error) {
        this.conveyorMessage(issue.id, context.stageId, null, `${displayName(context.stageId)} check script failed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
    const kind = `${phase}-verifier`;
    const runId = startRun(this.store, { issueId: issue.id, stageId: context.stageId, kind, configHash: this.config.hash });
    const started = performance.now();
    let lease: ScopedMcpLease | null = null;
    try {
      lease = await this.mcp.create({
        runId,
        stageId: context.stageId,
        context: this.context,
        allowedTools: verifierToolGrant(agent.tasks),
        actor: this.agentActor(definition.verifier),
      });
      const instructions = await readFile(agent.instructions, "utf8");
      const result = await this.#codexCheck({
        command: runner.command,
        workspace,
        artifactsDirectory: path.join(this.config.settings.artifacts, runId),
        prompt: prompt(
          {
            issue,
            repository: this.context.repository,
            phase,
            stageId: context.stageId,
            attempt: context.attempt,
            feedback: context.feedback,
            producerResult: context.producerResult,
            evidence,
            ...this.configuredStatuses(context.stageId),
            conversation: conversationForPrompt(this.store, issue.id),
          },
          instructions,
          { progressReporting: agent.tasks.includes("agent.reportProgress"), grantedTools: verifierToolGrant(agent.tasks) },
        ),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: "read-only",
        automaticApprovals: false,
        mcp: lease.configuration,
        ...this.egressInput(runner),
        interruptGraceMs: this.config.settings.interruptGraceMs,
        ...(this.signal ? { signal: this.signal } : {}),
        onEvent: (event) => {
          this.store.appendRunEvent(runId, "harness", event);
        },
      });
      this.store.finishRun(runId, {
        status: "succeeded",
        exitCode: result.exitCode,
        result,
        sessionId: result.sessionId,
        usage: {
          ...result.usage,
          amount: 0,
          currency: "USD",
          source: "unavailable",
          durationMs: result.durationMs,
        },
      });
      if (result.decision === "fail") {
        this.agentMessage(
          issue.id,
          context.stageId,
          runId,
          definition.verifier,
          verifierConversationMessage(context.stageId, phase, result),
        );
      }
      return result;
    } catch (error) {
      const failure = failedEnvelope(
        error,
        Math.max(0, Math.round(performance.now() - started)),
      );
      this.finishRun(runId, "failed", failure);
      this.conveyorMessage(
        issue.id,
        context.stageId,
        runId,
        `${phase === "enter" ? "Entry" : "Exit"} verifier could not complete: ${concise(error instanceof Error ? error.message : String(error), 700)}`,
      );
      throw error;
    } finally {
      await lease?.close();
    }
  }

  async runAction(
    action: PipelineStage["afterSuccess"][number],
    context: ProducerContext & { producerResult: RunEnvelope },
  ): Promise<void> {
    const issue = issueFrom(context);
    const actionName = displayName(action.sourceAction.replaceAll(".", "-"));
    this.conveyorMessage(issue.id, context.stageId, null, `${actionName} started.`);
    try {
      await this.actions.run(action, context);
      this.conveyorMessage(issue.id, context.stageId, null, `${actionName} completed.`);
    } catch (error) {
      this.conveyorMessage(issue.id, context.stageId, null, `${actionName} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private finishRun(runId: string, status: string, result: RunEnvelope): void {
    finishRun(this.store, runId, status, result);
  }

  private agentActor(agentId: string): { id: string; name: string; title: string } {
    return agentActor(this.config, agentId);
  }

  private conveyorMessage(
    issueId: string,
    stageId: string,
    runId: string | null,
    message: string,
  ): void {
    conveyorMessage(this.store, issueId, stageId, runId, message);
  }

  private agentMessage(
    issueId: string,
    stageId: string,
    runId: string,
    agentId: string,
    message: string,
  ): void {
    agentMessage(this.store, this.config, issueId, stageId, runId, agentId, message);
  }
}

export async function ensureRuntimeDirectories(config: ConveyorConfig): Promise<void> {
  await Promise.all([
    mkdir(config.settings.logs, { recursive: true }),
    mkdir(config.settings.artifacts, { recursive: true }),
    mkdir(config.settings.workspaces, { recursive: true }),
  ]);
}
