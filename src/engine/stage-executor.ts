// Runs one compiled stage for one item as a durable task chain (D2, D4, D5): implicit
// loads, journaled acts that reconcile on resume, pending with persisted deadlines,
// exit-gate routing, the maxReturns guard, checkpoints and epoch fencing.
//
// Durable state: the cursor (where we are), the execution journal (what each task did,
// including its result so a completed act is replayed rather than re-run), and the
// context (engine-owned `engine.stale` and `engine.returns`). `engine.returns` counts
// `return` routes; the next stage to start seeds its cursor from it, and it resets when
// the item leaves the pipeline (a reset on every normal advance would let an
// implementation -> review -> implementation loop defeat the guard).

import type { StageExecutionResult } from "../core/pipeline";
import type { CompiledPipeline, CompiledStage, CompiledTask } from "../tasks/plan";
import type { Feedback, TaskContext } from "../tasks/context";
import { runTask, type Route, type TaskRegistry, type TaskResult } from "../tasks/contract";
import { StaleEpochError, type ExecutionStore, type StageCursor } from "./journal";
import {
  captureOutput, engineState, formatDuration, keysToLoad, markLoaded, markStale, recordCheckpoint,
  snapshotReads, validAfter,
} from "./stage-context";
import { resolveRoute } from "./stage-routing";

export type StageOutcome =
  | StageExecutionResult
  | { kind: "parked"; stageId: string; reason: "pending" | "superseded" | "aborted"; wakeAt: string | null };

export interface StageExecutorOptions {
  registry: TaskRegistry;
  journal: ExecutionStore;
  clock: () => Date;
  /** Posts a conversation message. */
  notify: (message: string) => void | Promise<void>;
  /** Sets (or clears with null) the board status line. */
  setStatus: (message: string | null) => void | Promise<void>;
  settings: { maxReturns: number };
}

export interface ExecuteInput {
  issueId: string;
  pipeline: CompiledPipeline;
  stageId: string;
  baseContext: TaskContext;
  deps: unknown;
  signal?: AbortSignal;
}

type List = "actions" | "exit-gate";
type Step =
  | { kind: "pass" }
  | { kind: "aborted" }
  | { kind: "pending"; wakeAt: string }
  | { kind: "fail"; message: string; details?: unknown; route?: Route | undefined };

interface Run {
  input: ExecuteInput;
  stage: CompiledStage;
  epoch: number;
  enteredAt: string;
  context: TaskContext;
  cursor: StageCursor;
}

export class StageExecutor {
  readonly #o: StageExecutorOptions;

  constructor(options: StageExecutorOptions) {
    this.#o = options;
  }

  async execute(input: ExecuteInput): Promise<StageOutcome> {
    const epoch = this.#o.journal.stageEpoch(input.issueId);
    try {
      return await this.#drive(input, epoch);
    } catch (error) {
      if (error instanceof StaleEpochError) return { kind: "parked", stageId: input.stageId, reason: "superseded", wakeAt: null };
      throw error;
    }
  }

  async #drive(input: ExecuteInput, epoch: number): Promise<StageOutcome> {
    const { journal, clock } = this.#o;
    const stage = input.pipeline.stages.find((candidate) => candidate.id === input.stageId);
    if (!stage) throw new Error(`Unknown stage ${input.stageId}`);
    const stored = journal.getContext(input.issueId);
    const context: TaskContext = stored
      ? { ...stored.context, repository: input.baseContext.repository }
      : structuredClone(input.baseContext);
    const existing = journal.getCursor(input.issueId);
    const resuming = existing !== null && existing.stage === stage.id && existing.stageEpoch === epoch;
    const cursor: StageCursor = resuming
      ? existing
      : {
          issueId: input.issueId, stage: stage.id, stageEpoch: epoch, attempt: 1,
          returns: engineState(context).returns, list: "actions", taskInstanceId: null, state: "planned",
          feedback: null, pendingSince: null, wakeAt: null, deadlineAt: null,
        };
    const sameRun = context.run?.stage === stage.id && context.run.stageEpoch === epoch;
    const run: Run = {
      input, stage, epoch, context, cursor,
      enteredAt: resuming && sameRun ? context.run.enteredAt : clock().toISOString(),
    };

