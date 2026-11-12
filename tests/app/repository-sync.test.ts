import { afterEach, describe, expect, test } from "bun:test";

import { labelDefinitions, RepositorySync } from "../../src/app/repository-sync";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import type { EventType, StoredEvent } from "../../src/events/catalogue";
import type { SourceIssue } from "../../src/source/types";
import { itemWorld, type ItemWorld } from "../support/item-world";

let opened: ItemWorld | null = null;
afterEach(async () => { await opened?.close(); opened = null; });

async function setup(options: { webhook?: boolean } = {}) {
  const world = await itemWorld();
  opened = world;
  const calls = {
    purged: [] as string[], scheduled: 0, refreshed: [] as string[][], relationships: [] as Array<number[] | null>,
    forgotten: [] as number[][], interrupts: 0, resumedPurges: 0, labels: 0, registered: 0, created: [] as string[],
    recovered: [] as string[], scratch: 0, answers: 0, ciEvents: [] as string[], listings: [] as Array<string | undefined>,
  };
  const failures = { listing: null as Error | null, labels: null as Error | null };
  const source = {
    ...world.items.client,
    listIssues: async (_address: string, listing?: { since?: string }) => {
      calls.listings.push(listing?.since);
      if (failures.listing) throw failures.listing;
      return [...world.items.issues.values()].map((issue) => ({ ...issue, labels: [...issue.labels] }));
    },
    getIssueProvenance: async () => ({ enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } }),
    ensureLabels: async () => {
      calls.labels += 1;
      if (failures.labels) throw failures.labels;
    },
    createIssue: async (input: { title: string; body: string; labels: readonly string[] }): Promise<SourceIssue> => {
      calls.created.push(input.title);
      return world.items.add(world.items.issues.size + 1, [...input.labels]);
    },
    repositoryVisibility: async () => "private" as const,
    getIssueFieldValues: async () => ({}),
    forgetRepository: () => {},
  };
  const sync = new RepositorySync({
    config: world.config,
    store: world.store,
    source,
    fencedSource: () => source,
    trust: { isTrusted: async () => true },
    webhooks: {
      url: () => options.webhook ? "https://conveyor.example.com/webhook" : null,
      register: async () => { calls.registered += 1; },
      redeliverMissed: async () => 0,
      ping: async () => true,
    },
    purge: async (issueId) => { calls.purged.push(issueId); },
    resumePurges: () => { calls.resumedPurges += 1; },
    interruptIneligibleRuns: () => { calls.interrupts += 1; return []; },
    runsEnded: async () => {},
    schedule: () => { calls.scheduled += 1; },
    refreshStatusComments: (issueIds) => { calls.refreshed.push([...issueIds]); },
    restoreFeedback: () => {},
    relabelOldPausedItems: async () => {},
    reconcileRelationships: async (_repositoryId, _address, scope) => { calls.relationships.push(scope === null ? null : [...scope]); },
    forgetRelationships: (_repositoryId, numbers) => { calls.forgotten.push([...numbers]); },
    backfillCiIndicators: async () => {},
    applyCiEvent: async (_repositoryId, event) => { calls.ciEvents.push(event.type); },
    wakeClearedFollowUps: () => {},
    restorePendingStatus: () => {},
    recoverClosedItem: async (_repositoryId, issue) => { calls.recovered.push(issue.id); },
    recoverPendingScheduledAnswers: () => { calls.answers += 1; },
    recoverWorkspaceScratch: async () => { calls.scratch += 1; },
    eventsSettled: async () => {},
    shuttingDown: () => false,
    itemFields: (issueId) => ({ item: issueId }),
  });
  const events = (type: EventType) => world.store.events().read({ type }).map((event) => event.payload);
  return { world, sync, calls, failures, events };
}

let sequence = 0;
function observation<T extends EventType>(type: T, payload: StoredEvent<T>["payload"]): StoredEvent {
  sequence += 1;
  return {
    seq: sequence, type, class: "ingest", source: "github", causationSeq: null, occurredAt: new Date().toISOString(),
    repositoryId: "repo", issueId: null, actor: { kind: "webhook", id: `delivery-${sequence}` }, correlationId: null, payload,
  } as StoredEvent;
}

