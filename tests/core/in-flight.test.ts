import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inFlightAdmission, inFlightHolders, inFlightInterval } from "../../src/core/in-flight";
import { ConveyorStore } from "../../src/db/store";

const directories: string[] = [];
const stages = ["refinement", "implementation", "review", "merge", "release"].map((id) => ({ id }));

async function setup(): Promise<{ store: ConveyorStore; database: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-in-flight-"));
  directories.push(directory);
  const database = path.join(directory, "conveyor.sqlite");
  const store = await ConveyorStore.open(database);
  store.upsertRepository({
    id: "repo",
    configName: "repo",
    source: "github",
    address: "owner/repo",
    folder: "repository",
    configHash: "hash",
  });
  return { store, database };
}

function addItem(store: ConveyorStore, input: { id: string; number: number; stage: string; status: string; sourceState?: "open" | "closed" }): void {
  store.upsertIssue({
    id: input.id,
    repositoryId: "repo",
    sourceNumber: input.number,
    sourceUrl: `https://example.test/${input.number}`,
    title: `Item ${input.number}`,
    body: "",
    sourceState: input.sourceState ?? "open",
    labels: ["conveyor"],
    sourceUpdatedAt: "2026-10-19T00:00:00.000Z",
  });
  store.activateEnrollment(input.id);
  store.setIssueProjection(input.id, { stage: input.stage, state: "active", warning: null });
  store.setStageState({
    issueId: input.id,
    stageId: input.stage,
    status: input.status,
    feedbackCycle: 0,
    configHash: "hash",
  });
}

function holders(store: ConveyorStore): number[] {
  const interval = inFlightInterval(stages, { limit: 2, from: "implementation" }, 3)!;
  return inFlightHolders({ store, repositoryId: "repo", stages, interval })
    .map((issue) => issue.sourceNumber)
    .sort((left, right) => left - right);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("inFlightHolders", () => {
  test("keeps leaf items through merge across stops and a database restart, then releases them", async () => {
    const { store, database } = await setup();
    addItem(store, { id: "implementation", number: 1, stage: "implementation", status: "ready" });
    addItem(store, { id: "ci", number: 2, stage: "review", status: "awaiting-source" });
    addItem(store, { id: "blocked", number: 3, stage: "merge", status: "blocked" });
    addItem(store, { id: "before", number: 4, stage: "refinement", status: "ready" });
    addItem(store, { id: "after", number: 5, stage: "release", status: "ready" });
    addItem(store, { id: "paused", number: 6, stage: "implementation", status: "paused" });
    addItem(store, { id: "parent", number: 7, stage: "implementation", status: "ready" });
    addItem(store, { id: "child", number: 8, stage: "refinement", status: "ready" });
    store.replaceRelationships("child", { parentId: "parent", siblingOrder: 0 }, []);

    expect(holders(store)).toEqual([1, 2, 3]);
    store.close();

    const restarted = await ConveyorStore.open(database);
    expect(holders(restarted)).toEqual([1, 2, 3]);

    restarted.setStageState({ issueId: "implementation", stageId: "merge", status: "done", feedbackCycle: 0, configHash: "hash" });
    restarted.setStageState({ issueId: "ci", stageId: "refinement", status: "ready", feedbackCycle: 0, configHash: "hash" });
    expect(holders(restarted)).toEqual([3]);

    restarted.endActiveEnrollment("blocked", "offboarded");
    expect(holders(restarted)).toEqual([]);
    restarted.close();
  });

  test("releases a rejected item, retains slots through a repository pause, and counts a pending transition's target", async () => {
    const { store } = await setup();
    addItem(store, { id: "rejected", number: 1, stage: "review", status: "ready" });
    addItem(store, { id: "stays", number: 2, stage: "review", status: "awaiting-source" });
    addItem(store, { id: "entering", number: 3, stage: "refinement", status: "ready" });
    store.setIssueProjection("rejected", { stage: "review", state: "rejected", warning: null });

    expect(holders(store)).toEqual([2]);

    store.pauseRepository("repo", "operator", null);
    expect(holders(store)).toEqual([2]);

    store.beginStageTransition({
      id: "pending-1",
      issueId: "entering",
      fromStage: "refinement",
      toStage: "implementation",
      kind: "advance",
      sourceMutationId: null,
      detail: {} as never,
    });
    expect(holders(store)).toEqual([2, 3]);
    store.close();
  });
});

describe("inFlightAdmission", () => {
  const interval = { limit: 1, fromIndex: 1, mergeIndex: 3 };
  const admit = (store: ConveyorStore, issueId: string, targetStageId: string) =>
    inFlightAdmission({ store, repositoryId: "repo", stages, interval, issueId, targetStageId });

  test("refuses entry into the from stage at the limit, naming the holders, and only for that stage", async () => {
    const { store } = await setup();
    addItem(store, { id: "holder", number: 4, stage: "review", status: "awaiting-source" });
    addItem(store, { id: "waiter", number: 5, stage: "refinement", status: "ready" });

    expect(admit(store, "waiter", "implementation")).toBe("Waiting for an in-progress slot in repo: #4");
    expect(admit(store, "waiter", "review")).toBeNull();
    store.close();
  });

  test("admits an item that already holds a slot and any item while a slot is free", async () => {
    const { store } = await setup();
    addItem(store, { id: "holder", number: 4, stage: "review", status: "awaiting-source" });
    expect(admit(store, "holder", "implementation")).toBeNull();

    store.setStageState({ issueId: "holder", stageId: "release", status: "ready", feedbackCycle: 0, configHash: "hash" });
    addItem(store, { id: "waiter", number: 5, stage: "refinement", status: "ready" });
    expect(admit(store, "waiter", "implementation")).toBeNull();
    store.close();
  });

  test("a pending transition into the from stage reserves the slot", async () => {
    const { store } = await setup();
    addItem(store, { id: "first", number: 6, stage: "refinement", status: "ready" });
    addItem(store, { id: "second", number: 7, stage: "refinement", status: "ready" });
    store.beginStageTransition({
      id: "pending-1", issueId: "first", fromStage: "refinement", toStage: "implementation",
      kind: "advance", sourceMutationId: null, detail: {} as never,
    });

    expect(admit(store, "second", "implementation")).toBe("Waiting for an in-progress slot in repo: #6");
    expect(admit(store, "first", "implementation")).toBeNull();
    store.close();
  });

  test("waiters persist across a restart and are not holders", async () => {
    const { store, database } = await setup();
    addItem(store, { id: "holder", number: 4, stage: "review", status: "awaiting-source" });
    addItem(store, { id: "waiter", number: 5, stage: "refinement", status: "waiting-in-flight" });
    store.close();

    const restarted = await ConveyorStore.open(database);
    expect(restarted.getStageState("waiter")?.status).toBe("waiting-in-flight");
    expect(holders(restarted)).toEqual([4]);
    expect(admit(restarted, "waiter", "implementation")).toBe("Waiting for an in-progress slot in repo: #4");
    restarted.close();
  });
});
