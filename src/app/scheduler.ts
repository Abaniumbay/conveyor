// The stateful side of scheduling (#676): which items may start now (the pure selection is in
// src/core/scheduler.ts), in-progress limits and their waiters, parked items' wake-ups and the wake
// timer, the scheduler's trace and the live waiting or queued status the dashboard and CLI show.

import type { ConveyorConfig } from "../config/load";
import { isNativeStage } from "../config/schema";
import { STOPPED_ISSUE_STATES } from "../core/issue-state";
import { inFlightAdmission, inFlightHolders, inFlightInterval, inFlightWaitReason, type InFlightInterval } from "../core/in-flight";
import { capacityBlockers, selectRunnableIssues, type ConcurrencyLimits, type SchedulerCandidate, type SchedulerOccupant } from "../core/scheduler";
import type { EventStore, EvidenceStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import { ENTRY_APPROVAL_TASK_ID } from "../engine/stage-executor";
import type { EventPayload } from "../events/catalogue";
import { log } from "../log/logger";
import type { CallSource } from "../source/calls";
import { createTaskRegistry } from "../tasks/catalogue";
import { compilePipeline } from "../tasks/plan";
import type { IssueJourneyViewModel } from "../web/types";
import type { LiveIssueStatus, SchedulerLookups } from "./dashboard-sources";
import { CI_INDICATOR_ID, type StoredIndicator } from "./indicators";
import { latestStopReason } from "./item-history";

/** A stage this process runs now, as the scheduler counts it. */
export interface RunningStage {
  repositoryId: string;
  stageId: string;
  /** Runs no runner process; excluded from global and repository permits. */
  lightweight: boolean;
  /** Holds a runner but no repository permit: only checks remain. */
  gateOnly: boolean;
}

export interface SchedulerDeps {
  config: ConveyorConfig;
  /** In-progress limits read the whole item and journal ports. */
  store: ItemStore & JournalStore
    & Pick<RunLogStore, "listActiveIssueRuns" | "listIssueRuns">
    & Pick<EvidenceStore, "listIndicators">
    & EventStore;
  /** The stages this process runs now, by item. */
  running: () => ReadonlyMap<string, RunningStage>;
  shuttingDown: () => boolean;
  /** Whether a drain stops new work from being admitted. */
  draining: () => boolean;
  /** Whether the repository finished its startup pass and its onboarding and last reconcile succeeded. */
  repositoryReady: (repositoryId: string) => boolean;
  isLightweightStage: (repositoryId: string, stageId: string) => boolean;
  isSkippedStage: (repositoryId: string, stageId: string) => boolean;
  isGateOnlyExecution: (issueId: string, repositoryId: string, stageId: string) => boolean;
  /** Whether a parked agent question belongs to this item's current execution. */
  hasResumableQuestionExecution: (issueId: string) => boolean;
  /** Only an explicit retry may schedule a parent that already has children. */
  childCreationRetryQueued: (issue: StoredIssue, stageId: string | null) => boolean;
  /**
   * Runs a scheduling pass through the owner's entry point; a requested pass and the wake timer use
   * it, so every pass starts the same way whoever asked for it.
   */
  schedulePass: () => void;
  /** Starts the selected item's stage run; it must be among `running` when this returns. */
  launch: (issue: StoredIssue, candidate: SchedulerCandidate) => void;
  refreshStatusComments: (issueIds: readonly string[]) => void;
  /** Records that the wake timer fired. */
  timerFired: () => void;
}

/** Admission of items to stage runs, their wake-ups and their live status. */
export class Scheduler {
  readonly #deps: SchedulerDeps;
  #scheduleRequested = false;
  /** Items an event (not their wake-up time) woke since their stage last started. */
  readonly #wokenEarly = new Set<string>();
  #wakeTimer: ReturnType<typeof setTimeout> | null = null;
  #lastDecision = "";

  constructor(deps: SchedulerDeps) {
    this.#deps = deps;
  }

  /** One scheduling pass: promotes in-progress waiters, then starts every runnable item there is room for. */
  schedule(): void {
    const { store } = this.#deps;
    if (this.#deps.shuttingDown() || this.#deps.draining()) return;
    const promotedIds = this.#promoteInFlightWaiters();
    const candidates = this.candidates();
    const limits = this.concurrencyLimits();
    const occupants = this.occupants();
    const stageUsage: Record<string, number> = {};
    const repositoryUsage: Record<string, number> = {};
    let processUsage = 0;
    for (const active of occupants) {
      stageUsage[active.stageId] = (stageUsage[active.stageId] ?? 0) + 1;
      if (active.lightweight) continue;
      processUsage += 1;
      if (active.gateOnly) continue;
      repositoryUsage[active.repositoryId] = (repositoryUsage[active.repositoryId] ?? 0) + 1;
    }
    const selected = selectRunnableIssues(
      candidates,
      limits,
      {
        global: processUsage,
        stages: stageUsage,
        repositories: repositoryUsage,
      },
    );
    const startedIds = new Set<string>();
    for (const candidate of selected) {
      const issue = store.getIssue(candidate.id);
      if (!issue) continue;
      // A pause can land between candidate collection and admission. Recheck
      // at the boundary so every wake path observes the durable pause.
      if (store.repositoryPause(issue.repositoryId)) continue;
      // Relationship reconciliation can add children after this scheduling
      // pass built its candidates. Recheck at the admission boundary so an
      // item never starts a new run after becoming a roll-up parent.
      if (
        store.listChildren(issue.id).length > 0 &&
        !this.#deps.hasResumableQuestionExecution(issue.id) &&
        !this.#deps.childCreationRetryQueued(issue, candidate.stageId)
      ) continue;
      // The retry marker is only an admission permit. Restore the executor's
      // ordinary ready state immediately before it claims the stage.
      const stage = store.getStageState(issue.id);
      if (stage?.status === "retry-ready" && stage.stageId === candidate.stageId) {
        store.setStageState({ ...stage, status: "ready" });
      }
      this.#deps.launch(issue, candidate);
      startedIds.add(issue.id);
    }
    const selectedIds = startedIds;
    const waiting = candidates.filter((candidate) => candidate.eligible && candidate.dependenciesSatisfied && !candidate.rollupOnly && !selectedIds.has(candidate.id)).length;
    this.#traceDecision({ started: selectedIds.size, waiting, running: this.#deps.running().size - selectedIds.size });
    this.#deps.refreshStatusComments([
      ...promotedIds,
      ...selectedIds,
      ...candidates
        .filter((candidate) => candidate.eligible && candidate.dependenciesSatisfied && !candidate.rollupOnly && !selectedIds.has(candidate.id))
        .map((candidate) => candidate.id),
    ]);
    this.#armWakeTimer();
  }

  /** Schedules once after the current burst of events instead of once per event. */
  requestSchedule(): void {
    if (this.#scheduleRequested) return;
    this.#scheduleRequested = true;
    queueMicrotask(() => this.flushSchedule());
  }

  /** Runs the pass a request asked for, now, if it has not run yet. */
  flushSchedule(): void {
    if (!this.#scheduleRequested) return;
    this.#scheduleRequested = false;
    // It runs after the event that asked for it, so nothing awaits it to report a failure.
    try {
      this.#deps.schedulePass();
    } catch (error) {
      log.error("Scheduling after an event failed", {}, error);
    }
  }

  /** Stops the wake timer. */
  close(): void {
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
  }

  /** Makes a parked item due now and remembers that an event, not its wake-up time, woke it. */
  wakeParked(issueId: string): boolean {
    const { store } = this.#deps;
    const issue = store.getIssue(issueId);
    if (issue && store.repositoryPause(issue.repositoryId)) return false;
    const woken = store.executions().wakeNow(issueId);
    if (woken) this.#wokenEarly.add(issueId);
    return woken;
  }

  /** Why a stage run starts: an early wake of a parked task, its wake-up time passing, or other stage work. */
  callSource(issueId: string): CallSource {
    const woken = this.#wokenEarly.delete(issueId);
    if (this.#deps.store.executions().getCursor(issueId)?.state !== "pending") return "stage";
    return woken ? "wait" : "fallback";
  }

  /** Checks the durable holder set immediately before an item writes its stage checkpoint. */
  inFlightAdmission(issue: StoredIssue, targetStageId: string): string | null {
    const configured = this.#repositoryInFlight(issue.repositoryId);
    if (!configured) return null;
    return inFlightAdmission({
      store: this.#deps.store,
      repositoryId: issue.repositoryId,
      issueId: issue.id,
      targetStageId,
      ...configured,
    });
  }

  /** Every queued item as the selection sees it. `lookups` stand in for the per-item store reads. */
  candidates(issues: readonly StoredIssue[] = this.#deps.store.listIssues(), lookups?: SchedulerLookups): SchedulerCandidate[] {
    const { store } = this.#deps;
    const stageState = lookups?.stageState ?? ((issueId: string) => store.getStageState(issueId));
    const dependencies = lookups?.dependencies ?? ((issueId: string) => store.listDependencies(issueId));
    const children = lookups?.children ?? ((issueId: string) => store.listChildren(issueId));
    const getIssue = lookups?.issue ?? ((issueId: string) => store.getIssue(issueId));
    const running = this.#deps.running();
    return issues.flatMap((issue) => {
      const state = stageState(issue.id);
      if (!state?.stageId || issue.queueRank === null) return [];
      const lightweight = this.#deps.isLightweightStage(issue.repositoryId, state.stageId);
      const dependenciesSatisfied = dependencies(issue.id).every((id) => {
        const blocker = getIssue(id);
        return Boolean(blocker && (blocker.sourceState === "closed" || blocker.projectedState === "done"));
      });
      return [{
        id: issue.id,
        repositoryId: issue.repositoryId,
        stageId: state.stageId,
        queueRank: issue.queueRank,
        siblingOrder: null,
        eligible:
          issue.projectedState === "active" &&
          (state.status === "ready" || state.status === "retry-ready") &&
          !running.has(issue.id) &&
          this.#wakeupReached(issue.id) &&
          store.repositoryPause(issue.repositoryId) === null &&
          this.#deps.repositoryReady(issue.repositoryId),
        dependenciesSatisfied,
        rollupOnly:
          children(issue.id).length > 0 &&
          !this.#deps.hasResumableQuestionExecution(issue.id) &&
          !this.#deps.childCreationRetryQueued(issue, state.stageId),
        lightweight,
        skipped: this.#deps.isSkippedStage(issue.repositoryId, state.stageId),
        gateOnly: !lightweight && this.#deps.isGateOnlyExecution(issue.id, issue.repositoryId, state.stageId),
      }];
    });
  }

  /** The configured runner, stage and repository limits. */
  concurrencyLimits(): ConcurrencyLimits {
    const { config } = this.#deps;
    const stages: Record<string, number> = {};
    for (const pipeline of Object.values(config.pipelines)) {
      for (const stage of pipeline.stages) {
        stages[stage.id] = Math.min(stages[stage.id] ?? Infinity, stage.concurrency);
      }
    }
    return {
      global: config.settings.runners,
      stages,
      repositories: Object.fromEntries(
        Object.entries(config.repositories).map(([id, repository]) => [id, repository.concurrency]),
      ),
    };
  }

  /** What holds a permit now: recorded live runs and this process's running stages. */
  occupants(): SchedulerOccupant[] {
    const occupants = new Map<string, SchedulerOccupant>();
    for (const run of this.#deps.store.listActiveIssueRuns()) {
      if (this.#deps.isSkippedStage(run.repository, run.stageId)) continue;
      occupants.set(run.issueId, {
        id: run.issueId,
        repositoryId: run.repository,
        stageId: run.stageId,
        lightweight: this.#deps.isLightweightStage(run.repository, run.stageId),
        gateOnly: this.#deps.isGateOnlyExecution(run.issueId, run.repository, run.stageId),
      });
    }
    for (const [id, active] of this.#deps.running()) {
      if (this.#deps.isSkippedStage(active.repositoryId, active.stageId)) continue;
      occupants.set(id, { id, repositoryId: active.repositoryId, stageId: active.stageId, lightweight: active.lightweight, gateOnly: active.gateOnly });
    }
    return [...occupants.values()];
  }

  /**
   * Reads the live status of many items. The scheduler's view of every item costs a pass over all of
   * them, so it is built once, on the first item that needs it.
   */
  liveStatusReader(issues?: readonly StoredIssue[], lookups?: SchedulerLookups): (issue: StoredIssue) => LiveIssueStatus | null {
    const queue = this.#queue(issues, lookups);
    return (issue) => this.status(issue, queue);
  }

  /** The live scheduler status for an item, when it is waiting or queued rather than running. */
  liveIssueStatus(issueId: string): LiveIssueStatus | null {
    const issue = this.#deps.store.getIssue(issueId);
    return issue ? this.status(issue) : null;
  }

  /** Where an item is now: its stage, state, why and since when. The CLI and the dashboard's journey show it. */
  itemNow(issueId: string): IssueJourneyViewModel["now"] | null {
    const { store } = this.#deps;
    const issue = store.getIssue(issueId);
    if (!issue) return null;
    const stageState = store.getStageState(issueId);
    const cursor = store.executions().getCursor(issueId);
    const pending = cursor?.state === "pending";
    const activeRun = store.listActiveIssueRuns().find((run) => run.issueId === issueId);
    const stopped = STOPPED_ISSUE_STATES.has(issue.projectedState ?? "");
    const liveStatus = this.liveIssueStatus(issueId);
    const nowState = liveStatus?.kind ?? (pending ? "waiting" : activeRun ? "running" : stopped ? "stopped" : issue.projectedState ?? issue.sourceState);
    const nowReason = liveStatus?.reason ?? (pending
      ? store.executions().pendingMessage(issueId) ?? issue.warning
      : stopped ? latestStopReason(store, issueId) ?? issue.warning : null);
    return {
      stage: cursor?.stage ?? stageState?.stageId ?? issue.projectedStage,
      state: nowState,
      reason: nowReason,
      since: liveStatus?.since ?? (pending
        ? cursor.pendingSince
        : activeRun?.startedAt ?? stageState?.updatedAt ?? issue.sourceUpdatedAt),
    };
  }

  /** The current presentation status, derived from durable gate state and live scheduler facts. */
  status(issue: StoredIssue, queue = this.#queue()): LiveIssueStatus | null {
    const { store } = this.#deps;
    if (store.listActiveIssueRuns().some((run) => run.issueId === issue.id)) return null;
    const inFlightReason = this.#inFlightWaitingReason(issue);
    if (inFlightReason) {
      return {
        kind: "waiting",
        reason: inFlightReason,
        since: store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: null,
        deadline: null,
      };
    }
    const cursor = store.executions().getCursor(issue.id);
    const pending = cursor?.state === "pending" ? store.executions().pendingMessage(issue.id) : null;
    const wakeAt = cursor?.state === "pending" ? cursor.wakeAt : null;
    const wakeInFuture = wakeAt !== null && Date.parse(wakeAt) > Date.now();
    if (cursor?.state === "pending" && wakeInFuture) {
      return {
        kind: "waiting",
        reason: (cursor.taskInstanceId ? this.#ciWaitingReason(issue, cursor.taskInstanceId, pending) : null) ?? pending ?? issue.warning ?? "Waiting for the next check",
        since: cursor.pendingSince ?? store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: wakeAt,
        deadline: cursor.deadlineAt,
      };
    }

    const candidate = queue().candidates.find((item) => item.id === issue.id);
    if (!candidate || !candidate.eligible || candidate.rollupOnly) return null;
    if (!candidate.dependenciesSatisfied) {
      const dependencies = store.listDependencies(issue.id)
        .map((dependencyId) => store.getIssue(dependencyId))
        .filter((dependency): dependency is StoredIssue => dependency !== null)
        .filter((dependency) => dependency.sourceState !== "closed" && dependency.projectedState !== "done")
        .map((dependency) => `#${dependency.sourceNumber}`);
      return {
        kind: "waiting",
        reason: `Waiting for dependencies: ${dependencies.join(", ")}`,
        since: store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
        nextCheckAt: null,
        deadline: null,
      };
    }
    const blockers = capacityBlockers(candidate, this.concurrencyLimits(), queue().occupants);
    if (blockers.length === 0) return null;
    const reason = blockers.map((blocker) => {
      const holderNumbers = blocker.occupants
        .map((id) => store.getIssue(id)?.sourceNumber)
        .filter((number): number is number => number !== undefined)
        .map((number) => `#${number}`)
        .join(", ");
      const name = blocker.scope === "global"
        ? "global runner slots"
        : blocker.scope === "stage"
          ? `${candidate.stageId} slots`
          : `${candidate.repositoryId} slots`;
      return `${name} ${blocker.used}/${blocker.limit} busy: ${holderNumbers || "unknown item"}`;
    }).join("; ");
    return {
      kind: "queued",
      reason,
      since: wakeAt ?? store.getStageState(issue.id)?.updatedAt ?? issue.sourceUpdatedAt,
      nextCheckAt: null,
      deadline: null,
    };
  }

  #queue(issues?: readonly StoredIssue[], lookups?: SchedulerLookups): () => { candidates: SchedulerCandidate[]; occupants: SchedulerOccupant[] } {
    let queue: { candidates: SchedulerCandidate[]; occupants: SchedulerOccupant[] } | undefined;
    return () => queue ??= { candidates: this.candidates(issues, lookups), occupants: this.occupants() };
  }

  /** A trace of what a scheduling pass decided, recorded only when the outcome changed. */
  #traceDecision(decision: EventPayload<"scheduler.decided">): void {
    const key = JSON.stringify(decision);
    if (decision.started === 0 && key === this.#lastDecision) return;
    this.#lastDecision = key;
    try {
      this.#deps.store.events().trace("scheduler.decided", decision);
    } catch (error) {
      log.warn("Could not record a trace", {}, error);
    }
  }

  /** Schedules one pass for the earliest future wake-up; past-due items are picked up by ordinary passes. */
  #armWakeTimer(): void {
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#wakeTimer = null;
    if (this.#deps.shuttingDown()) return;
    const next = this.#deps.store.executions().nextWakeupAfter(new Date());
    if (next === null) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = null;
      this.#deps.timerFired();
      this.#deps.schedulePass();
    }, Math.max(0, Date.parse(next) - Date.now()) + 50);
  }

  /** A parked item is schedulable only once its persisted wake-up time has passed. */
  #wakeupReached(issueId: string): boolean {
    const cursor = this.#deps.store.executions().getCursor(issueId);
    // Manual exit gates and configured entry approvals have no clock wake-up.
    // Their receipt event must explicitly wake the persisted cursor first.
    if (!cursor) return true;
    if (cursor.state === "pending" && cursor.wakeAt === null &&
      (cursor.list === "exit-gate" ||
        (cursor.list === "actions" && cursor.taskInstanceId === ENTRY_APPROVAL_TASK_ID))) return false;
    return cursor.wakeAt === null || Date.parse(cursor.wakeAt) <= Date.now();
  }

  #repositoryInFlight(repositoryId: string): {
    stages: readonly { id: string }[];
    interval: InFlightInterval;
  } | null {
    const { config } = this.#deps;
    const repository = config.repositories[repositoryId];
    if (!repository?.inFlight) return null;
    const pipeline = config.pipelines[repository.pipeline];
    if (!pipeline) return null;
    const mergeIndex = pipeline.stages.findIndex(
      (stage) => isNativeStage(stage) && stage.actions.some((action) => action.task === "change.merge"),
    );
    const interval = inFlightInterval(pipeline.stages, repository.inFlight, mergeIndex);
    return interval ? { stages: pipeline.stages, interval } : null;
  }

  #inFlightHolders(repositoryId: string): StoredIssue[] {
    const configured = this.#repositoryInFlight(repositoryId);
    return configured
      ? inFlightHolders({ store: this.#deps.store, repositoryId, ...configured })
      : [];
  }

  #inFlightWaitingReason(issue: StoredIssue): string | null {
    if (!this.#repositoryInFlight(issue.repositoryId)) return null;
    const state = this.#deps.store.getStageState(issue.id);
    if (state?.status !== "waiting-in-flight") return null;
    const holders = this.#inFlightHolders(issue.repositoryId)
      .filter((holder) => holder.id !== issue.id);
    return holders.length > 0 ? inFlightWaitReason(issue.repositoryId, holders) : issue.warning;
  }

  /** Promotes waiting prior-stage completions in queue order when code-pipeline capacity is free. */
  #promoteInFlightWaiters(): string[] {
    const { config, store } = this.#deps;
    const promoted: string[] = [];
    for (const repositoryId of Object.keys(config.repositories)) {
      const configured = this.#repositoryInFlight(repositoryId);
      if (!configured) continue;
      const available = configured.interval.limit - this.#inFlightHolders(repositoryId).length;
      if (available <= 0) continue;
      const waiters = store.listIssues(repositoryId).filter((issue) => {
        const state = store.getStageState(issue.id);
        const stageIndex = state ? configured.stages.findIndex((stage) => stage.id === state.stageId) : -1;
        return issue.projectedState === "active" &&
          state?.status === "waiting-in-flight" &&
          stageIndex + 1 === configured.interval.fromIndex;
      });
      for (const issue of waiters.slice(0, available)) {
        const state = store.getStageState(issue.id)!;
        store.setStageState({ ...state, status: "ready", configHash: config.hash });
        store.setIssueProjection(issue.id, {
          stage: issue.projectedStage,
          state: issue.projectedState ?? "active",
          warning: null,
        });
        promoted.push(issue.id);
      }
    }
    return promoted;
  }

  #ciWaitingReason(issue: StoredIssue, taskInstanceId: string, pending: string | null): string | null {
    if (!pending?.startsWith("Waiting for CI")) return null;
    const indicator = this.#deps.store.listIndicators(issue.id).find((item) => item.id === CI_INDICATOR_ID);
    if (!indicator) return null;
    const head = indicator.headSha.slice(0, 7);
    const unfinished = indicator.entries
      .filter((entry) => entry.state === "queued" || entry.state === "running")
      .map((entry) => entry.name);
    if (unfinished.length > 0 || indicator.state === "running" || indicator.state === "unknown") {
      return `Waiting for CI at ${head}: ${unfinished.join(", ") || indicator.detail}.`;
    }
    if (indicator.state === "failed") return `CI failed at ${head}: ${indicator.detail}.`;
    const settleEnd = this.#ciSettleEnd(issue, taskInstanceId, indicator);
    return settleEnd !== null
      ? `CI passed at ${head}; settling until ${settleEnd}.`
      : `CI passed at ${head}; ready for the next gate evaluation.`;
  }

  #ciSettleEnd(issue: StoredIssue, taskInstanceId: string, indicator: StoredIndicator): string | null {
    const { config, store } = this.#deps;
    const plan = config.plans.find((candidate) => candidate.repositoryId === issue.repositoryId)
      ?? compilePipeline({ config, repositoryId: issue.repositoryId, registry: createTaskRegistry() });
    const stage = plan.stages.find((candidate) => candidate.id === store.getStageState(issue.id)?.stageId);
    const task = stage && [...stage.actions, ...stage.exitGate].find((candidate) => candidate.id === taskInstanceId);
    if (task?.task !== "ci.passed" && task?.task !== "ci.settled") return null;
    const seconds = typeof task.with.settleSeconds === "number" ? task.with.settleSeconds : 120;
    const firstSeen = store.executions().ciMarkAt(issue.id, indicator.headSha, "first-seen") ?? indicator.observedAt;
    const settleEnd = new Date(Date.parse(firstSeen) + seconds * 1_000).toISOString();
    return Date.parse(settleEnd) > Date.now() ? settleEnd : null;
  }
}
