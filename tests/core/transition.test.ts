import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyClosedItemOffboarding, applyRollupTransition, applyStageTransition } from "../../src/core/transition";
import { RepositoryPausedError } from "../../src/core/repository-pause";
import { ConveyorStore } from "../../src/db/store";
import { ExecutionStore } from "../../src/engine/journal";
import { ItemTodos, TODO_CLOSEOUT_NOTE } from "../../src/engine/todos";

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
    labels: ["conveyor", "conveyor:implementation", "conveyor:no-split", "conveyor:order:2", "backend"],
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
    noSplit: "conveyor:no-split",
    orderTemplate: "conveyor:order:{number}",
  },
};

describe("applyStageTransition", () => {
  test("does not begin a source transition when in-flight admission is full", async () => {
    const store = await setup();
    const calls: string[][] = [];

    const result = await applyStageTransition({
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
        stageId: "refinement",
        nextStageId: "implementation",
        result: {} as never,
        feedbackCycles: 0,
      },
      admit: () => "Waiting for an in-progress slot in repo: #7, #8",
    });

    expect(result).toEqual({ waitingForInFlight: "Waiting for an in-progress slot in repo: #7, #8" });
    expect(calls).toEqual([]);
    expect(store.listStageTransitions("issue")).toEqual([]);
    store.close();
  });

  test("reserves one admission while a concurrent source transition is still pending", async () => {
    const store = await setup();
    store.upsertIssue({
      id: "second",
      repositoryId: "repo",
      sourceNumber: 8,
      sourceUrl: "https://example.test/8",
      title: "Second feature",
      body: "",
      sourceState: "open",
      labels: ["conveyor", "conveyor:refinement"],
      sourceUpdatedAt: "2026-01-01T00:00:00Z",
    });
    let releaseLabels: (() => void) | undefined;
    const labelsReplaced = new Promise<void>((resolve) => { releaseLabels = resolve; });
    const source = {
      async replaceConveyorLabels() { await labelsReplaced; },
    };
    const admit = () => store.listPendingStageTransitions()
      .some((transition) => transition.toStage === "implementation")
      ? "Waiting for an in-progress slot in repo: #7"
      : null;
    const first = applyStageTransition({
      store,
      source,
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "first",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
      result: { kind: "advance", stageId: "refinement", nextStageId: "implementation", result: null, feedbackCycles: 0 },
      admit,
    });
    const second = await applyStageTransition({
      store,
      source,
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "second",
      issue: store.getIssue("second")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
      result: { kind: "advance", stageId: "refinement", nextStageId: "implementation", result: null, feedbackCycles: 0 },
      admit,
    });

    expect(second).toEqual({ waitingForInFlight: "Waiting for an in-progress slot in repo: #7" });
    expect(store.listPendingStageTransitions()).toMatchObject([{ issueId: "issue", toStage: "implementation" }]);
    releaseLabels!();
    await first;
    store.close();
  });

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

    expect(calls).toEqual([["conveyor", "conveyor:no-split", "conveyor:order:2", "conveyor:review"]]);
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

  test("asks the source adapter to preserve the live no-split label", async () => {
    const store = await setup();
    let preserved: readonly string[] = [];

    await applyStageTransition({
      store,
      source: {
        async replaceConveyorLabels(_address, _number, _labels, preserveLabels) {
          preserved = preserveLabels ?? [];
        },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-live-no-split",
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

    expect(preserved).toEqual(["conveyor:no-split"]);
    store.close();
  });

  test("asks the source adapter to preserve the live no-split label during roll-up", async () => {
    const store = await setup();
    let preserved: readonly string[] = [];

    await applyRollupTransition({
      store,
      source: {
        async replaceConveyorLabels(_address, _number, _labels, preserveLabels) {
          preserved = preserveLabels ?? [];
        },
      },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "rollup-live-no-split",
      issue: store.getIssue("issue")!,
      targetStageId: "review",
      reason: "children advanced",
      labels: labelConfig,
    });

    expect(preserved).toEqual(["conveyor:no-split"]);
    store.close();
  });

  test("closes unfinished todos only after a source advance succeeds and preserves the closeout on replay", async () => {
    const store = await setup();
    const todos = new ItemTodos(store.sqlite());
    todos.set("issue", [
      { id: "done", text: "Completed", status: "done", note: "kept" },
      { id: "pending", text: "Pending", status: "pending" },
      { id: "active", text: "Active", status: "in_progress", note: "working" },
      { id: "old", text: "Older", status: "skipped", note: "old closeout" },
    ], "run", "2026-10-01T00:00:00Z");
    let calls = 0;
    const input = {
      store,
      source: { async replaceConveyorLabels() { calls += 1; } },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-closeout",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "build", "review"],
      labels: labelConfig,
      result: { kind: "advance" as const, stageId: "build", nextStageId: "review", result: null, feedbackCycles: 0 },
    };

    await applyStageTransition(input);
    const closed = todos.get("issue")!.items;
    expect(closed).toEqual([
      { id: "done", text: "Completed", status: "done", note: "kept" },
      { id: "pending", text: "Pending", status: "skipped", note: TODO_CLOSEOUT_NOTE },
      { id: "active", text: "Active", status: "skipped", note: TODO_CLOSEOUT_NOTE },
      { id: "old", text: "Older", status: "skipped", note: "old closeout" },
    ]);

    await applyStageTransition(input);
    expect(calls).toBe(1);
    expect(todos.get("issue")!.items).toEqual(closed);
    store.close();
  });

  test("does not close todos when a source advance fails", async () => {
    const store = await setup();
    const todos = new ItemTodos(store.sqlite());
    todos.set("issue", [{ id: "open", text: "Open", status: "pending" }], "run", "2026-10-01T00:00:00Z");

    await expect(applyStageTransition({
      store,
      source: { async replaceConveyorLabels() { throw new Error("source unavailable"); } },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-source-failure",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "build", "review"],
      labels: labelConfig,
      result: { kind: "advance", stageId: "build", nextStageId: "review", result: null, feedbackCycles: 0 },
    })).rejects.toThrow("source unavailable");

    expect(todos.get("issue")!.items).toEqual([{ id: "open", text: "Open", status: "pending" }]);
    expect(store.listStageTransitions("issue")).toMatchObject([{ id: "run-source-failure", status: "failed" }]);
    store.close();
  });

  test("keeps a transition and source intent pending when a repository pause defers its label write", async () => {
    const store = await setup();
    const input = {
      store,
      source: { async replaceConveyorLabels() { throw new RepositoryPausedError(); } },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      transitionId: "run-paused",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
      result: { kind: "advance" as const, stageId: "implementation", nextStageId: "review", result: null, feedbackCycles: 0 },
    };

    await expect(applyStageTransition(input)).rejects.toBeInstanceOf(RepositoryPausedError);
    expect(store.listStageTransitions("issue")).toMatchObject([{ id: "run-paused", status: "pending" }]);
    expect(store.getSourceMutationByKey("transition:run-paused")).toMatchObject({ status: "pending" });
    expect(store.getStageState("issue")).toBeNull();
    store.close();
  });

  test("a return to an earlier stage keeps todos open", async () => {
    const store = await setup();
    const todos = new ItemTodos(store.sqlite());
    const open = [{ id: "open", text: "Open", status: "pending" as const }];
    todos.set("issue", open, "run", "2026-10-01T00:00:00Z");
    const common = {
      store,
      source: { async replaceConveyorLabels() {} },
      sourceName: "github",
      address: "owner/repo",
      configHash: "hash",
      issue: store.getIssue("issue")!,
      stages: ["refinement", "implementation", "review"],
      labels: labelConfig,
    };

    await applyStageTransition({
      ...common,
      transitionId: "run-correction-with-todos",
      result: { kind: "correction", stageId: "review", targetStageId: "implementation", reason: "Need revision", requiredFixes: [], evidence: [], result: null },
    });

    expect(todos.get("issue")!.items).toEqual(open);
    store.close();
  });

  test("does not roll up a parent with an active stop label", async () => {
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

    expect(calls).toEqual([]);
    expect(store.getStageState("issue")).toBeNull();
    expect(store.listStageTransitions("issue")).toEqual([]);
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

    // A legacy producer can stop with a status that has no state label (e.g. changes-requested at
    // implementation): it stops as blocked, keeping the original status in the reason, instead of throwing.
    await applyStageTransition({
      ...common,
      transitionId: "run-unlabelled",
      result: { kind: "stopped", stageId: "implementation", state: "changes-requested", reason: "A seeded win path is not reachable", requiredFixes: [], feedbackCycles: 0, result: null },
    });
    expect(calls[2]).toContain("conveyor:blocked");
    expect(store.getStageState("issue")).toMatchObject({ stageId: "implementation", status: "blocked" });
    expect(store.listStageTransitions("issue").at(-1)).toMatchObject({
      id: "run-unlabelled",
      reason: "Stopped as changes-requested (no label is configured for that state): A seeded win path is not reachable",
      sourceSnapshot: { title: "Feature", body: "" },
    });
    expect(store.listStageTransitions("issue").find((transition) => transition.id === "run-correction")).toMatchObject({
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

    const calls: string[][] = [];
    await applyRollupTransition({
      store,
      source: { async replaceConveyorLabels(_address, _number, labels) { calls.push([...labels]); } },
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
    expect(calls).toEqual([["conveyor", "conveyor:no-split", "conveyor:order:2", "conveyor:review"]]);
    store.close();
  });
});

describe("applyClosedItemOffboarding", () => {
  test("removes every Conveyor control once, offboards the item, and records the closure reason", async () => {
    const store = await setup();
    store.activateEnrollment("issue");
    store.setIssueProjection("issue", { stage: "implementation", state: "blocked", warning: "Stopped" });
    const calls: string[][] = [];
    const input = {
      store,
      source: { async replaceConveyorLabels(_address: string, _number: number, labels: readonly string[]) { calls.push([...labels]); } },
      sourceName: "github",
      address: "owner/repo",
      transitionId: "closed-without-change",
      issue: store.getIssue("issue")!,
    };

    await applyClosedItemOffboarding(input);
    await applyClosedItemOffboarding(input);

    expect(calls).toEqual([[]]);
    expect(store.getIssue("issue")).toMatchObject({ projectedStage: null, projectedState: "offboarded", warning: null });
    expect(store.listStageTransitions("issue")).toMatchObject([{
      id: "closed-without-change",
      kind: "offboarded",
      status: "completed",
      reason: "closed without a merged change",
    }]);
    store.close();
  });

  test("keeps cleanup intent pending while a repository is paused", async () => {
    const store = await setup();
    const input = {
      store,
      source: { async replaceConveyorLabels() { throw new RepositoryPausedError(); } },
      sourceName: "github",
      address: "owner/repo",
      transitionId: "paused-closed-cleanup",
      issue: store.getIssue("issue")!,
    };

    await expect(applyClosedItemOffboarding(input)).rejects.toBeInstanceOf(RepositoryPausedError);
    expect(store.getSourceMutationByKey("paused-closed-cleanup")).toMatchObject({ status: "pending" });
    expect(store.listStageTransitions("issue")).toMatchObject([{ id: "paused-closed-cleanup", status: "pending" }]);
    expect(store.getIssue("issue")).toMatchObject({ projectedState: null });
    store.close();
  });

  test("retries a failed cleanup without a second offboarding journey entry", async () => {
    const store = await setup();
    let attempts = 0;
    const input = {
      store,
      source: {
        async replaceConveyorLabels() {
          attempts += 1;
          if (attempts === 1) throw new Error("source unavailable");
        },
      },
      sourceName: "github",
      address: "owner/repo",
      transitionId: "retry-closed-cleanup",
      issue: store.getIssue("issue")!,
    };

    await expect(applyClosedItemOffboarding(input)).rejects.toThrow("source unavailable");
    expect(store.getSourceMutationByKey("retry-closed-cleanup")).toMatchObject({ status: "failed" });

    await applyClosedItemOffboarding({ ...input, issue: store.getIssue("issue")! });

    expect(attempts).toBe(2);
    expect(store.getSourceMutationByKey("retry-closed-cleanup")).toMatchObject({ status: "succeeded" });
    expect(store.listStageTransitions("issue").filter((transition) => transition.id === "retry-closed-cleanup")).toMatchObject([{
      status: "completed",
      kind: "offboarded",
    }]);
    store.close();
  });
});