describe("repository locks", () => {
  test("syncs of one repository run one at a time and a sync inside one joins it", async () => {
    const { sync } = await setup();
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = sync.withRepositoryLock("repo", async () => {
      order.push("first");
      await sync.withRepositoryLock("repo", async () => { order.push("nested"); });
      await held;
      order.push("first done");
    });
    const second = sync.withRepositoryLock("repo", async () => { order.push("second"); });
    const other = sync.withRepositoryLock("other", async () => { order.push("other"); });
    await other;
    await Bun.sleep(5);
    expect(order).toEqual(["first", "nested", "other"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "nested", "other", "first done", "second"]);
  });

  test("work started outside the locks waits for the repository like any other sync", async () => {
    const { sync } = await setup();
    const order: string[] = [];
    let inner: Promise<void> | undefined;
    await sync.withRepositoryLock("repo", async () => {
      inner = sync.outsideLocks(() => sync.withRepositoryLock("repo", async () => { order.push("outside"); }));
      await Bun.sleep(5);
      order.push("held");
    });
    await inner;
    expect(order).toEqual(["held", "outside"]);
  });
});

describe("reconciling", () => {
  test("a full pass records the source's items, reads all relationships and marks the service reconciled", async () => {
    const { world, sync, calls, events } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    expect(sync.ready()).toBe(false);
    await sync.reconcileAll();
    expect(world.store.getIssueByNumber("repo", 1)).toMatchObject({ projectedStage: "implementation" });
    expect(calls.listings).toEqual([undefined]);
    expect(calls.relationships).toEqual([null]);
    expect(events("repository.reconciled")).toEqual([{ issueNumbers: null }]);
    expect(events("service.reconciled")).toEqual([{ failed: 0 }]);
    expect(world.store.repositoryTrustStatus("repo")).toMatchObject({ visibility: "private" });
    expect(sync.lastReconciledAt).not.toBeNull();
    expect(sync.ready()).toBe(true);
    expect(calls.resumedPurges).toBe(1);
    expect(calls.answers).toBe(1);
  });

  test("a failed pass keeps the repository's error until a pass succeeds", async () => {
    const { sync, failures, events } = await setup();
    failures.listing = new Error("GitHub is down");
    await sync.reconcileAll();
    await sync.reconcileAll();
    expect(sync.reconcileErrors.get("repo")).toBe("GitHub is down");
    expect(sync.repositoryReady("repo")).toBe(false);
    expect(sync.ready()).toBe(false);
    expect(sync.startupStatus()).toEqual({ state: "degraded", repository: "repo", phase: null });
    failures.listing = null;
    await sync.reconcileAll();
    expect(sync.repositoryReady("repo")).toBe(true);
    expect(events("repository.healthChanged")).toEqual([
      { check: "reconcile", healthy: false },
      { check: "reconcile", healthy: true },
    ]);
  });

  test("a periodic pass skips a repository whose webhook Conveyor manages and records nothing", async () => {
    const { sync, calls, events } = await setup({ webhook: true });
    await sync.reconcileAll({ skipFresh: true });
    expect(calls.listings).toEqual([]);
    expect(events("service.reconciled")).toEqual([]);
    expect(calls.resumedPurges).toBe(1);
  });

  test("a webhook repository lists only what changed: since its last listing, or after a restart its newest stored change", async () => {
    const { world, sync, calls } = await setup({ webhook: true });
    await sync.reconcileAll();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    await sync.reconcileAll();
    expect(calls.listings[0]).toBeUndefined();
    expect(Date.parse(calls.listings[1]!)).toBeGreaterThan(Date.now() - 3 * 60_000);

    const restarted = await setup({ webhook: true });
    restarted.world.items.add(1, ["conveyor", "conveyor:implementation"]);
    restarted.world.seed(1, { stage: "implementation", state: "active" });
    await restarted.sync.reconcileAll();
    expect(restarted.calls.listings).toEqual([new Date(Date.parse("2026-10-17T00:00:00Z") - 2 * 60_000).toISOString()]);
    await world.close();
  });

  test("reading named items requests each once and records only them", async () => {
    const { world, sync, calls, events } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    world.items.add(2, ["conveyor", "conveyor:review"]);
    await sync.reconcileRepository("repo", { only: [2, 2] });
    expect(world.store.getIssueByNumber("repo", 1)).toBeNull();
    expect(world.store.getIssueByNumber("repo", 2)).toMatchObject({ projectedStage: "review" });
    expect(calls.listings).toEqual([]);
    expect(calls.relationships).toEqual([[2]]);
    expect(events("repository.reconciled")).toEqual([{ issueNumbers: [2] }]);
  });

  test("a supplied snapshot is recorded with no read", async () => {
    const { world, sync, calls } = await setup();
    const issue = world.items.add(3, ["conveyor", "conveyor:implementation"]);
    await sync.reconcileSnapshot("repo", issue);
    expect(world.store.getIssueByNumber("repo", 3)).toMatchObject({ projectedStage: "implementation" });
    expect(calls.listings).toEqual([]);
  });
});