    for (;;) {
      const outcome = run.cursor.list === "actions" ? await this.#actions(run) : await this.#gate(run);
      if (outcome) return outcome;
    }
  }

  /** Runs the remaining actions; returns an outcome to end execution, or null to continue (gate or retry). */
  async #actions(run: Run): Promise<StageOutcome | null> {
    const tasks = run.stage.actions;
    const start = run.cursor.taskInstanceId === null ? 0 : tasks.findIndex((t) => t.id === run.cursor.taskInstanceId);
    if (start < 0) throw new Error(`Cursor task ${run.cursor.taskInstanceId} is not in ${run.stage.id} actions`);
    for (const task of tasks.slice(start)) {
      const step = await this.#runTask(run, task, "actions");
      if (step.kind === "aborted") return { kind: "parked", stageId: run.stage.id, reason: "aborted", wakeAt: null };
      if (step.kind === "pending") return { kind: "parked", stageId: run.stage.id, reason: "pending", wakeAt: step.wakeAt };
      if (step.kind === "fail") return this.#route(run, task, "actions", step);
    }
    await this.#moveTo(run, { list: "exit-gate", taskInstanceId: null });
    return null;
  }

  async #gate(run: Run): Promise<StageOutcome | null> {
    const { journal } = this.#o;
    const tasks = run.stage.exitGate;
    // Entering (or re-entering after a park) the gate: nothing it reads is trusted.
    markStale(run.context, tasks.flatMap((task) => snapshotReads(task.reads)));
    this.#persist(run, tasks[0]?.id ?? run.stage.id);
    for (const task of tasks) {
      const step = await this.#runTask(run, task, "exit-gate");
      if (step.kind === "aborted") return { kind: "parked", stageId: run.stage.id, reason: "aborted", wakeAt: null };
      if (step.kind === "pending") return { kind: "parked", stageId: run.stage.id, reason: "pending", wakeAt: step.wakeAt };
      if (step.kind === "fail") return this.#route(run, task, "exit-gate", step);
    }
    const at = this.#o.clock().toISOString();
    for (const task of tasks) {
      const definition = this.#o.registry.require(task.task);
      if (definition.checkpoint?.scope === "gate") recordCheckpoint(run.context, definition, task.id, at);
    }
    const next = run.input.pipeline.stages[run.input.pipeline.stages.findIndex((s) => s.id === run.stage.id) + 1];
    if (!next) engineState(run.context).returns = 0;
    this.#persist(run, tasks.at(-1)?.id ?? run.stage.id);
    journal.clearCursor(run.input.issueId, run.epoch);
    await this.#o.setStatus(null);
    return {
      kind: "advance", stageId: run.stage.id, nextStageId: next?.id ?? null, result: null,
      feedbackCycles: run.cursor.attempt - 1,
    };
  }

  async #runTask(run: Run, task: CompiledTask, list: List): Promise<Step> {
    if (run.input.signal?.aborted) return { kind: "aborted" };
    const { journal, registry, clock } = this.#o;
    const { issueId, deps } = run.input;
    const definition = registry.require(task.task);
    await this.#moveTo(run, { list, taskInstanceId: task.id });
    this.#setRun(run, task.id);
    await this.#loadSnapshots(run, task);

    const planned = journal.planExecution({
      itemId: issueId, stage: run.stage.id, stageEpoch: run.epoch, attempt: run.cursor.attempt,
      list, taskInstanceId: task.id,
    });
    const { record } = planned;
    let result: TaskResult;
    if (list === "actions" && (record.state === "completed" || record.state === "failed")) {
      // Crashed after the journal write but before the cursor advanced: replay, never re-run.
      result = record.result as TaskResult;
    } else {
      const timeoutFail = (message: string): TaskResult => ({
        status: "fail",
        message: `${task.id} did not finish within ${formatDuration(task.wait.timeoutMs ?? 0)}: ${message}`,
      });
      const expired = (deadlineAt: string | null) => deadlineAt !== null && clock().getTime() >= Date.parse(deadlineAt);
      if (list === "actions" && record.state === "pending" && expired(record.deadlineAt)) {
        // An act past its deadline is not invoked again; it fails with its last pending message.
        result = timeoutFail((record.result as { message?: string } | null)?.message ?? "no progress");
      } else {
        const running = journal.markRunning(record.id, run.epoch);
        await this.#save(run, { state: "running" });
        result = await runTask(definition, {
          context: run.context, config: task.with, deps,
          instance: { id: task.id, stage: run.stage.id, idempotencyKey: record.idempotencyKey, resumed: planned.resumed },
        });
        if (result.status === "pending" && expired(running.deadlineAt)) result = timeoutFail(result.message);
      }
      if (result.status === "pass") journal.completeExecution(record.id, result, run.epoch);
      else if (result.status === "fail") journal.failExecution(record.id, result, run.epoch);
    }

    if (result.status === "pass") {
      if (list === "actions") {
        captureOutput(run.context, task, result.output);
        markStale(run.context, task.invalidates);
      }
      if (definition.checkpoint?.scope === "task") {
        recordCheckpoint(run.context, definition, task.id, clock().toISOString());
      }
      this.#persist(run, task.id);
      if (list === "actions") {
        const tasks = run.stage.actions;
        const next = tasks[tasks.findIndex((t) => t.id === task.id) + 1];
        await this.#moveTo(run, { list: next ? "actions" : "exit-gate", taskInstanceId: next?.id ?? null });
      }
      return { kind: "pass" };
    }
    if (result.status === "fail") {
      return { kind: "fail", message: result.message, details: result.details, route: result.route };
    }
    const now = clock().getTime();
    const wakeAt = new Date(now + (validAfter(result.after) ?? task.wait.pollMs)).toISOString();
    const deadlineAt = task.wait.timeoutMs === null ? null : new Date(now + task.wait.timeoutMs).toISOString();
    const pendingRecord = journal.markPending(record.id, { wakeAt, deadlineAt, message: result.message }, run.epoch);
    await this.#save(run, {
      state: "pending", pendingSince: pendingRecord.pendingSince, wakeAt, deadlineAt: pendingRecord.deadlineAt,
    });
    await this.#o.setStatus(result.message);
    return { kind: "pending", wakeAt };
  }

  async #route(
    run: Run,
    task: CompiledTask,
    list: List,
    failure: Extract<Step, { kind: "fail" }>,
  ): Promise<StageOutcome | null> {
    const { journal, settings } = this.#o;
    const { stage, cursor } = run;
    const route = resolveRoute(failure.route, task.onFail, list);
    const where = `${stage.id}: ${task.id} failed`;
    const finish = async (outcome: StageOutcome, note: string): Promise<StageOutcome> => {
      journal.clearCursor(run.input.issueId, run.epoch);
      await this.#o.setStatus(null);
      await this.#o.notify(note);
      return outcome;
    };
    const stop = (state: string, reason: string, note: string) => {
      // A human unblock after a stop starts with a fresh loop budget.
      engineState(run.context).returns = 0;
      this.#persist(run, task.id);
      return finish(
        { kind: "stopped", stageId: stage.id, state, reason, requiredFixes: [], feedbackCycles: cursor.attempt - 1, result: null },
        note,
      );
    };

    if ("retry" in route) {
      if (cursor.attempt <= stage.retries) {
        const feedback: Feedback = { from: { stage: stage.id, taskInstanceId: task.id }, message: failure.message };
        if (failure.details !== undefined) feedback.details = failure.details;
        run.cursor = {
          ...cursor, attempt: cursor.attempt + 1, list: "actions", taskInstanceId: null, state: "planned",
          feedback, pendingSince: null, wakeAt: null, deadlineAt: null,
        };
        journal.saveCursor(run.cursor, run.epoch);
        await this.#o.setStatus(null);
        await this.#o.notify(`${where} (attempt ${cursor.attempt} of ${stage.retries + 1}), retrying: ${failure.message}`);
        return null;
      }
      return stop("blocked", failure.message, `${where} and retries are exhausted, stopping as blocked: ${failure.message}`);
    }
    if ("stop" in route) return stop(route.stop, failure.message, `${where}, stopping as ${route.stop}: ${failure.message}`);

    if (cursor.returns >= settings.maxReturns) {
      const reason = `Return loop guard tripped: ${stage.id} already returned ${cursor.returns} times (maxReturns ${settings.maxReturns}); last failure: ${failure.message}`;
      return stop("blocked", reason, `${where}; ${reason}`);
    }
    engineState(run.context).returns = cursor.returns + 1;
    this.#persist(run, task.id);
    return finish(
      {
        kind: "correction", stageId: stage.id, targetStageId: route.return, reason: failure.message,
        requiredFixes: [], evidence: [], result: null,
      },
      `${where}, returning to ${route.return}: ${failure.message}`,
    );
  }

  async #loadSnapshots(run: Run, task: CompiledTask): Promise<void> {
    const keys = keysToLoad(run.context, task);
    for (const key of keys) {
      const loader = this.#o.registry.loaderFor(key);
      if (!loader) throw new Error(`No loader registered for ${key}`);
      const result = await runTask(loader, {
        context: run.context, config: {}, deps: run.input.deps,
        instance: { id: loader.name, stage: run.stage.id, idempotencyKey: "", resumed: false },
      });
      if (result.status !== "pass") throw new Error(`Load ${loader.name} did not pass: ${result.status}`);
      (run.context as unknown as Record<string, unknown>)[key] = result.output;
      markLoaded(run.context, key);
    }
    if (keys.length > 0) this.#persist(run, task.id);
  }

  #setRun(run: Run, taskInstanceId: string): void {
    run.context.run = {
      stage: run.stage.id, stageEpoch: run.epoch, attempt: run.cursor.attempt,
      maxAttempts: run.stage.retries + 1, taskInstanceId, enteredAt: run.enteredAt,
      feedback: run.cursor.feedback,
    };
  }

  #persist(run: Run, taskInstanceId: string): void {
    this.#o.journal.saveContext(run.input.issueId, run.context, {
      stage: run.stage.id, taskInstanceId, expectedEpoch: run.epoch,
    });
  }

  /** Points the cursor at a task (or list boundary) in a fresh `planned` state. */
  async #moveTo(run: Run, to: { list: List; taskInstanceId: string | null }): Promise<void> {
    if (run.cursor.list === to.list && run.cursor.taskInstanceId === to.taskInstanceId) return;
    await this.#save(run, { ...to, state: "planned", pendingSince: null, wakeAt: null, deadlineAt: null });
  }

  async #save(run: Run, patch: Partial<StageCursor>): Promise<void> {
    run.cursor = { ...run.cursor, ...patch };
    this.#o.journal.saveCursor(run.cursor, run.epoch);
  }
}
