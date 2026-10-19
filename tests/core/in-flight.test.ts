import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { inFlightHolders, inFlightInterval } from "../../src/core/in-flight";
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
});