describe("an operator's sync", () => {
  test("reads everything again, joins a sync already running and is refused while paused", async () => {
    const { world, sync, calls } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    const first = sync.syncRepository("repo");
    expect(sync.syncRepository("repo")).toBe(first);
    expect(await first).toEqual({ issues: 1, failed: false });
    expect(calls.listings).toEqual([undefined]);
    expect(calls.scheduled).toBe(1);
    expect(calls.refreshed).toEqual([["issue-1"]]);
    world.store.pauseRepository("repo", "maintainer", null);
    expect(() => sync.syncRepository("repo")).toThrow(RepositoryPausedError);
  });
});

describe("creating an item", () => {
  test("rejects an empty title or an unknown repository", async () => {
    const { sync } = await setup();
    await expect(sync.createIssue({ repository: "repo", title: "  ", body: "" })).rejects.toThrow("the issue title must not be empty");
    await expect(sync.createIssue({ repository: "missing", title: "New", body: "" })).rejects.toThrow("repository missing is not onboarded");
  });

  test("enrolls the item, records it from the response and returns the first result for a repeated key", async () => {
    const { world, sync, calls, events } = await setup();
    const created = sync.createIssue({ repository: "owner/my-app", title: "New work", body: "", idempotencyKey: "key" });
    expect(sync.createIssue({ repository: "repo", title: "New work", body: "", idempotencyKey: "key" })).toBe(created);
    expect(await created).toEqual({ issueId: "issue-1", number: 1, url: "https://example.com/owner/my-app/issues/1" });
    expect(calls.created).toEqual(["New work"]);
    expect(world.store.getIssueByNumber("repo", 1)).toMatchObject({ labels: ["conveyor"] });
    expect(events("repository.reconciled")).toEqual([{ issueNumbers: [1] }]);
    expect(calls.scheduled).toBe(1);
  });
});

