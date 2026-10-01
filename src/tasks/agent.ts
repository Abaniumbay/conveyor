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
import type { RunEnvelope } from "../runner/result";
import {
  agentActor, agentMessage, conversationForPrompt, failedEnvelope, finishRun,
  producerConversationMessage, prompt, startRun,
} from "./agent-support";
import type { AgentContext } from "./context";
import { defineGroup, fail, InfrastructureError, pass, pending, type TaskArgs, type TaskDefinition, type TaskResult } from "./contract";
import type { TaskDeps } from "./deps";

type Deps = TaskDeps;

const KIND = "producer";
const runConfig = z.object({ agent: z.string().min(1, "agent must name a configured agent") }).strict();
type RunConfig = z.output<typeof runConfig>;

const waiting = (question: string) => `Waiting for an answer: ${question}`;

function answerText(question: StoredQuestion): string {
  const answer = question.answer;
  if (answer && typeof answer === "object" && typeof (answer as { answer?: unknown }).answer === "string") {
    return (answer as { answer: string }).answer;
  }
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

interface Answered { question: string; answer: string; sessionId: string | null }

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
    return { answered: { question: question.prompt, answer: answerText(question), sessionId: prior.sessionId } };
  }
  return null;
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
    "Runs a configured agent through its harness in the item's workspace and captures `{ agentId, status, summary, reason, sessionId, runId }` in `agent`. `needs-input` parks the action until the question is answered, then continues the agent's session when the harness supports resuming and otherwise starts a fresh attempt that carries the question and answer. `blocked` and `rejected` stop with the agent's reason, `changes-requested` passes (the exit gate decides) when the run recorded a finding with `change.comment` and otherwise stops as an error, and an invalid result stops as an error.",
  reads: ["run"],
  writes: ["agent"],
  invalidates: [],
  config: runConfig,
  defaultWait: { timeoutMs: null, pollMs: 60_000 },
  async run({ context, config, deps, instance }: TaskArgs<RunConfig, unknown, Deps>) {
    const { store } = deps;
    let answered: Answered | null = null;
    if (instance.resumed) {
      const prior = priorQuestion(deps, instance.stage, instance.idempotencyKey);
      if (prior && "open" in prior) return pending(waiting(prior.open.prompt));
      answered = prior?.answered ?? null;
    }

    const issue = store.getIssue(deps.issueId);
    if (!issue) throw new InfrastructureError(`issue ${deps.issueId} is not stored`);
    const agent = deps.config.agents[config.agent];
    if (!agent) throw new Error(`unknown agent: ${config.agent}`);
    const runner = deps.config.runners[agent.runner];
    if (!runner || runner.type !== "codex") throw new Error(`agent ${config.agent} must use a Codex runner in v0.1`);
    const harness: Harness | undefined = deps.harnesses?.[runner.type];
    if (!harness || !deps.mcp) throw new InfrastructureError(`no harness is available for runner type ${runner.type}`);
    const workspace = store.getActiveWorkspace(deps.issueId);
    if (!workspace) throw new Error(`agent stage ${instance.stage} requires a workspace`);

    const stageId = instance.stage;
    const runId = startRun(store, { issueId: issue.id, stageId, kind: KIND, configHash: deps.config.hash });
    store.appendRunEvent(runId, "execution", { idempotencyKey: instance.idempotencyKey });
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
        actor: agentActor(deps.config, config.agent),
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
          sandbox: agent.workspaceAccess === "read-only" ? ("read-only" as const) : runner.sandbox,
          automaticApprovals: runner.automaticApprovals,
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
      agentMessage(store, deps.config, issue.id, stageId, runId, config.agent, producerConversationMessage(stageId, result));
      return outcomeOf(deps, runId, config.agent, result);
    } catch (error) {
      finishRun(store, runId, "failed", failedEnvelope(error, Math.max(0, Math.round(performance.now() - started))));
      throw error;
    }
  },
};

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
