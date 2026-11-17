import { afterEach, describe, expect, test } from "bun:test";

import { RepositorySync } from "../../src/app/repository-sync";
import { Rollups } from "../../src/app/rollups";
import { Scheduler, type RunningStage } from "../../src/app/scheduler";
import type { EventType, StoredEvent } from "../../src/events/catalogue";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: { world: ItemWorld; scheduler: Scheduler } | null = null;
afterEach(async () => {
  opened?.scheduler.close();
  await opened?.world.close();
  opened = null;
});

/** The real sync, relationship reconciliation, scheduler and store; only the item source is a fake. */
async function setup() {
  const world = await itemWorld();
  const running = new Map<string, RunningStage>();
  const launched: string[] = [];
  const scheduler: Scheduler = new Scheduler({
    config: world.config, store: world.store, running: () => running, shuttingDown: () => false, draining: () => false,
    repositoryReady: () => true, isLightweightStage: () => false, isSkippedStage: () => false, isGateOnlyExecution: () => false,
    hasResumableQuestionExecution: () => false, childCreationRetryQueued: () => false,
    schedulePass: () => { scheduler.schedule(); },
    launch: (issue, candidate) => {
      launched.push(issue.id);
      running.set(issue.id, { repositoryId: issue.repositoryId, stageId: candidate.stageId, lightweight: false, gateOnly: false });
    },
    refreshStatusComments: () => {}, timerFired: () => {},
  });
  opened = { world, scheduler };
  const rollups = new Rollups({
    config: { ...world.config, labelPrefix: world.config.settings.labelPrefix },
    store: world.store, source: world.items.client, fencedSource: () => world.items.client, webhookHealthy: () => false,
    runningIssueIds: () => [], hasLiveRun: () => false, stageCreatesChildren: () => false, childCreationRetryQueued: () => false,
    hasResumableQuestionExecution: () => false, hasWaitingFollowUp: () => false, workspaces: () => ({ remove: async () => {} }),
    reconcile: async (_repositoryId, sourceNumber) => { await world.refresh(sourceNumber); },
    itemFields: (issueId) => ({ item: issueId }),
  });
  const source = {
    ...world.items.client,
    getIssueProvenance: async () => ({ enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }),
    getIssueFieldValues: async () => ({}),
  };
  const deps: ConstructorParameters<typeof RepositorySync>[0] = {
    config: world.config, store: world.store, source: source as never, fencedSource: () => source as never,
    trust: { isTrusted: async () => true },
    webhooks: { url: () => null, register: async () => {}, redeliverMissed: async () => 0, ping: async () => true },
    purge: async () => {}, resumePurges: () => {}, interruptIneligibleRuns: () => [], runsEnded: async () => {},
    schedule: () => { scheduler.schedule(); }, refreshStatusComments: () => {}, restoreFeedback: () => {},
    relabelOldPausedItems: async () => {},
    reconcileRelationships: (repositoryId, address, scope) => rollups.reconcile(repositoryId, address, scope ?? undefined),
    forgetRelationships: (repositoryId, numbers) => { rollups.forget(repositoryId, numbers); },
    backfillCiIndicators: async () => {}, applyCiEvent: async () => {}, wakeClearedFollowUps: () => {}, restorePendingStatus: () => {},
    recoverClosedItem: async () => {}, recoverPendingScheduledAnswers: () => {}, recoverWorkspaceScratch: async () => {},
    eventsSettled: async () => {}, shuttingDown: () => false, itemFields: (issueId) => ({ item: issueId }),
  };
  const sync = new RepositorySync(deps);
  let sequence = 0;
  const deliver = async (number: number, updatedAt?: string) => {
    sequence += 1;
    const item = { ...world.items.issues.get(number)!, ...(updatedAt ? { updatedAt } : {}) };
    sync.reactToObservation({
      seq: sequence, type: "itemSource.itemChanged" as EventType, class: "ingest", source: "github", causationSeq: null,
      occurredAt: new Date().toISOString(), repositoryId: "repo", issueId: null, actor: { kind: "webhook", id: `d-${sequence}` }, correlationId: null,
      payload: {
        repository: "owner/my-app", number, action: "labeled", pullRequest: false, item,
        actors: { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } },
      },
    } as StoredEvent);
    await sync.webhooksSettled();
  };
  /** Blocker #2 is open, queued and ready; item #1 (not stored) is blocked by it on the source. */
  const blocked = () => {
    world.items.add(2, ["conveyor", "conveyor:implementation"]);
    const blocker = world.seed(2, { stage: "implementation", state: "active" });
    world.store.setQueueRank(blocker, world.store.nextQueueRank());
    world.store.setStageState({ issueId: blocker, stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: world.config.hash });
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    world.items.blockers.set(1, [2]);
    return blocker;
  };
  const satisfied = (number: number) => scheduler.candidates().find((candidate) => candidate.id === `issue-${number}`)?.dependenciesSatisfied;
  return { world, scheduler, running, deliver, launched, blocked, satisfied };
}

describe("an item discovered through a single delivery", () => {
  test("has its dependencies stored and is not started before its blocker is done", async () => {
    const { world, scheduler, running, deliver, launched, blocked, satisfied } = await setup();
    const blocker = blocked();
    await deliver(1);
    expect(world.store.listDependencies("issue-1")).toEqual([blocker]);
    expect(satisfied(1)).toBe(false);
    expect(launched).not.toContain("issue-1");
    // The control: once the blocker is done the same item is selected.
    world.store.upsertIssue({ ...world.store.getIssue(blocker)!, sourceState: "closed" });
    running.delete(blocker);
    scheduler.schedule();
    expect(satisfied(1)).toBe(true);
    expect(launched).toContain("issue-1");
  });

  test("a rediscovered item gets back the dependencies deleted while it was unlisted", async () => {
    const { world, deliver, launched, blocked, satisfied } = await setup();
    const blocker = blocked();
    world.seed(1, { stage: null, state: "unlisted" });
    world.store.replaceRelationships("issue-1", null, []);
    await deliver(1, "2026-10-17T00:30:00Z");
    expect(world.store.getIssueByNumber("repo", 1)).toMatchObject({ projectedStage: "implementation" });
    expect(world.store.listDependencies("issue-1")).toEqual([blocker]);
    expect(satisfied(1)).toBe(false);
    expect(launched).not.toContain("issue-1");
  });
});