describe("onboarding and the startup pass", () => {
  test("labels the repository and registers its webhook; a failure is reported once and cleared", async () => {
    const { world, sync, calls, failures, events } = await setup();
    const repository = world.config.repositories.repo!;
    failures.labels = new Error("forbidden");
    await sync.onboardRepository("repo", repository);
    await sync.onboardRepository("repo", repository);
    expect(sync.onboardingErrors.get("repo")).toBe("forbidden");
    failures.labels = null;
    await sync.onboardRepository("repo", repository);
    expect(sync.onboardingErrors.size).toBe(0);
    expect(calls.registered).toBe(1);
    expect(events("repository.healthChanged")).toEqual([
      { check: "onboarding", healthy: false },
      { check: "onboarding", healthy: true },
    ]);
  });

  test("the labels cover enrollment, every stage, every state and the metadata labels", async () => {
    const { world } = await setup();
    expect(labelDefinitions(world.config, "repo").map((label) => label.name)).toEqual([
      "conveyor", "conveyor:implementation", "conveyor:review",
      "conveyor:done", "conveyor:blocked", "conveyor:error", "conveyor:needs-intervention",
      "conveyor:closable", "conveyor:no-split", "conveyor:paused",
    ]);
  });

  test("the startup pass onboards and reconciles each repository, then reports ready", async () => {
    const { sync, calls, events } = await setup();
    sync.prepareStartupPass();
    expect(sync.startupStatus()).toEqual({ state: "starting", repository: "repo", phase: "waiting" });
    expect(sync.repositoryReady("repo")).toBe(false);
    sync.beginStartupPass();
    expect(sync.busy).toBe(true);
    const deadline = Date.now() + 5_000;
    while (sync.startupRunning && Date.now() < deadline) await Bun.sleep(5);
    expect(sync.startupStatus()).toEqual({ state: "ready", repository: null, phase: null });
    expect(sync.ready()).toBe(true);
    expect(calls.scratch).toBe(1);
    expect(calls.labels).toBe(1);
    expect(calls.scheduled).toBe(2);
    expect(events("service.reconciled")).toEqual([{ failed: 0 }]);
  });
});

describe("observations", () => {
  test("a deleted item is purged at once, with no read", async () => {
    const { world, sync, calls } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    const id = world.seed(1, { stage: "implementation", state: "active" });
    sync.reactToObservation(observation("itemSource.itemChanged", { repository: "owner/my-app", number: 1, action: "deleted", pullRequest: false, item: null, actors: null }));
    expect(calls.purged).toEqual([id]);
    await sync.webhooksSettled();
    expect(calls.ciEvents).toEqual([]);
  });

  test("a delivered item is applied without a read, and an older delivery changes nothing", async () => {
    const { world, sync, calls, events } = await setup();
    const issue = world.items.add(1, ["conveyor", "conveyor:review"]);
    const actors = { enrollment: { login: "maintainer" }, title: "unchanged", body: "unchanged" } as const;
    sync.reactToObservation(observation("itemSource.itemChanged", { repository: "owner/my-app", number: 1, action: "labeled", pullRequest: false, item: issue, actors }));
    await sync.webhooksSettled();
    expect(world.store.getIssueByNumber("repo", 1)).toMatchObject({ projectedStage: "review" });
    expect(calls.listings).toEqual([]);
    expect(calls.ciEvents).toEqual(["itemSource.itemChanged"]);
    expect(calls.refreshed).toEqual([["issue-1"]]);
    sync.reactToObservation(observation("itemSource.itemChanged", {
      repository: "owner/my-app", number: 1, action: "labeled", pullRequest: false,
      item: { ...issue, labels: ["conveyor", "conveyor:implementation"], updatedAt: "2026-01-01T00:00:00Z" }, actors,
    }));
    await sync.webhooksSettled();
    expect(world.store.getIssueByNumber("repo", 1)).toMatchObject({ projectedStage: "review" });
    expect(events("repository.reconciled")).toEqual([{ issueNumbers: [1] }]);
  });

  test("changed relationships forget what was read and reconcile the named items once", async () => {
    const { world, sync, calls, events } = await setup();
    world.items.add(1, ["conveyor", "conveyor:implementation"]);
    sync.reactToObservation(observation("itemSource.relationsChanged", { repository: "owner/my-app", numbers: [1] }));
    await sync.webhooksSettled();
    expect(calls.forgotten).toEqual([[1]]);
    expect(calls.relationships).toEqual([[1]]);
    expect(events("repository.reconciled")).toEqual([{ issueNumbers: [1] }]);
    expect(calls.refreshed).toEqual([["issue-1"]]);
  });

  test("an observation of an unconfigured repository changes nothing", async () => {
    const { sync, calls } = await setup();
    sync.reactToObservation({ ...observation("itemSource.relationsChanged", { repository: "owner/other", numbers: [1] }), repositoryId: "other" });
    await sync.webhooksSettled();
    expect(calls.ciEvents).toEqual([]);
  });
});
