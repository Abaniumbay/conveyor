// The `agent` task group. `agent.run` runs a configured agent through a harness and captures
// its result; the other tasks are the reporting, question and artifact tools an agent calls
// through its MCP grant (behaviour moved from the legacy `run.*` MCP tools).
//
// Questions park the action. What a re-entry needs is already durable: the run record (and its
// session id) and the question the run opened. A resumed execution therefore reads those back
// instead of keeping extra state: an open question is still pending, an answered one continues
// the session when the harness can resume and otherwise starts a fresh attempt that carries the
// question and answer. Both paths end in the same captured result.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { StoredQuestion } from "../db/store";
import { ReviewFindings } from "../engine/review-findings";
import type { Harness } from "../harness/types";
import { agentEgressFor } from "../isolation/agent-egress";
import type { RunEnvelope } from "../runner/result";
import {
  agentActor, agentMessage, conversationForPrompt, conveyorMessage, failedEnvelope, finishRun,
  producerConversationMessage, prompt, startRun, warnOnTokenUsage } from "./agent-support";
import type { AgentContext } from "./context";
import { defineGroup, fail, InfrastructureError, pass, pending, type TaskArgs, type TaskDefinition, type TaskResult } from "./contract";
import type { TaskDeps } from "./deps";
import { ensureWorkspace } from "../workspace/lifecycle";

type Deps = TaskDeps;

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

const FAILURE_STOPS = ["blocked", "rejected"];

function outcomeOf(deps: Deps, runId: string, agentId: string, result: RunEnvelope): TaskResult {
  const { status, outcome, summary, reason } = result.stageResult;
  const captured: AgentContext = { agentId, status, summary, reason, sessionId: result.sessionId, runId };
  if (status === "needs-input") {
    const question = deps.store.getQuestionForRun(runId);
    if (question?.status === "open") return pending(waiting(question.prompt));
    // Answered while the agent was still finishing: poll again at once and continue from the answer.
    if (question) return pending(waiting(question.prompt), { after: 0 });
    return fail("Agent returned an invalid result: it reported needs-input but opened no question; it must call agent.askQuestion first", { route: { stop: "error" } });
  }
  if (status === "changes-requested") {
    // Requested changes must be recorded as findings, or the exit gate has nothing to hold the stage on.
    if (new ReviewFindings(deps.store.sqlite()).countForRun(runId) === 0) {
      return fail("Reviewer requested changes without recording a finding", { route: { stop: "error" } });
    }
    return pass(captured);
  }
  if (FAILURE_STOPS.includes(status)) return fail(reason ?? summary, { route: { stop: status } });
  if (outcome === "success") return pass(captured);
  return fail(`Agent returned an invalid result: unexpected failure status "${status}" (${reason ?? summary})`, { route: { stop: "error" } });
}

const run: TaskDefinition<RunConfig, unknown, Deps> = {
  name: "agent.run",
  kind: "act",
  description:
    "Runs a configured agent (`agent`, or `agents` in order of preference: the next runs when one's harness cannot) through its harness in the item's workspace (creating or re-attaching it when needed) and captures `{ agentId, status, summary, reason, sessionId, runId }` in `agent`. `needs-input` parks the action until the question is answered, then continues the agent's session when the harness supports resuming and otherwise starts a fresh attempt that carries the question and answer. `blocked` and `rejected` stop with the agent's reason, `changes-requested` passes (the exit gate decides) when the run recorded a finding with `change.comment` and otherwise stops as an error, and an invalid result stops as an error.",
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
        return await runAgent({ context, deps, instance }, agentId, forThisAgent);
      } catch (error) {
        const next = order[index + 1];
        if (!next || !canFallBack(error, deps)) throw error;
        conveyorMessage(deps.store, deps.issueId, instance.stage, null,
          `${agentActor(deps.config, agentId).name} could not run (${errorText(error)}); ${agentActor(deps.config, next).name} takes this ${instance.stage} instead.`);
      }
    }
    throw new Error("agent.run has no agent to run");
  },
};

