// Retrying stopped items (#676): whether a stopped item may be retried, where its retry goes (its
// own stage, or the stage a stopped CI gate names), and the retry itself: the source labels first,
// recorded as a source mutation, then a reconcile of the one item. A cross-stage retry's handoff is
// kept in that mutation until reconciliation restores it.

import { randomUUID } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { evaluateIssueState } from "../core/issue-state";
import { RepositoryPausedError } from "../core/repository-pause";
import type { ConversationStore, EventStore, ItemStore, JournalStore, RunLogStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import type { ItemMarkers, ItemReader } from "../source/types";
import type { Feedback } from "../tasks/context";
import { latestStop } from "./item-history";

/** What a scheduled Operator check allows a retry of, and where it records the outcome. */
export interface ScheduledRetryCheck {
  targets: ReadonlySet<string>;
  inspected: ReadonlySet<string>;
  outcomes: Map<string, { outcome: "retried" | "answered" | "unresolved"; reason: string; evidence?: string }>;
}

export interface RetryDeps {
  config: Pick<ConveyorConfig, "labels" | "repositories" | "pipelines" | "hash"> & { labelPrefix: string };
  store: Pick<ItemStore,
    | "getIssue" | "listIssues" | "repositoryPause" | "hasMergedPullRequest" | "listChildren" | "setQueueRank" | "nextQueueRank"
  >
    & Pick<JournalStore,
      | "executions" | "getStageState" | "setStageState" | "listStageTransitions"
      | "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation" | "getLatestSourceMutationByKeyPrefix"
    >
    & Pick<RunLogStore, "listIssueRuns">
    & Pick<ConversationStore, "appendConversationMessage" | "listConversationMessages">
    & EventStore;
  source: Pick<ItemReader, "getIssue">;
  /** The item source fenced at the repository's pause. */
  fencedSource: (repositoryId: string) => Pick<ItemMarkers, "replaceConveyorLabels">;
  /** Whether the item has a run in this process or a recorded run that has not finished. */
  hasLiveRun: (issueId: string) => boolean;
  /** Whether the item's stage is running in this process. */
  isRunning: (issueId: string) => boolean;
  /** Whether this stage's agent is allowed to create children. */
  stageCreatesChildren: (repositoryId: string, stageId: string | null) => boolean;
  /** Reads the one item from the source again. */
  reconcile: (repositoryId: string, sourceNumber: number) => Promise<void>;
  /** Resolves once committed events are published and the scheduling they asked for ran. */
  eventsSettled: () => Promise<void>;
  /** The scheduled Operator check a run belongs to. */
  scheduledCheck: (runId: string) => ScheduledRetryCheck | undefined;
}

/** Like an object, but an absent or malformed value reads as an empty object. */
function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Reads a durable cross-stage retry handoff only when it still matches the reconciled destination. */
function retryFeedbackFromRequest(request: Record<string, unknown>, issueId: string, stageId: string): Feedback | null {
  if (request.issueId !== issueId || request.retryStageId !== stageId) return null;
  const feedback = fields(request.retryFeedback);
  const from = fields(feedback.from);
  if (typeof from.stage !== "string" || typeof from.taskInstanceId !== "string" || typeof feedback.message !== "string") {
    return null;
  }
  if (feedback.repairedByActions !== undefined && feedback.repairedByActions !== true) return null;
  return {
    from: { stage: from.stage, taskInstanceId: from.taskInstanceId },
    message: feedback.message,
    ...(Object.hasOwn(feedback, "details") ? { details: feedback.details } : {}),
    ...(feedback.repairedByActions === true ? { repairedByActions: true } : {}),
  };
}

/** Retries of stopped items, by people, the AI Operator and scheduled checks. */
export class ItemRetries {
  readonly #deps: RetryDeps;
  readonly #retrying = new Set<string>();

  constructor(deps: RetryDeps) {
    this.#deps = deps;
  }

  /** Whether an item's recorded state is a stop a retry may restart. */
  retryable(issue: StoredIssue, children: number, running: boolean): boolean {
    return (issue.sourceState === "open" ||
      (issue.sourceState === "closed" && this.#deps.store.hasMergedPullRequest(issue.id))) &&
      issue.labels.includes(this.#deps.config.labels.enrollment) &&
      issue.projectedStage !== null &&
      ["blocked", "error", "needs-intervention"].includes(issue.projectedState ?? "") &&
      !running && (children === 0 || this.#deps.stageCreatesChildren(issue.repositoryId, issue.projectedStage));
  }

  /** Whether the stored state permits a stage retry before the command verifies the source snapshot. */
  canRetry(issueId: string): boolean {
    const issue = this.#deps.store.getIssue(issueId);
    return issue !== null && this.retryable(
      issue,
      this.#deps.store.listChildren(issueId).length,
      this.#deps.hasLiveRun(issueId),
    );
  }

  /** The configured destination for a stopped CI gate's deliberate retry, when it is still valid. */
  targetStage(issueId: string): string | null {
    const { config } = this.#deps;
    const issue = this.#deps.store.getIssue(issueId);
    const repository = issue ? config.repositories[issue.repositoryId] : undefined;
    const pipeline = repository ? config.pipelines[repository.pipeline] : undefined;
    if (!issue || !pipeline) return null;
    const route = this.#route(issue, pipeline.stages.map((stage) => stage.id));
    return route?.stageId === issue.projectedStage ? null : route?.stageId ?? null;
  }

  #route(issue: StoredIssue, stageIds: readonly string[]): { stageId: string; feedback: Feedback | null } | null {
    if (issue.projectedStage === null) return null;
    const transition = this.#deps.store.listStageTransitions(issue.id).at(-1);
    const retryTargetStage = transition?.retryTargetStage;
    const retryFeedback = transition?.retryFeedback;
    if (transition?.kind !== "stopped" || transition.status !== "completed" ||
      transition.toStage !== issue.projectedStage || retryTargetStage === undefined || retryTargetStage === null ||
      retryFeedback === undefined || retryFeedback === null || !stageIds.includes(retryTargetStage)) {
      return { stageId: issue.projectedStage, feedback: null };
    }
    return { stageId: retryTargetStage, feedback: retryFeedback };
  }

  /** Restores a retry handoff that survived its source-label mutation but not local reconciliation. */
  restoreFeedback(repositoryId: string): void {
    const { store } = this.#deps;
    const journal = store.executions();
    for (const issue of store.listIssues(repositoryId)) {
      if (issue.projectedState !== "active" || issue.projectedStage === null) {
        continue;
      }
      const mutation = store.getLatestSourceMutationByKeyPrefix(`web-retry:${issue.id}:`);
      if (mutation?.operation !== "issue.labels.retry" || mutation.status === "succeeded") continue;
      const feedback = retryFeedbackFromRequest(fields(mutation.request), issue.id, issue.projectedStage);
      if (feedback === null) continue;

      if (journal.getCursor(issue.id) === null) {
        const epoch = journal.stageEpoch(issue.id);
        journal.saveCursor({
          issueId: issue.id,
          stage: issue.projectedStage,
          stageEpoch: epoch,
          attempt: 1,
          returns: 0,
          list: "actions",
          taskInstanceId: null,
          state: "planned",
          feedback,
          pendingSince: null,
          wakeAt: null,
          deadlineAt: null,
        }, epoch);
      }
      store.completeSourceMutation(mutation.id, { labels: fields(mutation.request).labels });
    }
  }

  /** A scheduled Operator check's retry: only of its own stopped targets, and only with evidence added after the stop. */
  async scheduledRetry(runId: string, issueId: string, note: string, evidence: string): Promise<{ status: "started" | "queued"; stageId: string }> {
    const { config, store } = this.#deps;
    const check = this.#deps.scheduledCheck(runId);
    if (!check?.targets.has(issueId)) throw new Error("scheduled checks may retry only their stopped targets");
    if (!check.inspected.has(issueId)) throw new Error("inspect the item's history before retrying it");
    const issue = store.getIssue(issueId);
    const repository = issue && config.repositories[issue.repositoryId];
    if (!issue || !repository) throw new Error("item is not on this configured board");
    const live = await this.#deps.source.getIssue(repository.address, issue.sourceNumber);
    const recordedStop = latestStop(store, issueId);
    const evidenceText = evidence.trim();
    if (!evidenceText) throw new Error("scheduled retry evidence must not be blank");
    const stoppedAt = recordedStop.stoppedAt ? Date.parse(recordedStop.stoppedAt) : Number.NaN;
    if (!Number.isFinite(stoppedAt)) throw new Error("scheduled retry requires a recorded stopped attempt");
    const sourceChangedAfterStop = Date.parse(live.updatedAt) > stoppedAt;
    const sourceEvidence = sourceChangedAfterStop &&
      recordedStop.sourceSnapshot !== null &&
      [live.title, live.body].some((text) => text.includes(evidenceText)) &&
      ![recordedStop.sourceSnapshot.title, recordedStop.sourceSnapshot.body].some((text) => text.includes(evidenceText));
    const conversationEvidence = store.listConversationMessages(issueId).some((message) =>
      message.actorId !== "scheduled-operator" &&
      Date.parse(message.createdAt) > stoppedAt &&
      message.message.includes(evidenceText)
    );
    if (!sourceEvidence && !conversationEvidence) {
      throw new Error("scheduled retry evidence must quote source content added after the recorded stop or a non-Operator conversation recorded after it");
    }
    const outcome = await this.retry(issueId, note, "Scheduled Operator", true);
    store.appendConversationMessage({
      issueId, runId, stageId: outcome.stageId, actorType: "conveyor", actorId: "scheduled-operator",
      actorName: "Scheduled Operator", actorTitle: "Conveyor Operator",
      message: `Scheduled retry started from evidence: ${evidenceText}`,
    });
    check.outcomes.set(issueId, {
      outcome: "retried",
      reason: `Scheduled retry ${outcome.status}.`,
      evidence: evidenceText,
    });
    return outcome;
  }

  /** Retries a stopped item: clears its stop label on the source, reconciles it and requeues it. */
  async retry(issueId: string, note: string, username: string, automated = false): Promise<{ status: "started" | "queued"; stageId: string }> {
    const { config, store } = this.#deps;
    if (this.#retrying.has(issueId)) throw new Error("retry already in progress");
    this.#retrying.add(issueId);
    try {
      const issue = store.getIssue(issueId);
      const repository = issue ? config.repositories[issue.repositoryId] : undefined;
      if (!issue || !repository || issue.projectedState === "unlisted") throw new Error("issue not found");
      if (store.repositoryPause(issue.repositoryId)) throw new RepositoryPausedError();
      if (note.length > 4_000) throw new Error("retry note must not exceed 4000 characters");
      const expectedPostMergeClosure = store.hasMergedPullRequest(issueId);
      if ((issue.sourceState !== "open" && !(issue.sourceState === "closed" && expectedPostMergeClosure)) ||
        !issue.labels.includes(config.labels.enrollment)) {
        throw new Error("issue is closed or has left Conveyor");
      }
      if (this.#deps.hasLiveRun(issueId)) {
        throw new Error("issue is already running");
      }
      const pipeline = config.pipelines[repository.pipeline];
      if (!pipeline) throw new Error("issue pipeline is not configured");
      const live = await this.#deps.source.getIssue(repository.address, issue.sourceNumber);
      const evaluated = evaluateIssueState({
        sourceState: live.state,
        sourceLabels: live.labels,
        labels: config.labels,
        stages: pipeline.stages.map((stage) => stage.id),
        expectedPostMergeClosure,
      });
      const stoppedStates = new Set(["blocked", "error", "needs-intervention"]);
      if (live.number !== issue.sourceNumber ||
        (live.state !== "open" && !(live.state === "closed" && expectedPostMergeClosure)) || evaluated.mode !== "stopped" ||
        !evaluated.state || !stoppedStates.has(evaluated.state) || !evaluated.stage ||
        evaluated.state !== issue.projectedState || evaluated.stage !== issue.projectedStage ||
        !this.canRetry(issueId)) {
        throw new Error("issue state changed or is inconsistent; refresh before retrying");
      }

      const route = this.#route(issue, pipeline.stages.map((stage) => stage.id));
      if (!route) throw new Error("issue state changed or is inconsistent; refresh before retrying");
      const stageId = route.stageId;
      const sourceStageLabel = config.labels.stageTemplate.replace("{stage}", evaluated.stage);
      const destinationStageLabel = config.labels.stageTemplate.replace("{stage}", stageId);
      const conveyorLabels = live.labels.filter((label) =>
        (label === config.labelPrefix ||
          label.startsWith(`${config.labelPrefix}:`) ||
          label === config.labels.metadata.noSplit) &&
        label !== config.labels.states[evaluated.state!],
      ).map((label) => label === sourceStageLabel ? destinationStageLabel : label);
      if (!conveyorLabels.includes(destinationStageLabel)) conveyorLabels.push(destinationStageLabel);
      const mutation = store.beginSourceMutation({
        idempotencyKey: `web-retry:${issueId}:${randomUUID()}`,
        source: repository.source,
        operation: "issue.labels.retry",
        request: {
          issueId, issueNumber: issue.sourceNumber, stoppedState: evaluated.state,
          stoppedStageId: evaluated.stage, retryStageId: stageId, retryFeedback: route.feedback, labels: conveyorLabels,
        },
      });
      try {
        await this.#deps.fencedSource(issue.repositoryId).replaceConveyorLabels(
          repository.address,
          issue.sourceNumber,
          conveyorLabels,
          [config.labels.metadata.noSplit, config.labels.metadata.paused],
        );
      } catch (error) {
        if (error instanceof RepositoryPausedError) throw error;
        store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
        throw error;
      }

      // Reconciliation runs the roll-up pass. Keep the durable retry marker in
      // place before it observes the cleared stop label, or it can advance this
      // parent to an unfinished child's later stage instead of retrying child
      // creation.
      if (store.listChildren(issueId).length > 0 && this.#deps.stageCreatesChildren(issue.repositoryId, stageId)) {
        const stage = store.getStageState(issueId);
        if (stage?.stageId === stageId) {
          store.setStageState({ ...stage, status: "retry-ready", configHash: config.hash });
        }
      }

      // A retry is a deliberate fresh attempt, so only failures observed after it may form a repeat.
      store.executions().resetCiFailureWindow(issueId);

      if (note.trim()) {
        store.appendConversationMessage({
          issueId, runId: null, stageId, actorType: automated ? "conveyor" : "user", actorId: automated ? "scheduled-operator" : username,
          actorName: username, actorTitle: automated ? "Conveyor Operator" : null, message: note.trim(),
        });
      }
      await this.#deps.reconcile(issue.repositoryId, issue.sourceNumber);
      const refreshed = store.getIssue(issueId);
      if (!refreshed || refreshed.projectedStage !== stageId || refreshed.projectedState !== "active") {
        throw new Error("retry target did not reconcile; refresh before retrying");
      }
      if (route.feedback === null) store.completeSourceMutation(mutation.id, { labels: conveyorLabels });
      if (refreshed?.queueRank === null) store.setQueueRank(issueId, store.nextQueueRank());
      store.events().append("item.requeued", { reason: "retry" }, { issueId });
      await this.#deps.eventsSettled();
      const status = this.#deps.isRunning(issueId) ? "started" : "queued";
      store.appendConversationMessage({
        issueId, runId: null, stageId, actorType: "conveyor", actorId: "conveyor",
        actorName: "Conveyor", actorTitle: "Orchestrator",
        message: status === "started" ? `Started ${stageId} after retry.` : `Queued ${stageId} after retry. The existing worktree and run history are retained.`,
      });
      return { status, stageId };
    } finally {
      this.#retrying.delete(issueId);
    }
  }
}
