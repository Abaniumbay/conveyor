// The `agent` task group. `agent.run` runs a configured agent through a harness and captures
// its result; the other tasks are the reporting, question and artifact tools an agent calls
// through its MCP grant (behaviour moved from the legacy `run.*` MCP tools).
//
// Questions park the action. What a re-entry needs is already durable: the run record (and its
// session id) and the question the run opened. A resumed execution therefore reads those back
// instead of keeping extra state: an open question is still pending, an answered one continues
// the session when the harness can resume and otherwise starts a fresh attempt that carries the
// question and answer. Both paths end in the same captured result.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { isHarnessRunner } from "../config/schema";
import type { ConversationStore, RunLogStore } from "../db/ports";
import type { StoredQuestion } from "../db/store";
import type { Harness, HarnessProfile, HarnessRunInput } from "../harness/types";
import { agentEgressFor } from "../isolation/agent-egress";
import { probeAgentMcpServers, type AgentMcpProbeOptions, type McpServerSpec } from "../isolation/mcp-probe";
import { protectedServiceLocations, resolveToolchainPaths } from "../isolation/toolchain-paths";
import { assertNoHostTmpWritableRoots } from "../isolation/scratch";
import { resolveFilesystemPath } from "../core/paths";
import type { RunEnvelope } from "../runner/result";
import {
  AGENT_STOP_STATUSES, agentActor, agentMessage, conversationForPrompt, conveyorMessage, reportMcpFailures, failedEnvelope, finishRun,
  producerConversationMessage, prompt, startRun, warnOnTokenUsage } from "./agent-support";
import type { AgentContext } from "./context";
import { buildHandover, type HandoverDeps } from "./handover";
import { defineGroup, fail, InfrastructureError, pass, pending, type TaskArgs, type TaskDefinition, type TaskResult } from "./contract";
import type { TaskDeps } from "./deps";
import { ensureGitExcludes, worktreeGitPaths } from "../workspace/git";
import { ensureWorkspace } from "../workspace/lifecycle";
import { WorkspaceError, workspaceScratchPath } from "../workspace/manager";
import { linkExistingChange } from "../codehost/actions";
import type { CodeHost } from "../codehost/types";
import type { ItemStore } from "../db/ports";
import { normalizedQuestionOptions, questionConfigurationError } from "../questions";

/**
 * What the agent group uses: the item's workspace, runs, questions and conversation, the handover's
 * reads, the harnesses and the run-scoped MCP endpoint. It never gets git, the CI watch or the operator facade.
 */
export type AgentTaskDeps = HandoverDeps
  & Pick<TaskDeps, "config" | "repository" | "issueId" | "sourceGuidance" | "workspaces" | "mcp" | "harnesses" | "delivery" | "run" | "signal">
  & {
    store: ItemStore & RunLogStore & ConversationStore;
    codeHost?: Pick<CodeHost, "findOpenChange" | "getChangeDelivery"> | null;
  };

type Deps = AgentTaskDeps;

