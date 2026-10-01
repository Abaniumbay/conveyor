import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyRollupTransition, applyStageTransition } from "../../src/core/transition";
import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore } from "../../src/engine/journal";

const directories: string[] = [];

async function setup(): Promise<ConveyorStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "conveyor-transition-"));
  directories.push(directory);
  const store = await ConveyorStore.open(path.join(directory, "db.sqlite"));
  store.upsertRepository({
    id: "repo",
    configName: "repo",
    source: "github",
    address: "owner/repo",
    folder: "/srv/repo",
    configHash: "hash",
  });
  store.upsertIssue({
    id: "issue",
    repositoryId: "repo",
    sourceNumber: 7,
    sourceUrl: "https://example.test/7",
    title: "Feature",
    body: "",
    sourceState: "open",
    labels: ["conveyor", "conveyor:implementation", "conveyor:order:2", "backend"],
    sourceUpdatedAt: "2026-01-01T00:00:00Z",
  });
  return store;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const labelConfig = {
  enrollment: "conveyor",
  stageTemplate: "conveyor:{stage}",
  states: {
    done: "conveyor:done",
    blocked: "conveyor:blocked",
    rejected: "conveyor:reject",
  },
  metadata: {
    closable: "conveyor:closable",
    orderTemplate: "conveyor:order:{number}",
  },
};

describe("applyStageTransition", () => {
  test("journals and applies an advance while preserving metadata labels", async () => {
    const store = await setup();
    const calls: string[][] = [];

    await applyStageTransition({
      store,
      source: {
        async replaceConveyorLabels(_address, _number, labels) { calls.push([...labels]); },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-1",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
      result: {
        kind: "advance",
        stageId: "implementation",
        nextStageId: "review",
        result: {} as never,
        feedbackCycles: 0,
      },
    });

    expect(calls).toEqual([["conveyor", "conveyor:order:2", "conveyor:review"]]);
    expect(store.getStageState("issue")).toMatchObject({
      stageId: "review",
      status: "awaiting-source",
    });
    expect(store.listStageTransitions("issue")).toMatchObject([{
      id: "run-1",
      fromStage: "implementation",
      toStage: "review",
      kind: "advance",
      status: "completed",
    }]);
    store.close();
  });

  test("moves a roll-up parent while clearing stale state labels", async () => {
    const store = await setup();
    store.upsertIssue({
      id: "issue",
      repositoryId: "repo",
      sourceNumber: 7,
      sourceUrl: "https://example.test/7",
      title: "Feature",
      body: "",
      sourceState: "open",
      labels: [
        "conveyor",
        "conveyor:implementation",
        "conveyor:blocked",
        "conveyor:closable",
        "conveyor:order:2",
        "backend",
      ],
      sourceUpdatedAt: "2026-01-02T00:00:00Z",
    });
    store.setIssueProjection("issue", {
      stage: "implementation",
      state: "blocked",
      warning: null,
    });
    const calls: string[][] = [];

    await applyRollupTransition({
      store,
      source: {
        async replaceConveyorLabels(_address, _number, labels) { calls.push([...labels]); },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "rollup-1",
      issue: store.getIssue("issue")!,
      targetStageId: "review",
      labels: labelConfig,
      reason: "Following the earliest unfinished child stage: review",
    });

    expect(calls).toEqual([["conveyor", "conveyor:order:2", "conveyor:review"]]);
    expect(store.getStageState("issue")).toMatchObject({
      stageId: "review",
      status: "awaiting-source",
    });
    expect(store.listStageTransitions("issue")).toMatchObject([{
      id: "rollup-1",
      fromStage: "implementation",
      toStage: "review",
      kind: "rollup",
      status: "completed",
      reason: "Following the earliest unfinished child stage: review",
    }]);
    store.close();
  });

  test("does not repeat a completed source mutation after restart", async () => {
    const store = await setup();
    let calls = 0;
    let appliedLabels: readonly string[] = [];
    const input = {
      store,
      source: {
        async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) {
          calls += 1;
          appliedLabels = labels;
        },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-final",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
      result: {
        kind: "advance" as const,
        stageId: "review",
        nextStageId: null,
        result: {} as never,
        feedbackCycles: 0,
      },
    };

    await applyStageTransition(input);
    await applyStageTransition(input);

    expect(calls).toBe(1);
    expect(appliedLabels).toContain("conveyor:review");
    expect(appliedLabels).toContain("conveyor:done");
    store.close();
  });

  test("maps stopped and correction results to configured source labels", async () => {
    const store = await setup();
    const calls: string[][] = [];
    const common = {
      store,
      source: {
        async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) {
          calls.push([...labels]);
        },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
    };
    await applyStageTransition({
      ...common,
      transitionId: "run-blocked",
      result: {
        kind: "stopped",
        stageId: "implementation",
        state: "blocked",
        reason: "Need input",
        requiredFixes: [],
        feedbackCycles: 0,
        result: null,
      },
    });
    await applyStageTransition({
      ...common,
      transitionId: "run-correction",
      result: {
        kind: "correction",
        stageId: "review",
        targetStageId: "implementation",
        reason: "Tests fail",
        requiredFixes: ["Fix tests"],
        evidence: [],
        result: null,
      },
    });

    expect(calls[0]).toContain("conveyor:blocked");
    expect(calls[1]).toContain("conveyor:implementation");
    expect(calls[1]).not.toContain("conveyor:blocked");
    expect(store.listStageTransitions("issue").at(-1)).toMatchObject({
      id: "run-correction",
      fromStage: "review",
      toStage: "implementation",
      kind: "correction",
      reason: "Tests fail",
      requiredFixes: ["Fix tests"],
    });
    store.close();
  });

  test("an applied stage transition fences the item once and drops its cursor", async () => {
    const store = await setup();
    const journal = new ExecutionStore(store.sqlite());
    store.setStageState({ issueId: "issue", stageId: "implementation", status: "running", feedbackCycle: 0, configHash: "hash" });
    const before = journal.stageEpoch("issue");
    journal.saveCursor({
      issueId: "issue", stage: "implementation", stageEpoch: before, attempt: 1, returns: 0, list: "actions",
      taskInstanceId: "t", state: "running", feedback: null, pendingSince: null, wakeAt: null, deadlineAt: null,
    }, before);

    await applyStageTransition({
      store,
      source: { async replaceConveyorLabels() {} },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-epoch",
      issue: store.getIssue("issue")!,
      stages: ["implementation", "review"],
      labels: labelConfig,
      result: { kind: "advance", stageId: "implementation", nextStageId: "review", result: {} as never, feedbackCycles: 0 },
    });

    expect(journal.stageEpoch("issue")).toBe(before + 1);
    expect(journal.getCursor("issue")).toBeNull();
    store.close();
  });

  test("a roll-up transition fences the item once", async () => {
    const store = await setup();
    const journal = new ExecutionStore(store.sqlite());
    store.setStageState({ issueId: "issue", stageId: "implementation", status: "ready", feedbackCycle: 0, configHash: "hash" });
    const before = journal.stageEpoch("issue");

    await applyRollupTransition({
      store,
      source: { async replaceConveyorLabels() {} },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "rollup-epoch",
      issue: store.getIssue("issue")!,
      targetStageId: "review",
      reason: "children advanced",
      labels: labelConfig,
    });

    expect(journal.stageEpoch("issue")).toBe(before + 1);
    store.close();
  });
});
