// Steering and the Operator (#676): a person's steering request, the scheduled Operator check of
// stopped items, the read-only stop-summary run after each stop, and the Operator tools those runs
// use (the redacted board, finding an item, its bounded history, and the scheduled check's answers
// and outcomes). Each run reaches Conveyor only through its system-scoped MCP grant.

import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ConveyorConfig } from "../config/load";
import { STOPPED_ISSUE_STATES } from "../core/issue-state";
import type { ConversationStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import type { Harness, SteeringRunInput, SteeringRunResult } from "../harness/types";
import { log, type LogFields } from "../log/logger";
import { conveyorToolGuidance } from "../mcp/guidance";
import { scheduledQuestionAnswerEvidence } from "../questions";
import type { ItemReader } from "../source/types";
import type { TaskDeps } from "../tasks/deps";
import { criteriaOf } from "../tasks/item";
import { latestStopReason } from "./item-history";
import type { ScheduledRetryCheck } from "./retry";
import type { ScopedMcpLease } from "./runtime";

/** The read-only Operator tools plus the recorder; a stop-summary run is granted exactly these. */
const STOP_SUMMARY_TOOLS = ["operator.getBoard", "operator.findItem", "operator.getItemHistory", "operator.recordStopSummary"] as const;
/** How long a stop-summary run may take by default. */
export const STOP_SUMMARY_TIMEOUT_MS = 10 * 60_000;

type ScheduledOperatorOutcome = {
  outcome: "retried" | "answered" | "unresolved";
  reason: string;
  evidence?: string;
};
type ScheduledOperatorCheck = {
  targets: Set<string>;
  inspected: Set<string>;
  outcomes: Map<string, ScheduledOperatorOutcome>;
};
type ItemReference = { id: string; repositoryId: string; number: number; url: string; title: string };
type CodexRunner = Extract<ConveyorConfig["runners"][string], { type: "codex" }>;

export interface SteeringDeps {
  config: ConveyorConfig;
  store: Pick<ItemStore, "getIssue" | "listIssues" | "listDependencies" | "repositoryPause">
    & Pick<JournalStore, "executions" | "getStageState" | "listStageTransitions" | "currentStopId" | "currentStopSummary" | "clearStopSummary">
    & Pick<RunLogStore, "createRun" | "appendRunEvent" | "finishRun" | "getRun" | "listActiveIssueRuns" | "listIssueRuns" | "listIssueRunsPage" | "listRunEventsPage">
    & Pick<ConversationStore, "getQuestion" | "listConversationMessages">;
  source: Pick<ItemReader, "getIssue">;
  /** Agent harnesses by runner type. */
  harnesses: Record<string, Harness>;
  /** Runs the Operator instead of the steering agent's harness. */
  runSteering: ((input: SteeringRunInput) => Promise<SteeringRunResult>) | undefined;
  /** How long a stop-summary run may take. */
  stopSummaryTimeoutMs: number;
  /** A system-scoped MCP grant for the run, limited to these tools. */
  lease: (runId: string, workspace: string, allowedTools: readonly string[], stopSummary?: { itemId: string; stopId: string }) => Promise<ScopedMcpLease>;
  /** When every repository was last reconciled. */
  lastReconciledAt: () => string | null;
  /** Why a repository's last reconcile failed, by repository. */
  reconcileErrors: () => ReadonlyMap<string, string>;
  /** Why a repository's onboarding failed, by repository. */
  onboardingErrors: () => ReadonlyMap<string, string>;
  shuttingDown: () => boolean;
  /** Whether a drain stops new work from being admitted. */
  draining: () => boolean;
  /** The item's manual gates in its current stage. */
  manualGateViews: (issue: StoredIssue) => ReadonlyArray<{ waiting: boolean }>;
  /** The item's delivery state: its change request and checks. */
  loadDeliveryState: (issueId: string, address: string) => Promise<Record<string, unknown>>;
  /** Retries a stopped item on a person's (or the Operator's) behalf. */
  retry: (itemId: string, note: string, username: string) => Promise<{ status: "started" | "queued"; stageId: string }>;
  /** Retries a scheduled check's target once its evidence holds. */
  scheduledRetry: (runId: string, itemId: string, note: string, evidence: string) => Promise<{ status: "started" | "queued"; stageId: string }>;
  /** Accepts an answer to an agent's question. */
  answerQuestion: (questionId: string, answer: string, source: string, evidence: string) => Promise<void>;
  reorderBacklog: (issueId: string, direction: "up" | "down") => void;
  moveBacklogIssue: (issueId: string, beforeIssueId: string | null) => void;
  itemFields: (issueId: string) => LogFields;
}

/** Steering runs, scheduled Operator checks, stop summaries and the Operator's tools. */
export class Steering {
  readonly #deps: SteeringDeps;
  readonly #active = new Map<string, AbortController>();
  readonly #completions = new Map<string, Promise<void>>();
  /** Running stop-summary runs, by run. */
  readonly #stopSummaryActive = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  /** The stops a summary run was started for, so each stop gets one. */
  readonly #stopSummaryStarted = new Set<string>();
  readonly #scheduledChecks = new Map<string, ScheduledOperatorCheck>();

  constructor(deps: SteeringDeps) {
    this.#deps = deps;
  }

  /** How many steering runs (a person's or a scheduled check) are running. */
  get running(): number {
    return this.#active.size;
  }

  /** Whether any steering or stop-summary run is still running. */
  get busy(): boolean {
    return this.#active.size > 0 || this.#stopSummaryActive.size > 0;
  }

  /** Interrupts every steering run, then every stop-summary run. */
  interruptAll(): void {
    for (const controller of this.#active.values()) controller.abort();
    for (const { controller } of this.#stopSummaryActive.values()) controller.abort();
  }

  /** The scheduled Operator check a run belongs to. */
  scheduledCheck(runId: string): ScheduledRetryCheck | undefined {
    return this.#scheduledChecks.get(runId);
  }

  /** The Operator tools a steering grant's run may use; a scheduled check's are limited to its targets. */
  operatorTools(runId: string, stopSummary: { itemId: string; stopId: string } | undefined): NonNullable<TaskDeps["operator"]> {
    const scheduled = this.#scheduledChecks.has(runId);
    return {
      scheduled,
      ...(stopSummary ? { stopSummary } : {}),
      board: () => this.#board(),
      findItem: (reference) => this.#findItem(reference),
      itemHistory: async (input) => {
        const matches = this.#itemsForReference(input.itemId);
        if (matches.length === 0) {
          if (scheduled) throw new Error("scheduled checks may inspect history only for their stopped targets");
          throw new Error("item is not on this configured board");
        }
        if (matches.length > 1) throw new Error("item reference matches multiple configured board items; use a repository-qualified reference");
        const issue = matches[0]!;
        if (scheduled && !this.#scheduledChecks.get(runId)?.targets.has(issue.id)) {
          throw new Error("scheduled checks may inspect history only for their stopped targets");
        }
        const history = await this.#itemHistory({ ...input, itemId: issue.id });
        if (scheduled) this.#scheduledChecks.get(runId)?.inspected.add(issue.id);
        return history;
      },
      retry: (itemId, note) => this.#deps.retry(itemId, note, "AI Operator"),
      scheduledRetry: (itemId, note, evidence) => this.#deps.scheduledRetry(runId, itemId, note, evidence),
      answerQuestion: (questionId, answer, evidence) => this.#scheduledAnswerQuestion(runId, questionId, answer, evidence),
      scheduledOutcome: (itemId, reason) => this.#reportScheduledOutcome(runId, itemId, reason),
      moveBacklog: (input) => this.#moveBacklog(input),
    };
  }

  /**
   * Starts one cadence-triggered Operator run when the reconciled board contains stopped enrolled
   * work. This deliberately does not queue missed intervals: a live steering run is the lock.
   */
  async runScheduledCheck(): Promise<string | null> {
    const { config, store } = this.#deps;
    const steering = config.web?.steering;
    if (!steering?.periodic || !this.#deps.lastReconciledAt() || this.#deps.reconcileErrors().size > 0 ||
      this.#deps.shuttingDown() || this.#deps.draining() || this.#active.size > 0) return null;
    const targets = store.listIssues().filter((issue) =>
      Boolean(config.repositories[issue.repositoryId]) &&
      store.repositoryPause(issue.repositoryId) === null &&
      issue.labels.includes(config.labels.enrollment) &&
      issue.projectedState !== "unlisted" &&
      issue.projectedState !== null && STOPPED_ISSUE_STATES.has(issue.projectedState),
    );
    if (targets.length === 0) return null;
    const agent = config.agents[steering.agent];
    if (!agent) throw new Error(`Unknown steering agent: ${steering.agent}`);
    const runner = config.runners[agent.runner];
    if (!runner || runner.type !== "codex") throw new Error("The steering agent must use a Codex runner");
    const allowed = agent.tasks.filter((task) => new Set([
      "operator.getBoard", "operator.getItemHistory", "operator.retryStoppedItem", "operator.answerItemQuestion",
      "operator.reportStoppedItemOutcome",
    ]).has(task));
    if (!allowed.includes("operator.getBoard") || !allowed.includes("operator.getItemHistory")) {
      throw new Error("The scheduled Operator requires operator.getBoard and operator.getItemHistory grants");
    }

    const runId = randomUUID();
    store.createRun({
      id: runId, issueId: null, stageId: "steering", attempt: 1, kind: "steering", status: "running",
      configHash: config.hash, startedAt: new Date().toISOString(),
    });
    store.appendRunEvent(runId, "operator.scheduled", { itemIds: targets.map((issue) => issue.id), cadenceMs: steering.periodic.intervalMs });
    this.#scheduledChecks.set(runId, {
      targets: new Set(targets.map((issue) => issue.id)),
      inspected: new Set(),
      outcomes: new Map(),
    });
    const controller = new AbortController();
    this.#active.set(runId, controller);
    const prompt = [
      "This is a scheduled Operator check, not an owner request.",
      `Consider only these stopped items: ${targets.map((issue) => issue.id).join(", ")}.`,
      "Inspect the board and each target's history before acting. Record a concise outcome for every target.",
      "You may retry only a target after quoting source content added after its recorded stop, or non-Operator conversation recorded after that stop.",
      "You may answer only an open target question when its answer is unambiguous and you quote the current issue, acceptance criteria, or recorded conversation evidence.",
      "For every inspected target you cannot safely retry or answer, use the outcome-reporting tool to record why it remains stopped. Do not move backlog items, inspect or act on unrelated items, or make up owner preferences.",
    ].join("\n");
    const completion = this.#execute(runId, prompt, { ...agent, tasks: allowed }, runner, steering.workspace, controller.signal, true)
      .finally(() => {
        const check = this.#scheduledChecks.get(runId);
        const run = store.getRun(runId);
        for (const issue of targets) {
          const outcome = check?.outcomes.get(issue.id);
          store.appendRunEvent(runId, "operator.outcome", {
            issueId: issue.id,
            outcome: outcome?.outcome ?? "unresolved",
            reason: outcome?.reason ??
              (check?.inspected.has(issue.id)
                ? `Scheduled check ${run?.status ?? "ended"} before recording a disposition.`
                : `Scheduled check ${run?.status ?? "ended"} before inspecting this target.`),
            runStatus: run?.status ?? "unknown",
            ...(outcome?.evidence ? { evidence: outcome.evidence } : {}),
          });
        }
        this.#scheduledChecks.delete(runId);
        this.#active.delete(runId);
        this.#completions.delete(runId);
      });
    this.#completions.set(runId, completion);
    void completion;
    return runId;
  }

  /** Starts a person's steering request; a running scheduled check gives way to it. */
  async start(prompt: string): Promise<string> {
    const { config, store } = this.#deps;
    const request = prompt.trim();
    if (!request || request.length > 12_000) {
      throw new Error("The steering prompt must contain between 1 and 12000 characters");
    }
    if (this.#deps.draining()) throw new Error("Conveyor is draining: no new work is admitted");
    const steering = config.web?.steering;
    if (!steering) throw new Error("The steering agent is not configured");
    // A human request wins over a cadence check. Abort and wait for its lease to close so their
    // grants cannot overlap; another owner request still receives the existing busy response.
    const scheduled = [...this.#active]
      .filter(([runId]) => this.#scheduledChecks.has(runId));
    for (const [, controller] of scheduled) controller.abort();
    await Promise.all(scheduled.map(([runId]) => this.#completions.get(runId)));
    if (this.#active.size > 0) {
      throw new Error("A steering agent is already running");
    }
    const agent = config.agents[steering.agent];
    if (!agent) throw new Error(`Unknown steering agent: ${steering.agent}`);
    const runner = config.runners[agent.runner];
    if (!runner || runner.type !== "codex") {
      throw new Error("The steering agent must use a Codex runner");
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    store.createRun({
      id: runId,
      issueId: null,
      stageId: "steering",
      attempt: 1,
      kind: "steering",
      status: "running",
      configHash: config.hash,
      startedAt,
    });
    store.appendRunEvent(runId, "user", { text: request });
    const controller = new AbortController();
    this.#active.set(runId, controller);
    const completion = this.#execute(runId, request, agent, runner, steering.workspace, controller.signal)
      .finally(() => {
        this.#active.delete(runId);
        this.#completions.delete(runId);
      });
    this.#completions.set(runId, completion);
    void completion;
    return runId;
  }

  /** Wait for a currently running steering request to settle. */
  async waitFor(runId: string): Promise<void> {
    await this.#completions.get(runId);
  }

  /**
   * Starts the one read-only Operator run that summarises an item's stop. Nothing starts without a
   * configured steering agent. The run never changes the item and never retries or answers anything;
   * a run that cannot produce a summary leaves an `operator.stopSummaryFailed` event with its reason.
   */
  startStopSummary(issueId: string, stopId: string): void {
    const steering = this.#deps.config.web?.steering;
    if (!steering || this.#deps.shuttingDown() || this.#stopSummaryStarted.has(stopId)) return;
    this.#stopSummaryStarted.add(stopId);
    const runId = randomUUID();
    const controller = new AbortController();
    const completion = this.#executeStopSummary(runId, issueId, stopId, steering.agent, controller)
      .catch((error) => log.warn("Stop-summary run failed", { ...this.#deps.itemFields(issueId) }, error))
      .finally(() => { this.#stopSummaryActive.delete(runId); });
    this.#stopSummaryActive.set(runId, { controller, completion });
  }

  /** Wait for every running stop-summary run to settle. */
  async waitForStopSummaries(): Promise<void> {
    while (this.#stopSummaryActive.size > 0) {
      await Promise.all([...this.#stopSummaryActive.values()].map((active) => active.completion));
    }
  }

  async #executeStopSummary(runId: string, issueId: string, stopId: string, agentId: string, controller: AbortController): Promise<void> {
    const { config, store } = this.#deps;
    const timeoutMs = this.#deps.stopSummaryTimeoutMs;
    const started = performance.now();
    store.createRun({
      id: runId, issueId: null, stageId: "steering", attempt: 1, kind: "steering", status: "running",
      configHash: config.hash, startedAt: new Date().toISOString(),
    });
    store.appendRunEvent(runId, "operator.stopSummary", { issueId, stopId });
    let failure: { kind: "failed" | "timeout"; reason: string } | null = null;
    let lease: ScopedMcpLease | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let sessionId: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    try {
      const agent = config.agents[agentId];
      if (!agent) throw new Error(`Unknown steering agent: ${agentId}`);
      const runner = config.runners[agent.runner];
      if (!runner || runner.type === "json-process") {
        throw new Error(`The steering agent ${agentId} must use a Codex or Claude Code runner`);
      }
      const harness = this.#deps.harnesses[runner.type];
      if (!harness) throw new Error(`No harness is available for runner type ${runner.type}`);
      const instructions = await readFile(agent.instructions, "utf8");
      const scratch = path.join(config.settings.artifacts, runId, "scratch");
      await mkdir(scratch, { recursive: true });
      lease = await this.#deps.lease(runId, scratch, STOP_SUMMARY_TOOLS, { itemId: issueId, stopId });
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const result = await harness.run({
        command: runner.command,
        // Always the run's own empty scratch directory: the same filesystem a confined Operator gets.
        workspace: scratch,
        artifactsDirectory: path.join(config.settings.artifacts, runId),
        prompt: [
          instructions.trim(),
          conveyorToolGuidance([...STOP_SUMMARY_TOOLS]),
          "",
          "You are the Conveyor Operator writing a stop summary. This is a read-only run: you cannot retry, answer, reorder or change anything.",
          `Read the history of item ${issueId} with operator.getItemHistory, then record the summary of stop ${stopId} with operator.recordStopSummary (itemId ${issueId}, stopId ${stopId}).`,
          "The summary is one or two short plain sentences naming the exact failing test, command, check or step and, when clear, what unblocks it. No log excerpts, stack traces, links or speculation.",
          "Finish with a one-line result.",
        ].join("\n"),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: "read-only",
        automaticApprovals: harness.profile.sandbox === "runner" && "automaticApprovals" in runner ? runner.automaticApprovals : false,
        ...(harness.profile.optionalShell ? { shell: false as const } : {}),
        mcp: lease.configuration,
        timeoutMs,
        interruptGraceMs: config.settings.interruptGraceMs,
        signal: controller.signal,
        onEvent: (event: unknown) => { store.appendRunEvent(runId, "harness", event); },
      });
      sessionId = result.sessionId;
      usage = result.usage;
      if (result.stageResult.outcome === "failure") {
        failure = { kind: "failed", reason: result.stageResult.reason ?? result.stageResult.summary };
      } else if (store.currentStopId(issueId) === stopId && store.currentStopSummary(issueId) === null) {
        failure = { kind: "failed", reason: "The run finished without recording a summary for the stop." };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failure = timedOut || /timed out/i.test(message)
        ? { kind: "timeout", reason: `The stop-summary run timed out after ${timeoutMs}ms.` }
        : { kind: "failed", reason: message };
    } finally {
      if (timer) clearTimeout(timer);
      try { await lease?.close(); } catch { /* a teardown failure must not replace the run's own outcome */ }
    }
    if (failure) {
      // The recording tool may have stored a summary before the run failed; a failed run leaves none.
      try { store.clearStopSummary({ issueId, stopId }); } catch (error) { log.warn("Could not clear the stop summary of a failed run", { ...this.#deps.itemFields(issueId) }, error); }
      store.appendRunEvent(runId, "operator.stopSummaryFailed", { issueId, stopId, kind: failure.kind, reason: failure.reason });
    }
    store.finishRun(runId, {
      status: failure ? "failed" : "succeeded",
      exitCode: failure ? 1 : 0,
      result: failure ? { reason: failure.reason } : { summary: "Stop summary recorded." },
      sessionId,
      usage: { ...usage, amount: 0, currency: "USD", source: "unavailable", durationMs: Math.max(0, Math.round(performance.now() - started)) },
    });
  }

  /** The steering agent's harness, unless the service was given its own Operator runner. */
  #runner(runnerType: string): (input: SteeringRunInput) => Promise<SteeringRunResult> {
    if (this.#deps.runSteering) return this.#deps.runSteering;
    const harness = this.#deps.harnesses[runnerType];
    if (!harness?.steer) throw new Error(`No harness can run the steering agent for runner type ${runnerType}`);
    return harness.steer.bind(harness);
  }

  async #execute(
    runId: string,
    userPrompt: string,
    agent: ConveyorConfig["agents"][string],
    runner: CodexRunner,
    workspace: string,
    signal: AbortSignal,
    scheduled = false,
  ): Promise<void> {
    const { config, store } = this.#deps;
    const started = performance.now();
    let lease: ScopedMcpLease | null = null;
    try {
      const steer = this.#runner(runner.type);
      lease = await this.#deps.lease(runId, workspace, agent.tasks);
      const instructions = await readFile(agent.instructions, "utf8");
      const result = await steer({
        command: runner.command,
        workspace,
        artifactsDirectory: path.join(config.settings.artifacts, runId),
        prompt: [
          instructions.trim(),
          conveyorToolGuidance(agent.tasks),
          "",
          scheduled ? "You are the scheduled Conveyor Operator. Work only within the scheduled check." : "You are the authenticated Conveyor steering agent. Work only within the user's request.",
          "Inspect current state before changing it. Never close source issues. Finish with a concise report of actions, verification, and anything still unresolved.",
          "Use agent.reportProgress only for concise user-facing updates. Never expose private reasoning, raw command output, command names, or tool-call mechanics in those updates.",
          "",
          "User request:",
          userPrompt,
        ].join("\n"),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.effort ? { effort: agent.effort } : {}),
        sandbox: agent.workspaceAccess === "workspace-write" ? runner.sandbox : "read-only",
        ...(agent.workspaceAccess === "confined" ? { filesystem: "scratch" as const } : {}),
        automaticApprovals: runner.automaticApprovals,
        mcp: lease.configuration,
        interruptGraceMs: config.settings.interruptGraceMs,
        signal,
      });
      store.appendRunEvent(runId, "report", { text: result.summary });
      store.finishRun(runId, {
        status: "succeeded",
        exitCode: result.exitCode,
        result: { summary: result.summary },
        sessionId: result.sessionId,
        usage: {
          ...result.usage,
          amount: 0,
          currency: "USD",
          source: "unavailable",
          durationMs: result.durationMs,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.appendRunEvent(runId, "error", { text: message });
      store.finishRun(runId, {
        status: signal.aborted ? "interrupted" : "failed",
        exitCode: 1,
        result: { reason: message },
        sessionId: null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          amount: 0,
          currency: "USD",
          source: "unavailable",
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        },
      });
    } finally {
      await lease?.close();
    }
  }

  async #scheduledAnswerQuestion(runId: string, questionId: string, answer: string, evidence: string): Promise<void> {
    const { config, store } = this.#deps;
    const question = store.getQuestion(questionId);
    if (!question) throw new Error("question not found");
    const check = this.#scheduledChecks.get(runId);
    if (!check?.targets.has(question.issueId)) throw new Error("scheduled checks may answer only questions for their stopped targets");
    if (!check.inspected.has(question.issueId)) throw new Error("inspect the item's history before answering it");
    const issue = store.getIssue(question.issueId);
    const repository = issue && config.repositories[issue.repositoryId];
    if (!issue || !repository || issue.projectedState === "unlisted") throw new Error("question belongs to an ineligible board item");
    let evidenceText: string | undefined;
    try {
      const live = await this.#deps.source.getIssue(repository.address, issue.sourceNumber);
      evidenceText = evidence.trim();
      if (!evidenceText) throw new Error("scheduled answer evidence must not be blank");
      const sources = [live.title, live.body, ...criteriaOf(live.body).map((criterion) => criterion.text), ...store.listConversationMessages(issue.id).map((message) => message.message)];
      if (!sources.some((text) => text.includes(evidenceText!))) {
        throw new Error("scheduled answers require an unambiguous quote from current issue content, acceptance criteria, or recorded conversation");
      }
      const response = scheduledQuestionAnswerEvidence(question, answer, evidenceText, sources);
      await this.#deps.answerQuestion(questionId, response, `scheduled-operator:${runId}`, evidenceText);
      store.appendRunEvent(runId, "operator.answer", { questionId, issueId: issue.id, evidence: evidenceText });
      check.outcomes.set(issue.id, {
        outcome: "answered",
        reason: `Answered question ${questionId} from recorded evidence.`,
        evidence: evidenceText,
      });
    } catch (error) {
      check.outcomes.set(issue.id, {
        outcome: "unresolved",
        reason: error instanceof Error ? error.message : String(error),
        ...(evidenceText ? { evidence: evidenceText } : {}),
      });
      throw error;
    }
  }

  #reportScheduledOutcome(runId: string, issueId: string, reason: string): void {
    const check = this.#scheduledChecks.get(runId);
    if (!check?.targets.has(issueId)) throw new Error("scheduled checks may report only their stopped targets");
    if (!check.inspected.has(issueId)) throw new Error("inspect the item's history before reporting its outcome");
    if (check.outcomes.has(issueId)) throw new Error("scheduled outcome is already recorded for this target");
    const message = reason.trim();
    if (!message) throw new Error("scheduled outcome reason must not be blank");
    check.outcomes.set(issueId, { outcome: "unresolved", reason: message });
  }

  /** A redacted board view for the scoped Operator MCP tools; it intentionally has no credentials or raw config. */
  #board(): unknown {
    const { config, store } = this.#deps;
    const activeIssueIds = new Set(store.listActiveIssueRuns().map((run) => run.issueId));
    const items = this.#visibleItems().map((issue) => {
      const cursor = store.executions().getCursor(issue.id);
      const manualGates = this.#deps.manualGateViews(issue);
      const manualWaiting = manualGates.find((gate) => gate.waiting) ?? null;
      const active = activeIssueIds.has(issue.id);
      const stopped = STOPPED_ISSUE_STATES.has(issue.projectedState ?? "");
      const parent = issue.parentId ? store.getIssue(issue.parentId) : null;
      return {
        ...this.#reference(issue),
        stage: store.getStageState(issue.id)?.stageId ?? issue.projectedStage,
        state: issue.projectedState ?? issue.sourceState,
        activity: active ? "active" : cursor?.state === "pending" ? "waiting" : "idle",
        queue: issue.queueRank === null ? { status: "not-queued" } : { status: "queued", rank: issue.queueRank },
        waitingOrStopReason: cursor?.state === "pending"
          ? store.executions().pendingMessage(issue.id) ?? issue.warning
          : stopped ? latestStopReason(store, issue.id) ?? issue.warning : null,
        parent: this.#visible(parent) ? this.#reference(parent) : null,
        dependencies: store.listDependencies(issue.id)
          .map((id) => store.getIssue(id))
          .filter((dependency): dependency is StoredIssue => this.#visible(dependency))
          .map((dependency) => this.#reference(dependency)),
      };
    });
    const lastReconciledAt = this.#deps.lastReconciledAt();
    return {
      reconciledAt: lastReconciledAt,
      repositories: Object.entries(config.repositories).map(([id, repository]) => ({
        id,
        address: repository.address,
        health: this.#deps.reconcileErrors().has(id) || this.#deps.onboardingErrors().has(id) ? "degraded" : "healthy",
        lastReconciledAt,
      })),
      items,
    };
  }

  #visible(issue: StoredIssue | null): issue is StoredIssue {
    return Boolean(issue && this.#deps.config.repositories[issue.repositoryId] && issue.projectedState !== "unlisted");
  }

  #visibleItems(): StoredIssue[] {
    return this.#deps.store.listIssues().filter((issue) => this.#visible(issue));
  }

  #reference(issue: StoredIssue): ItemReference {
    return {
      id: issue.id,
      repositoryId: issue.repositoryId,
      number: issue.sourceNumber,
      url: issue.sourceUrl,
      title: issue.title,
    };
  }

  /** Resolves the forms people use without consulting a source outside the configured board. */
  #itemsForReference(input: string): StoredIssue[] {
    const { repositories } = this.#deps.config;
    const reference = input.trim().toLowerCase();
    const visible = this.#visibleItems();
    const direct = visible.filter((issue) => issue.id.toLowerCase() === reference);
    if (direct.length > 0) return direct;
    const bare = /^#?(\d+)$/.exec(reference);
    if (bare) return visible.filter((issue) => issue.sourceNumber === Number(bare[1]));
    const qualified = /^(.+?)(?:#\s*|:\s*|\s+)(\d+)$/.exec(reference);
    if (!qualified) {
      const matching = Object.entries(repositories).flatMap(([id, repository]) =>
        [id, repository.address, repository.address.split("/").at(-1)!]
          .map((alias) => alias.toLowerCase())
          .filter((alias) => reference.startsWith(alias) && /^\d+$/.test(reference.slice(alias.length)))
          .map((alias) => ({ id, number: Number(reference.slice(alias.length)) })),
      );
      return visible.filter((issue) => matching.some((candidate) =>
        issue.repositoryId === candidate.id && issue.sourceNumber === candidate.number,
      ));
    }
    const [, repositoryReference, number] = qualified;
    if (!repositoryReference || !number) return [];
    const matched = Object.entries(repositories)
      .filter(([id, repository]) => {
        const address = repository.address.toLowerCase();
        return [id.toLowerCase(), address, address.split("/").at(-1)!].includes(repositoryReference.trim());
      })
      .map(([id]) => id);
    return visible.filter((issue) => matched.includes(issue.repositoryId) && issue.sourceNumber === Number(number));
  }

  #findItem(reference: string): unknown {
    const items = this.#itemsForReference(reference).map((issue) => this.#reference(issue));
    return items.length > 0
      ? { reference, status: "found", items }
      : { reference, status: "not-on-board", message: "This reference is not on this configured board.", items: [] };
  }

  /** History is deliberately bounded by transition, run, and event limits and rejects non-board references uniformly. */
  async #itemHistory(input: {
    itemId: string;
    beforeRunId?: string;
    eventRunId?: string;
    beforeEventSequence?: number;
    runLimit: number;
    eventLimit: number;
  }): Promise<unknown> {
    const { config, store } = this.#deps;
    const issue = store.getIssue(input.itemId);
    if (!this.#visible(issue)) {
      throw new Error("item is not on this configured board");
    }
    const runs = store.listIssueRunsPage(issue.id, {
      ...(input.beforeRunId ? { before: input.beforeRunId } : {}),
      limit: input.runLimit,
    });
    const eventRun = input.eventRunId ? store.getRun(input.eventRunId) : null;
    if (input.eventRunId && (!eventRun || eventRun.issueId !== issue.id)) {
      throw new Error("event cursor does not belong to this board item");
    }
    let delivery: unknown;
    try {
      const repository = config.repositories[issue.repositoryId]!;
      delivery = { status: "available", ...await this.#deps.loadDeliveryState(issue.id, repository.address) };
    } catch (error) {
      delivery = {
        status: "unavailable",
        reason: error instanceof Error ? error.message : "delivery diagnostics are unavailable",
      };
    }
    return {
      item: { id: issue.id, repositoryId: issue.repositoryId, number: issue.sourceNumber, url: issue.sourceUrl, title: issue.title },
      transitions: store.listStageTransitions(issue.id).slice(-50).map((transition) => ({
        id: transition.id,
        fromStage: transition.fromStage,
        toStage: transition.toStage,
        kind: transition.kind,
        status: transition.status,
        resultStatus: transition.resultStatus,
        reason: transition.error ?? transition.reason,
        createdAt: transition.createdAt,
        completedAt: transition.completedAt,
      })),
      runs: runs.runs.map((run) => {
        const page = store.listRunEventsPage(run.id, {
          limit: input.eventLimit,
          ...(run.id === input.eventRunId && input.beforeEventSequence !== undefined
            ? { before: input.beforeEventSequence }
            : {}),
        });
        return {
          id: run.id,
          stageId: run.stageId,
          attempt: run.attempt,
          kind: run.kind,
          status: run.status,
          result: run.result,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          events: page.events,
          nextEventBefore: page.nextBefore,
        };
      }),
      nextRunBefore: runs.nextBefore,
      delivery,
    };
  }

  #moveBacklog(input: { itemId: string; position: "up" | "down" | "before" | "end"; beforeItemId?: string }): unknown {
    if (input.position === "up" || input.position === "down") {
      this.#deps.reorderBacklog(input.itemId, input.position);
    } else {
      this.#deps.moveBacklogIssue(input.itemId, input.position === "before" ? input.beforeItemId! : null);
    }
    const issue = this.#deps.store.getIssue(input.itemId);
    return {
      position: input.position,
      queueRank: issue?.queueRank ?? null,
      ...(input.position === "before" ? { beforeIssueId: input.beforeItemId } : {}),
    };
  }
}
