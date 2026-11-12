// Admission (#676): whether Conveyor admits work at all (a drain), per repository (a pause) and per
// item (the paused label). A drain lets running work finish; a repository pause fences its source
// writes; an item's pause is a label on the source, so GitHub stays authoritative.

import { randomUUID } from "node:crypto";

import type { ConveyorConfig } from "../config/load";
import { RepositoryPausedError } from "../core/repository-pause";
import type { ConversationStore, EventStore, ItemStore, JournalStore } from "../db/ports";
import type { StoredIssue } from "../db/store";
import { log, type LogFields } from "../log/logger";
import { withCallSource } from "../source/calls";
import type { ItemMarkers, ItemReader } from "../source/types";
import type { DrainState } from "./dashboard-sources";

type Repository = ConveyorConfig["repositories"][string];

export interface AdmissionDeps {
  config: {
    labels: Pick<ConveyorConfig["labels"], "enrollment" | "metadata">;
    labelPrefix: string;
    repositories: Readonly<Record<string, Repository>>;
  };
  store: Pick<ItemStore,
    | "getIssue" | "repositoryPause" | "pauseRepository" | "resumeRepository" | "listRecoveryCandidates"
    | "listPendingPauseRelabels" | "completePauseRelabel"
  >
    & Pick<JournalStore, "beginSourceMutation" | "completeSourceMutation" | "failSourceMutation">
    & Pick<ConversationStore, "appendConversationMessage">
    & EventStore;
  source: Pick<ItemReader, "getIssue">;
  /** The item source fenced at the repository's pause. */
  fencedSource: (repositoryId: string) => Pick<ItemReader, "getIssue"> & Pick<ItemMarkers, "replaceConveyorLabels">;
  /** The stages running now, by item. */
  running: () => Iterable<[issueId: string, stageId: string]>;
  /** Whether the item's stage is running in this process. */
  isRunning: (issueId: string) => boolean;
  schedule: () => void;
  /** Resolves once committed events are published and the scheduling they asked for ran. */
  eventsSettled: () => Promise<void>;
  /** Reads the one item from the source again. */
  reconcile: (repositoryId: string, sourceNumber: number) => Promise<void>;
  /** Tells the runs that must not go on to stop. */
  interruptIneligibleRuns: () => void;
  /** Resolves one closed source item whose cleanup a pause deferred. */
  recoverClosedItem: (repositoryId: string, issue: StoredIssue) => Promise<void>;
  /** Log correlation for an item. */
  itemFields: (issueId: string) => LogFields;
}

/** Drains, repository pauses and item pauses. */
export class Admission {
  readonly #deps: AdmissionDeps;
  /** While set, no new work is admitted; work already running finishes. */
  #drain: DrainState | null = null;

  constructor(deps: AdmissionDeps) {
    this.#deps = deps;
  }

  /** The running drain, with the upgrade it waits for; null while work is admitted. */
  get current(): DrainState | null {
    return this.#drain;
  }

