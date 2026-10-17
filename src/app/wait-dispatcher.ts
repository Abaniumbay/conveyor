// Wakes parked tasks when an event they wait for arrives. A wake only makes the item due: the task
// runs again, reads GitHub once and either passes or waits again with a fresh fallback.

import { isEventOf, type StoredEvent } from "../events/catalogue";
import { changeTopic, ciTopic, issueTopic } from "../events/topics";
import type { ExecutionStore } from "../engine/journal";

/** Pull request actions that change what a wait on the pull request decides. */
const CHANGE_ACTIONS = new Set(["synchronize", "closed", "reopened", "edited", "ready_for_review", "converted_to_draft"]);

export interface WaitDispatcherDependencies {
  journal: Pick<ExecutionStore, "subscribers" | "getCursor">;
  /** The GitHub address of a configured repository, as topics name it. */
  addressOf: (repositoryId: string) => string | null;
  /** The source number of a stored item. */
  numberOf: (issueId: string) => number | null;
  /** Makes a parked item due now. */
  wake: (issueId: string) => void;
}

export class WaitDispatcher {
  readonly #pending = new Set<string>();
  #flushQueued = false;

  constructor(private readonly dependencies: WaitDispatcherDependencies) {}

  /** The topics an event concerns. */
  topicsFor(event: StoredEvent): string[] {
    if (isEventOf(event, "github.ciUpdated")) {
      // Progress does not change what a CI wait decides; only a finished run or suite does.
      return event.payload.completed ? [ciTopic(event.payload.repository, event.payload.sha)] : [];
    }
    if (isEventOf(event, "github.changeUpdated")) {
      return CHANGE_ACTIONS.has(event.payload.action) ? [changeTopic(event.payload.repository, event.payload.number)] : [];
    }
    // A blocker counts once the projection has its new state, so the projection's events wake
    // dependency waits, not the raw delivery.
    if ((isEventOf(event, "item.updated") && event.payload.changed.includes("state")) || isEventOf(event, "item.stageChanged")) {
      const address = event.repositoryId ? this.dependencies.addressOf(event.repositoryId) : null;
      const number = event.issueId ? this.dependencies.numberOf(event.issueId) : null;
      return address && number !== null ? [issueTopic(address, number)] : [];
    }
    return [];
  }

  /** Wakes, once per burst, every item whose current wait subscribes to a topic of `event`. */
  handle(event: StoredEvent): void {
    for (const topic of this.topicsFor(event)) {
      for (const subscriber of this.dependencies.journal.subscribers(topic)) {
        const cursor = this.dependencies.journal.getCursor(subscriber.issueId);
        // A row of an earlier visit of the stage is stale: the current one decides for itself.
        if (cursor?.state !== "pending" || cursor.stageEpoch !== subscriber.stageEpoch) continue;
        this.#pending.add(subscriber.issueId);
      }
    }
    if (this.#pending.size === 0 || this.#flushQueued) return;
    this.#flushQueued = true;
    queueMicrotask(() => this.flush());
  }

  /** Wakes the items collected so far. */
  flush(): void {
    this.#flushQueued = false;
    const items = [...this.#pending];
    this.#pending.clear();
    for (const issueId of items) this.dependencies.wake(issueId);
  }
}