const KIND = "producer";
const runConfig = z
  .object({
    agent: z.string().min(1, "agent must name a configured agent").optional(),
    /** Agents in order of preference: the next one runs when the one before cannot (its harness failed). */
    agents: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .refine((value) => (value.agent === undefined) !== (value.agents === undefined), "set exactly one of agent or agents");
type RunConfig = z.output<typeof runConfig>;

const waiting = (question: string) => `Waiting for an answer: ${question}`;

function answerText(question: StoredQuestion): string {
  const answer = question.answer;
  if (answer && typeof answer === "object" && typeof (answer as { answer?: unknown }).answer === "string") {
    return (answer as { answer: string }).answer;
  }
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

interface Answered { question: string; answer: string; sessionId: string | null; agentId: string | null }

/**
 * Reads back what this execution left: its runs are linked by the act's idempotency key, and the
 * most recent run that opened a question decides (open: still waiting; answered: continue). Walking
 * back over the runs keeps the answer when the resumed run itself crashed.
 */
function priorQuestion(deps: Deps, stage: string, executionKey: string): { open: StoredQuestion } | { answered: Answered } | null {
  for (const prior of deps.store.listRunsForExecution(deps.issueId, stage, KIND, executionKey)) {
    const question = deps.store.getQuestionForRun(prior.id);
    if (!question) continue;
    if (question.status === "open") return { open: question };
    return { answered: { question: question.prompt, answer: answerText(question), sessionId: prior.sessionId, agentId: executionAgent(deps, prior.id) } };
  }
  return null;
}

/** The agent a run was started for, from its execution event (absent on runs recorded before agent lists). */
function executionAgent(deps: Deps, runId: string): string | null {
  const event = deps.store.listRunEvents(runId).find((entry) => entry.type === "execution");
  const agentId = (event?.payload as { agentId?: unknown } | undefined)?.agentId;
  return typeof agentId === "string" ? agentId : null;
}

function outcomeOf(deps: Deps, runIds: string[], agentId: string, result: RunEnvelope): TaskResult {
  const { status, outcome, summary, reason } = result.stageResult;
  const captured: AgentContext = { agentId, status, summary, reason, sessionId: result.sessionId, runId: runIds[runIds.length - 1]! };
  if (status === "needs-input") {
    const question = [...runIds].reverse().map((id) => deps.store.getQuestionForRun(id)).find((found) => found !== null) ?? null;
    if (question?.status === "open") return pending(waiting(question.prompt));
    // Answered while the agent was still finishing: poll again at once and continue from the answer.
    if (question) return pending(waiting(question.prompt), { after: 0 });
    return fail("Agent returned an invalid result: it reported needs-input but opened no question; it must call agent.askQuestion first", { route: { stop: "error" } });
  }
  if (status === "changes-requested") {
    // Use the same item-scoped open findings as the review gate. Imported findings and
    // unresolved findings from earlier runs still block; the reviewer need not duplicate them.
    if (!deps.store.findings().listVisible(deps.issueId).some((finding) => finding.state === "open")) {
      return fail("Reviewer requested changes without an open finding for this item", { route: { stop: "error" } });
    }
    return pass(captured);
  }
  if ((AGENT_STOP_STATUSES as readonly string[]).includes(status)) return fail(reason ?? summary, { route: { stop: status } });
  if (outcome === "success") return pass(captured);
  return fail(`Agent returned an invalid result: unexpected failure status "${status}" (${reason ?? summary})`, { route: { stop: "error" } });
}

/** A shutdown abort is authoritative evidence that the control channel was deliberately torn down.
 * Do not turn a result containing only that transient failure into an owner-facing blocker. */
function restartOnlyControlFailure(deps: Deps, result: RunEnvelope): boolean {
  if (!deps.signal?.aborted || result.stageResult.status !== "blocked") return false;
  const detail = [result.stageResult.summary, result.stageResult.reason].filter((value): value is string => typeof value === "string").join("\n");
  if (!/socket connection was closed|socket hang up|fetch failed|network error|connection (?:reset|refused)|econnreset|econnrefused|epipe/i.test(detail)) return false;
  // A real blocker is allowed to mention transport trouble as supporting evidence. These terms
  // indicate that the agent supplied a substantive reason that must retain the normal path.
  return !/\b(?:permission|unauthori[sz]ed|validation|invalid input|merge conflict|test failure|build failure|product decision|owner input|human input)\b/i.test(detail);
}

const run: TaskDefinition<RunConfig, unknown, Deps> = {
  name: "agent.run",
  kind: "act",
  description:
    "Runs a configured agent (`agent`, or `agents` in order of preference: the next runs when one's harness cannot) through its harness in the item's workspace (creating or re-attaching it when needed) and captures `{ agentId, status, summary, reason, sessionId, runId }` in `agent`. `needs-input` parks the action until the question is answered, then continues the agent's session when the harness supports resuming and otherwise starts a fresh attempt that carries the question and answer. `blocked` and `rejected` stop with the agent's reason, `changes-requested` passes (the exit gate decides) when the item has an open finding, including imported findings or findings from earlier runs, and otherwise stops as an error. An invalid structured result is returned to the same agent once, in the same session, with the validation message; a second one ends the attempt as an infrastructure error retried with the executor's backoff. Only a harness that cannot run (usage limit, process failure or missing CLI) falls back to the next agent; workspace, MCP and protocol errors do not.",
  reads: ["run"],
  writes: ["agent"],
  invalidates: ["workspace"],
  config: runConfig,
  defaultWait: { timeoutMs: null, pollMs: 60_000 },
  async run({ context, config, deps, instance }: TaskArgs<RunConfig, unknown, Deps>) {
    let answered: Answered | null = null;
    if (instance.resumed) {
      const prior = priorQuestion(deps, instance.stage, instance.idempotencyKey);
      if (prior && "open" in prior) return pending(waiting(prior.open.prompt));
      answered = prior?.answered ?? null;
    }

    // The last round failed only on something the stage's own actions repair (e.g. the PR checklist): nothing for the agent to do.
    if (!answered && context.run?.feedback?.repairedByActions) return pass();

    const listed = config.agents ?? [config.agent!];
    // An answered question goes back to the agent that asked it, first.
    const order = answered?.agentId && listed.includes(answered.agentId)
      ? [answered.agentId, ...listed.filter((id) => id !== answered!.agentId)]
      : listed;
    for (const [index, agentId] of order.entries()) {
      // Another agent cannot continue the asker's session: it starts fresh with the question and answer.
      const forThisAgent = answered?.agentId && answered.agentId !== agentId ? { ...answered, sessionId: null } : answered;
      try {
        return await runWithCorrection({ context, deps, instance }, agentId, forThisAgent);
      } catch (error) {
        const next = order[index + 1];
        if (!next || !canFallBack(error, deps)) throw asInfrastructure(error);
        conveyorMessage(deps.store, deps.issueId, instance.stage, null,
          `${agentActor(deps.config, agentId).name} could not run (${errorText(error)}); ${agentActor(deps.config, next).name} takes this ${instance.stage} instead.`);
      }
    }
    throw new Error("agent.run has no agent to run");
  },
};

class WorkspaceInfrastructureError extends InfrastructureError {}

interface Correction { message: string; sessionId: string }

/**
 * An invalid structured result goes back to the same agent once, in the same session, with the validation
 * message. A second invalid result (or a harness that cannot resume) is an infrastructure error.
 */
async function runWithCorrection(
  args: Pick<TaskArgs<RunConfig, unknown, Deps>, "context" | "deps" | "instance">,
  agentId: string,
  answered: Answered | null,
): Promise<TaskResult> {
  // A question the agent opened before its result was rejected belongs to the first run; the corrected result may still point at it.
  const runIds: string[] = [];
  try {
    return await runAgent(args, agentId, answered, null, runIds);
  } catch (error) {
    const sessionId = (error as { sessionId?: unknown } | null)?.sessionId;
    if (!isInvalidResult(error) || typeof sessionId !== "string" || args.deps.signal?.aborted) throw error;
    const runner = args.deps.config.runners[args.deps.config.agents[agentId]?.runner ?? ""];
    if (!runner || !isHarnessRunner(runner) || !args.deps.harnesses?.[runner.type]?.capabilities.sessionResume) throw error;
    return await runAgent(args, agentId, answered, { message: (error as Error).message, sessionId }, runIds);
  }
}

function errorKind(error: unknown): unknown {
  return (error as { kind?: unknown } | null)?.kind;
}

function isInvalidResult(error: unknown): boolean {
  return errorKind(error) === "invalid-result";
}

/** Only a harness that cannot run falls back: a usage limit, a process that fails or cannot start, a missing CLI. */
function canFallBack(error: unknown, deps: Deps): boolean {
  if (deps.signal?.aborted) return false;
  if (error instanceof WorkspaceInfrastructureError || error instanceof InfrastructureError) return false;
  const kind = errorKind(error);
  if (kind === "usage-limit" || kind === "process") return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/** Failures that neither fall back nor are interruptions are retried by the executor as infrastructure errors. */
function asInfrastructure(error: unknown): unknown {
  if (error instanceof InfrastructureError) return error;
  const kind = errorKind(error);
  if (kind === "protocol" || kind === "invalid-result" || kind === "timeout" || kind === "sandbox") {
    return new InfrastructureError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  return error;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

async function runAgent(
  { context, deps, instance }: Pick<TaskArgs<RunConfig, unknown, Deps>, "context" | "deps" | "instance">,
  agentId: string,
  answered: Answered | null,
  correction: Correction | null,
  runIds: string[],
): Promise<TaskResult> {
  const { store } = deps;
  const issue = store.getIssue(deps.issueId);
  if (!issue) throw new InfrastructureError(`issue ${deps.issueId} is not stored`);
  const agent = deps.config.agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const runner = deps.config.runners[agent.runner];
  if (!runner || !isHarnessRunner(runner)) {
    throw new Error(`agent ${agentId} must use a runner with an agent harness`);
  }
  const harness: Harness | undefined = deps.harnesses?.[runner.type];
  if (!harness || !deps.mcp) throw new InfrastructureError(`no harness is available for runner type ${runner.type}`);
  // The agent works in the item's workspace; a stage whose first action is this one gets it created here.
  // A workspace failure belongs to the host, not the agent: no other agent is better placed, so it is retried as infrastructure.
  const workspace = await ensureWorkspace({ store, manager: deps.workspaces, issueId: deps.issueId, repository: deps.repository })
    .catch((error: unknown) => {
      if (error instanceof WorkspaceError) throw new WorkspaceInfrastructureError(`workspace preparation failed: ${error.message}`, { cause: error });
      throw error;
    });
  if (deps.codeHost) {
    await linkExistingChange({
      codeHost: deps.codeHost, store, address: deps.repository.address, issueId: deps.issueId, branch: workspace.branch,
    });
  }

  const stageId = instance.stage;
  const runId = startRun(store, { issueId: issue.id, stageId, kind: KIND, configHash: deps.config.hash });
  store.appendRunEvent(runId, "execution", { idempotencyKey: instance.idempotencyKey, agentId });
  runIds.push(runId);
  const started = performance.now();
  try {
    const lease = await deps.mcp.create({
      runId,
      stageId,
      context: {
        issue, repository: deps.repository, workspace: { path: workspace.path, branch: workspace.branch },
        sourceGuidance: deps.sourceGuidance, ...(deps.delivery ? { delivery: await deps.delivery() } : {}),
      },
      allowedTools: agent.tasks,
      actor: agentActor(deps.config, agentId),
      toolNameGuidance: harness.profile.toolNameGuidance,
    });
    let result: RunEnvelope;
    try {
      const handover = await buildHandover(deps, { runId, stageId, agentId, kind: KIND, workspace: { path: workspace.path, branch: workspace.branch } });
      await probeConfiguredMcpServers(store, {
        issueId: issue.id, stageId, runId, agentId, servers: agent.mcpServers,
        sandbox: {
          workspace: workspace.path,
          env: agent.env,
          readOnly: agent.workspaceAccess === "read-only",
          writableRoots: (await agentAccess(agent, workspace.path)).writableRoots,
          toolchainPaths: toolchainFor(deps).toolchainPaths,
          egress: egressFor(deps, runner).egress,
        },
      });
      const resume = answered !== null && harness.capabilities.sessionResume && answered.sessionId !== null;
      const shared = {
        command: runner.command,
        workspace: workspace.path,
        artifactsDirectory: path.join(deps.config.settings.artifacts, runId),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        ...(Object.keys(agent.env ?? {}).length > 0 ? { env: agent.env } : {}),
        ...runSettings(harness.profile, runner, agent),
        ...egressFor(deps, runner),
        ...(await agentAccess(agent, workspace.path)),
        temporaryDirectory: workspaceScratchPath(workspace.path),
        ...await agentExtensions(agent, workspace.path),
        ...toolchainFor(deps),
        mcp: lease.configuration,
        interruptGraceMs: deps.config.settings.interruptGraceMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
        onEvent: (event: unknown) => { store.appendRunEvent(runId, "harness", event); },
      };
      if (correction) {
        result = await harness.run({
          ...shared,
          prompt: prompt(
            { handover },
            `Your result was rejected: ${correction.message}\nReturn the required structured result again, corrected.`,
            { progressReporting: agent.tasks.includes("agent.reportProgress"), grantedTools: agent.tasks, toolNameGuidance: harness.profile.toolNameGuidance },
          ),
          resumeSessionId: correction.sessionId,
        });
      } else if (resume) {
        result = await harness.run({
          ...shared,
          prompt: prompt(
            { handover, answeredQuestion: { question: answered!.question, answer: answered!.answer } },
            "Your question was answered. Continue the work using this run's refreshed tool grant and return the required structured result.",
            { progressReporting: agent.tasks.includes("agent.reportProgress"), grantedTools: agent.tasks, toolNameGuidance: harness.profile.toolNameGuidance },
          ),
          resumeSessionId: answered!.sessionId!,
          answeredQuestion: { question: answered!.question, answer: answered!.answer },
        });
      } else {
        const instructions = await readFile(agent.instructions, "utf8");
        result = await harness.run({
          ...shared,
          prompt: prompt(
            {
              issue,
              repository: deps.repository,
              stageId,
              attempt: context.run?.attempt,
              feedback: context.run?.feedback ?? null,
              handover,
              ...(answered ? { answeredQuestion: { question: answered.question, answer: answered.answer } } : {}),
              conversation: conversationForPrompt(store, issue.id),
            },
            instructions,
            { progressReporting: agent.tasks.includes("agent.reportProgress"), grantedTools: agent.tasks, toolNameGuidance: harness.profile.toolNameGuidance },
          ),
        });
      }
    } finally {
      await lease.close();
    }
    const interrupted = restartOnlyControlFailure(deps, result);
    if (interrupted) {
      result = {
        ...result,
        stageResult: { ...result.stageResult, status: "interrupted", outcome: "failure", summary: "Agent control connection was interrupted by service shutdown" },
      };
    }
    finishRun(store, runId, interrupted ? "interrupted" : "succeeded", result);
    warnOnTokenUsage(store, deps.config, issue.id, stageId, runId, agentId, result.usage.inputTokens);
    agentMessage(store, deps.config, issue.id, stageId, runId, agentId, producerConversationMessage(stageId, result));
    return interrupted
      ? fail(result.stageResult.summary, { route: { stop: "interrupted" } })
      : outcomeOf(deps, runIds, agentId, result);
  } catch (error) {
    finishRun(
      store,
      runId,
      deps.signal?.aborted ? "interrupted" : "failed",
      failedEnvelope(error, Math.max(0, Math.round(performance.now() - started))),
    );
    throw error;
  }
}

// Tools. Each runs under an MCP grant, which supplies `deps.run` (the run and who is calling).

const looseInput = z.looseObject({});
const progressInput = z.looseObject({ message: z.string() });
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const structuredQuestionOption = z.looseObject({
  id: z.string().optional(),
  label: z.string(),
  description: z.string().optional(),
});
const askInput = z.object({
  prompt: z.string(),
  reason: z.string(),
  options: lenient(z.array(lenient(z.union([z.string(), structuredQuestionOption])))),
  minSelections: lenient(z.number()),
  maxSelections: lenient(z.number()),
  allowFreeText: lenient(z.boolean()),
});

function runOf(deps: Deps): NonNullable<Deps["run"]> {
  if (!deps.run) throw new Error("agent tools need a run: call them through an agent MCP grant");
  return deps.run;
}

function event<I>(name: string, description: string, type: string, input: z.ZodType<I>, after?: (args: TaskArgs<unknown, I, Deps>, run: NonNullable<Deps["run"]>) => void, mutating = false): TaskDefinition<unknown, I, Deps> {
  return {
    name, kind: "tool", description, reads: [], writes: [], invalidates: [], input,
    ...(mutating ? { mutating: true } : {}),
    run(args) {
      const run = runOf(args.deps);
      args.deps.store.appendRunEvent(run.id, type, args.input);
      after?.(args, run);
      return pass({ accepted: true });
    },
  };
}

const reportProgress = event("agent.reportProgress", "Report a concise user-facing progress update; it is posted to the shared conversation.", "report_progress", progressInput,
  ({ deps, input, instance }, run) => {
    if (!run.actor) return;
    deps.store.appendConversationMessage({
      issueId: deps.issueId, runId: run.id, stageId: instance.stage, actorType: "agent", actorId: run.actor.id,
      actorName: run.actor.name, actorTitle: run.actor.title, message: input!.message,
    });
  });

const askQuestion: TaskDefinition<unknown, z.output<typeof askInput>, Deps> = {
  name: "agent.askQuestion",
  kind: "tool",
  description: "Ask the user a structured question. Choices may be strings or `{ id, label, description? }` objects; `id` is the stored answer identifier and `label` is displayed. Legacy `{ value, label }` choices are normalized to `id`. The agent's run then ends with `needs-input` and the stage waits for the answer.",
  reads: [], writes: [], invalidates: [],
  input: askInput,
  run({ deps, input }) {
    const run = runOf(deps);
    const questionError = questionConfigurationError(input!.options ?? [], input!.allowFreeText === true);
    if (questionError) throw new Error(questionError);
    const question = deps.store.openQuestion({
      issueId: deps.issueId,
      runId: run.id,
      prompt: input!.prompt,
      reason: input!.reason,
      options: normalizedQuestionOptions(input!.options ?? []),
      minSelections: input!.minSelections ?? 1,
      maxSelections: input!.maxSelections ?? 1,
      allowFreeText: input!.allowFreeText === true,
    });
    deps.store.appendRunEvent(run.id, "question", { questionId: question.id });
    return pass({ accepted: true, questionId: question.id });
  },
};

export const agentGroup = defineGroup<AgentTaskDeps>("agent", [
  run,
  askQuestion,
  reportProgress,
  event("agent.reportRationale", "Record the agent's rationale for the audit trail.", "report_rationale", looseInput),
  event("agent.reportBlocker", "Record a blocker the agent hit.", "report_blocker", looseInput),
  event("agent.reportResult", "Record the agent's result report.", "report_result", looseInput),
  event("agent.reportMilestone", "Record a milestone the agent reached.", "report_milestone", looseInput),
  event("agent.recordArtifact", "Record an artifact (a log, a report, a file) produced during the run.", "record_artifact", looseInput, undefined, true),
]);

/**
 * What an agent may reach beyond its sandbox defaults. A workspace-write agent owns its whole
 * worktree, including the git metadata kept under the main repository's .git, plus any configured
 * roots (package caches) that exist on this machine.
 */
async function agentAccess(
  agent: { workspaceAccess: string; network?: boolean; writableRoots?: string[] },
  workspace: string,
): Promise<{ network?: true; writableRoots?: string[] }> {
  // Read-only agents never receive configured writable roots, so those paths cannot reopen
  // host /tmp writes. Validate roots only when they will be handed to a write-capable runner.
  if (agent.workspaceAccess !== "read-only") assertNoHostTmpWritableRoots(agent.writableRoots);
  const roots = agent.workspaceAccess === "read-only" ? [] : [...await worktreeGitPaths(workspace), workspaceScratchPath(workspace), ...(agent.writableRoots ?? [])];
  const writableRoots = [...new Set(roots)].filter((root) => existsSync(root)).map(resolveFilesystemPath);
  return { ...(agent.network ? { network: true as const } : {}), ...(writableRoots.length > 0 ? { writableRoots } : {}) };
}

/**
 * The agent's harness settings and MCP servers, with `{workspace}` in server arguments replaced by the
 * run's worktree. Files the servers write inside the worktree are excluded from git first, so they can
 * never be committed or block a clean-tree check. Settings are non-empty only for a harness whose
 * plugin takes them: the configuration refuses them otherwise.
 */
async function agentExtensions(
  agent: {
    harnessSettings?: Record<string, string | number | boolean>;
    mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string>; startupTimeoutSec?: number | undefined; enabledTools?: string[] | undefined; gitExclude: string[] }>;
  },
  workspace: string,
): Promise<{ config?: Record<string, string | number | boolean>; mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string>; startupTimeoutSec?: number; enabledTools?: string[] }> }> {
  const servers = Object.entries(agent.mcpServers ?? {});
  await ensureGitExcludes(workspace, servers.flatMap(([, server]) => server.gitExclude));
  const config = agent.harnessSettings ?? {};
  return {
    ...(Object.keys(config).length > 0 ? { config } : {}),
    ...(servers.length > 0
      ? {
          mcpServers: Object.fromEntries(servers.map(([name, { command, args, env, startupTimeoutSec, enabledTools }]) => [
            name,
            {
              command,
              args: args.map((arg) => arg.replaceAll("{workspace}", workspace)),
              env,
              ...(startupTimeoutSec !== undefined ? { startupTimeoutSec } : {}),
              ...(enabledTools ? { enabledTools } : {}),
            },
          ])),
        }
      : {}),
  };
}

/** Starts each configured MCP server once, as the agent's harness will, and reports any that does not answer. */
async function probeConfiguredMcpServers(
  store: RunLogStore & ConversationStore,
  args: {
    issueId: string; stageId: string; runId: string; agentId: string; servers: Record<string, McpServerSpec> | undefined;
    sandbox: AgentMcpProbeOptions;
  },
): Promise<void> {
  if (!args.servers || Object.keys(args.servers).length === 0) return;
  const failures = await probeAgentMcpServers(args.servers, args.sandbox);
  reportMcpFailures(store, { ...args, failures });
}

/**
 * The sandbox mode, approvals, shell and config directory a run starts with, as the harness's profile
 * declares them: from the runner's settings or from the agent's access alone.
 */
function runSettings(
  profile: HarnessProfile,
  runner: { sandbox?: HarnessRunInput["sandbox"]; automaticApprovals?: boolean; configDir?: string | undefined },
  agent: { workspaceAccess: string; shell?: boolean; env?: Record<string, string> },
): Pick<HarnessRunInput, "sandbox" | "automaticApprovals" | "shell" | "env"> {
  const fromRunner = profile.sandbox === "runner" && runner.sandbox !== undefined && runner.automaticApprovals !== undefined
    ? { sandbox: runner.sandbox, automaticApprovals: runner.automaticApprovals }
    : null;
  const configDirectory = profile.configDirectoryVariable && runner.configDir
    ? { [profile.configDirectoryVariable]: runner.configDir }
    : null;
  return {
    sandbox: fromRunner
      ? (agent.workspaceAccess === "read-only" ? "read-only" : fromRunner.sandbox)
      : (agent.workspaceAccess === "workspace-write" ? "workspace-write" : "read-only"),
    automaticApprovals: fromRunner ? fromRunner.automaticApprovals : false,
    ...(profile.optionalShell && agent.shell === false ? { shell: false as const } : {}),
    ...(configDirectory ? { env: { ...(agent.env ?? {}), ...configDirectory } } : {}),
  };
}

/**
 * The repository's declared toolchain directories with symbolic links resolved, refused when one
 * would expose the service's own state. Re-checked per run: a link can change after configuration loads.
 */
function toolchainFor(deps: Deps): { toolchainPaths?: string[] } {
  const declared = deps.config.repositories?.[deps.repository.id]?.agentToolchainPaths?.paths ?? [];
  if (declared.length === 0) return {};
  return { toolchainPaths: resolveToolchainPaths(declared, protectedServiceLocations({ ...deps.config, root: deps.config.root })) };
}

function egressFor(deps: Deps, runner: { controlPlaneHosts?: string[] | undefined }) {
  const egress = agentEgressFor(deps.config, deps.repository.id, runner);
  return egress ? { egress } : {};
}