/** A harness that could not run falls back to the next agent; a shutdown or a cancelled run does not. */
function canFallBack(error: unknown, deps: Deps): boolean {
  if (deps.signal?.aborted) return false;
  return (error as { kind?: unknown } | null)?.kind !== "interrupted";
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

async function runAgent(
  { context, deps, instance }: Pick<TaskArgs<RunConfig, unknown, Deps>, "context" | "deps" | "instance">,
  agentId: string,
  answered: Answered | null,
): Promise<TaskResult> {
  const { store } = deps;
  const issue = store.getIssue(deps.issueId);
  if (!issue) throw new InfrastructureError(`issue ${deps.issueId} is not stored`);
  const agent = deps.config.agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const runner = deps.config.runners[agent.runner];
  if (!runner || (runner.type !== "codex" && runner.type !== "claude-code")) {
    throw new Error(`agent ${agentId} must use a Codex or Claude Code runner`);
  }
  const harness: Harness | undefined = deps.harnesses?.[runner.type];
  if (!harness || !deps.mcp) throw new InfrastructureError(`no harness is available for runner type ${runner.type}`);
  // The agent works in the item's workspace; a stage whose first action is this one gets it created here.
  const workspace = await ensureWorkspace({ store, manager: deps.workspaces, issueId: deps.issueId, repository: deps.repository });

  const stageId = instance.stage;
  const runId = startRun(store, { issueId: issue.id, stageId, kind: KIND, configHash: deps.config.hash });
  store.appendRunEvent(runId, "execution", { idempotencyKey: instance.idempotencyKey, agentId });
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
    });
    let result: RunEnvelope;
    try {
      const resume = answered !== null && harness.capabilities.sessionResume && answered.sessionId !== null;
      const shared = {
        command: runner.command,
        workspace: workspace.path,
        artifactsDirectory: path.join(deps.config.settings.artifacts, runId),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        ...(runner.type === "codex"
          ? {
              sandbox: agent.workspaceAccess === "read-only" ? ("read-only" as const) : runner.sandbox,
              automaticApprovals: runner.automaticApprovals,
              ...egressFor(deps, runner),
            }
          : {
              sandbox: "read-only" as const,
              automaticApprovals: false,
              ...(runner.configDir ? { env: { CLAUDE_CONFIG_DIR: runner.configDir } } : {}),
            }),
        mcp: lease.configuration,
        interruptGraceMs: deps.config.settings.interruptGraceMs,
        ...(deps.signal ? { signal: deps.signal } : {}),
        onEvent: (event: unknown) => { store.appendRunEvent(runId, "harness", event); },
      };
      if (resume) {
        result = await harness.run({
          ...shared,
          prompt: `Your question was answered.\n\nQuestion: ${answered!.question}\nAnswer: ${answered!.answer}\n\nContinue the work and return the required structured result.`,
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
              ...(answered ? { answeredQuestion: { question: answered.question, answer: answered.answer } } : {}),
              conversation: conversationForPrompt(store, issue.id),
            },
            instructions,
            { progressReporting: agent.tasks.includes("agent.reportProgress") },
          ),
        });
      }
    } finally {
      await lease.close();
    }
    finishRun(store, runId, "succeeded", result);
    warnOnTokenUsage(store, deps.config, issue.id, stageId, runId, agentId, result.usage.inputTokens);
    agentMessage(store, deps.config, issue.id, stageId, runId, agentId, producerConversationMessage(stageId, result));
    return outcomeOf(deps, runId, agentId, result);
  } catch (error) {
    finishRun(store, runId, "failed", failedEnvelope(error, Math.max(0, Math.round(performance.now() - started))));
    throw error;
  }
}

// Tools. Each runs under an MCP grant, which supplies `deps.run` (the run and who is calling).

const looseInput = z.looseObject({});
const progressInput = z.looseObject({ message: z.string() });
const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);
const askInput = z.object({
  prompt: z.string(),
  reason: z.string(),
  options: lenient(z.array(z.unknown())),
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
  description: "Ask the user a structured question. The agent's run then ends with `needs-input` and the stage waits for the answer.",
  reads: [], writes: [], invalidates: [],
  input: askInput,
  run({ deps, input }) {
    const run = runOf(deps);
    const question = deps.store.openQuestion({
      issueId: deps.issueId,
      runId: run.id,
      prompt: input!.prompt,
      reason: input!.reason,
      options: input!.options ?? [],
      minSelections: input!.minSelections ?? 1,
      maxSelections: input!.maxSelections ?? 1,
      allowFreeText: input!.allowFreeText === true,
    });
    deps.store.appendRunEvent(run.id, "question", { questionId: question.id });
    return pass({ accepted: true, questionId: question.id });
  },
};

export const agentGroup = defineGroup("agent", [
  run,
  askQuestion,
  reportProgress,
  event("agent.reportRationale", "Record the agent's rationale for the audit trail.", "report_rationale", looseInput),
  event("agent.reportBlocker", "Record a blocker the agent hit.", "report_blocker", looseInput),
  event("agent.reportResult", "Record the agent's result report.", "report_result", looseInput),
  event("agent.reportMilestone", "Record a milestone the agent reached.", "report_milestone", looseInput),
  event("agent.recordArtifact", "Record an artifact (a log, a report, a file) produced during the run.", "record_artifact", looseInput, undefined, true),
]);

function egressFor(deps: TaskDeps, runner: { controlPlaneHosts?: string[] | undefined }) {
  const egress = agentEgressFor(deps.config, deps.repository.id, runner);
  return egress ? { egress } : {};
}