  /** Stops admitting new work; running work continues. Idempotent: the first reason is kept. */
  drain(reason: string, upgrade: { targetVersion: string; releaseTag: string } | null = null): { since: string; reason: string } {
    if (!this.#drain) {
      this.#drain = { since: new Date().toISOString(), reason, upgrade };
      this.#deps.store.events().append("admission.paused", {});
      log.info("Admission paused: draining", { reason });
      for (const [issueId, stageId] of this.#deps.running()) {
        log.info("Stage waiting during drain", { ...this.#deps.itemFields(issueId), stage: stageId });
      }
    }
    return { since: this.#drain.since, reason: this.#drain.reason };
  }

  /** Admits new work again after a drain; false when no drain was in effect. */
  resumeAdmission(): boolean {
    if (!this.#drain) return false;
    this.#drain = null;
    this.#deps.store.events().append("admission.resumed", {});
    log.info("Admission resumed");
    this.#deps.schedule();
    return true;
  }

  /** The running drain, or null while work is admitted. */
  draining(): { since: string; reason: string } | null {
    return this.#drain ? { since: this.#drain.since, reason: this.#drain.reason } : null;
  }

  /** Pauses future repository work without changing its configured plan or any item projection. */
  pauseRepository(repositoryId: string, reason: string, actor: string): { pausedAt: string } {
    if (!this.#deps.config.repositories[repositoryId]) throw new Error("repository not found");
    const pause = this.#deps.store.pauseRepository(repositoryId, actor, reason.trim() || null);
    log.info("Repository paused", { repository: repositoryId, actor });
    return { pausedAt: pause.pausedAt };
  }

  /** Re-admits retained work without changing individual item enrollment. */
  async resumeRepository(repositoryId: string): Promise<{ resumedAt: string }> {
    const { config, store } = this.#deps;
    if (!config.repositories[repositoryId]) throw new Error("repository not found");
    store.resumeRepository(repositoryId);
    const resumedAt = new Date().toISOString();
    // A paused cleanup has already recorded its source-mutation intent. Retry it immediately
    // after the write fence lifts instead of making a just-closed item wait for the hourly pass.
    await withCallSource("command", async () => {
      for (const issue of store.listRecoveryCandidates(repositoryId, resumedAt)) {
        await this.#deps.recoverClosedItem(repositoryId, issue);
      }
    });
    this.#deps.schedule();
    log.info("Repository resumed", { repository: repositoryId });
    return { resumedAt };
  }

  /**
   * Pauses an item by adding the paused label: Conveyor stops scheduling it and interrupts its
   * running agent; its labels, stage, worktree and history are kept.
   */
  async pauseItem(issueId: string, actor: string): Promise<{ stageId: string | null }> {
    const { issue, repository, live } = await this.#liveEnrolledIssue(issueId);
    const pausedLabel = this.#deps.config.labels.metadata.paused;
    if (live.labels.includes(pausedLabel)) throw new Error("the item is already paused");
    const labels = [...this.#conveyorLabels(live.labels), pausedLabel];
    await this.#replaceLabelsRecorded(issue, repository, "issue.labels.pause", labels);
    await this.#deps.reconcile(issue.repositoryId, issue.sourceNumber);
    this.#deps.interruptIneligibleRuns();
    this.#deps.store.appendConversationMessage({
      issueId, runId: null, stageId: issue.projectedStage, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: `Paused by ${actor}. Its stage, worktree and history are kept.`,
    });
    log.info("Item paused", { ...this.#deps.itemFields(issueId), stage: issue.projectedStage ?? undefined, actor });
    return { stageId: issue.projectedStage };
  }

  /** Resumes a paused item by removing the paused label; reports whether its stage started or queued. */
  async resumeItem(issueId: string, actor: string): Promise<{ status: "started" | "queued"; stageId: string | null }> {
    const { store } = this.#deps;
    const { issue, repository, live } = await this.#liveEnrolledIssue(issueId);
    const pausedLabel = this.#deps.config.labels.metadata.paused;
    if (!live.labels.includes(pausedLabel)) throw new Error("the item is not paused");
    const labels = this.#conveyorLabels(live.labels).filter((label) => label !== pausedLabel);
    await this.#replaceLabelsRecorded(issue, repository, "issue.labels.resume", labels);
    await this.#deps.reconcile(issue.repositoryId, issue.sourceNumber);
    store.events().append("item.requeued", { reason: "resume" }, { issueId });
    await this.#deps.eventsSettled();
    const refreshed = store.getIssue(issueId);
    const status = this.#deps.isRunning(issueId) ? "started" : "queued";
    store.appendConversationMessage({
      issueId, runId: null, stageId: refreshed?.projectedStage ?? null, actorType: "conveyor", actorId: "conveyor",
      actorName: "Conveyor", actorTitle: "Orchestrator", message: `Resumed by ${actor}; ${status === "started" ? "its stage started" : "its stage is queued"}.`,
    });
    log.info("Item resumed", { ...this.#deps.itemFields(issueId), stage: refreshed?.projectedStage ?? undefined, actor, status });
    return { status, stageId: refreshed?.projectedStage ?? null };
  }

  /**
   * Items paused the old way (enrollment label removed) get the enrollment and paused labels once, so
   * they stay paused now that removing the enrollment label means leaving Conveyor.
   */
  async relabelOldPausedItems(repositoryId: string): Promise<void> {
    const { config, store } = this.#deps;
    const repository = config.repositories[repositoryId];
    if (!repository) return;
    for (const issue of store.listPendingPauseRelabels().sort((left, right) => left.sourceNumber - right.sourceNumber)) {
      if (issue.repositoryId !== repositoryId) continue;
      const live = await this.#deps.fencedSource(repositoryId).getIssue(repository.address, issue.sourceNumber);
      if (live.state === "open") {
        const labels = [...new Set([...this.#conveyorLabels(live.labels), config.labels.enrollment, config.labels.metadata.paused])].sort((left, right) => left.localeCompare(right));
        await this.#replaceLabelsRecorded(issue, repository, "issue.labels.upgrade-pause", labels);
      }
      store.completePauseRelabel(issue.id);
    }
  }

  /** An open item known to Conveyor (enrolled or paused), with its live source state. */
  async #liveEnrolledIssue(issueId: string) {
    const { config, store } = this.#deps;
    const issue = store.getIssue(issueId);
    const repository = issue ? config.repositories[issue.repositoryId] : undefined;
    if (!issue || !repository || issue.projectedState === "unlisted") throw new Error("item not found");
    this.#assertRepositoryActive(issue.repositoryId);
    const live = await this.#deps.source.getIssue(repository.address, issue.sourceNumber);
    if (live.state !== "open") throw new Error("the item is closed");
    if (!live.labels.includes(config.labels.enrollment)) throw new Error("the item has left Conveyor (it has no conveyor label)");
    return { issue, repository, live };
  }

  #conveyorLabels(labels: readonly string[]): string[] {
    const prefix = this.#deps.config.labelPrefix;
    return labels.filter((label) =>
      label === prefix || label.startsWith(`${prefix}:`) || label === this.#deps.config.labels.metadata.noSplit,
    );
  }

  async #replaceLabelsRecorded(issue: StoredIssue, repository: Repository, operation: string, labels: string[]): Promise<void> {
    const { store } = this.#deps;
    this.#assertRepositoryActive(issue.repositoryId);
    const mutation = store.beginSourceMutation({
      idempotencyKey: `${operation}:${randomUUID()}`,
      source: repository.source,
      operation,
      request: { issueId: issue.id, issueNumber: issue.sourceNumber, labels },
    });
    try {
      await this.#deps.fencedSource(issue.repositoryId).replaceConveyorLabels(
        repository.address,
        issue.sourceNumber,
        labels,
        [this.#deps.config.labels.metadata.noSplit],
      );
      store.completeSourceMutation(mutation.id, { labels });
    } catch (error) {
      if (error instanceof RepositoryPausedError) throw error;
      store.failSourceMutation(mutation.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Rejects an operation that would mutate the paused repository's source. */
  #assertRepositoryActive(repositoryId: string): void {
    if (this.#deps.store.repositoryPause(repositoryId)) throw new RepositoryPausedError();
  }
}
