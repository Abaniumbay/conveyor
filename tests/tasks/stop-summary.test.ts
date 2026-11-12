import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorStore } from "../../src/db/store";
import { EVENT_CATALOGUE } from "../../src/events/catalogue";
import { createTaskRegistry } from "../../src/tasks/catalogue";
import type { TaskDeps } from "../../src/tasks/deps";
import { dispatchTool } from "../../src/tasks/dispatch";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const ITEM = "github:owner/my-app#1";
const OTHER = "github:owner/my-app#2";
const TOOL = "operator.recordStopSummary";

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-stop-summary-"));
  directories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  store.upsertRepository({ id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: root, configHash: "h" });
  for (const [id, number] of [[ITEM, 1], [OTHER, 2]] as const) {
    store.upsertIssue({ id, repositoryId: "repo", sourceNumber: number, sourceUrl: `https://example.com/${number}`, title: "T", body: "B", sourceState: "open", labels: ["conveyor", "conveyor:implementation"], sourceUpdatedAt: "2026-10-17T00:00:00Z" });
    store.activateEnrollment(id);
  }
  let sequence = 0;
  const transition = (issueId: string, kind: string) => {
    const id = `t${String(++sequence).padStart(4, "0")}`;
    store.beginStageTransition({ id, issueId, fromStage: "implementation", toStage: "implementation", kind, sourceMutationId: null, detail: { reason: "red", requiredFixes: [], resultStatus: null } });
    store.completeStageTransition(id);
    return id;
  };
  const call = (scope: { itemId: string; stopId: string }, input: unknown) =>
    dispatchTool(
      { name: TOOL, input, actor: null, grant: { runId: "run-1", stageId: "steering", issueScoped: false, actor: null, tasks: new Set([TOOL]) } },
      {
        registry: createTaskRegistry(),
        deps: () => ({ store, operator: { stopSummary: scope } }) as unknown as TaskDeps,
        liveHeadSha: async () => null,
        store,
      },
    );
  return { store, transition, call };
}

describe("operator.recordStopSummary", () => {
  test("rejects a summary longer than 300 characters and accepts exactly 300", async () => {
    const { store, transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    const scope = { itemId: ITEM, stopId };
    await expect(call(scope, { itemId: ITEM, stopId, summary: "x".repeat(301) })).rejects.toThrow();
    expect(store.currentStopSummary(ITEM)).toBeNull();
    await call(scope, { itemId: ITEM, stopId, summary: "x".repeat(300) });
    expect(store.currentStopSummary(ITEM)).toBe("x".repeat(300));
  });

  test("rejects a line break, code blocks and URLs, and accepts inline code", async () => {
    const { store, transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    const scope = { itemId: ITEM, stopId };
    for (const bad of [
      "First sentence.\nSecond sentence.",
      "Fenced ```ts const a = 1; ``` block.",
      "Spans `lines\nacross` backticks.",
      "See https://example.com/log for details.",
      "See www.example.com for details.",
    ]) {
      await expect(call(scope, { itemId: ITEM, stopId, summary: bad })).rejects.toThrow();
      expect(store.currentStopSummary(ITEM)).toBeNull();
    }
    const ok = "The test `tests/foo.test.ts` fails; run `bun test` to see it.";
    await call(scope, { itemId: ITEM, stopId, summary: ok });
    expect(store.currentStopSummary(ITEM)).toBe(ok);
  });

  test("rejects a summary for an item other than the one the run was started for", async () => {
    const { store, transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    const otherStop = transition(OTHER, "stopped");
    await expect(call({ itemId: ITEM, stopId }, { itemId: OTHER, stopId: otherStop, summary: "advice" })).rejects.toThrow("another item");
    expect(store.currentStopSummary(OTHER)).toBeNull();
    expect(store.currentStopSummary(ITEM)).toBeNull();
  });

  test("rejects a summary for a stop other than the one the run was started for", async () => {
    const { store, transition, call } = await world();
    const earlier = transition(ITEM, "stopped");
    transition(ITEM, "resumed");
    const current = transition(ITEM, "stopped");
    await expect(call({ itemId: ITEM, stopId: current }, { itemId: ITEM, stopId: earlier, summary: "advice" })).rejects.toThrow("another stop");
    expect(store.currentStopSummary(ITEM)).toBeNull();
  });

  test("rejects a run that was not started as a stop-summary run", async () => {
    const { transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    await expect(
      dispatchTool(
        { name: TOOL, input: { itemId: ITEM, stopId, summary: "advice" }, actor: null, grant: { runId: "r", stageId: "steering", issueScoped: false, actor: null, tasks: new Set([TOOL]) } },
        { registry: createTaskRegistry(), deps: () => ({ operator: {} }) as unknown as TaskDeps, liveHeadSha: async () => null, store: (await world()).store },
      ),
    ).rejects.toThrow("stop-summary Operator run");
  });

  test("appends a catalogued event whose payload holds identifiers and not the text", async () => {
    const { store, transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    const after = store.events().latestSeq();
    await call({ itemId: ITEM, stopId }, { itemId: ITEM, stopId, summary: "SECRET-SUMMARY-TEXT" });
    const events = store.events().read({ afterSeq: after });
    const recorded = events.filter((event) => event.type === "item.stopSummaryRecorded");
    expect(recorded).toHaveLength(1);
    expect(Object.keys(EVENT_CATALOGUE)).toContain(recorded[0]!.type);
    expect(recorded[0]!.payload).toEqual({ stopId });
    expect(JSON.stringify(events)).not.toContain("SECRET-SUMMARY-TEXT");
  });

  test("the store read returns the summary of the current stop", async () => {
    const { store, transition, call } = await world();
    const stopId = transition(ITEM, "stopped");
    expect(store.currentStopSummary(ITEM)).toBeNull();
    await call({ itemId: ITEM, stopId }, { itemId: ITEM, stopId, summary: "Retry after fixing CI." });
    expect(store.currentStopSummary(ITEM)).toBe("Retry after fixing CI.");
    expect(store.currentStopSummary(OTHER)).toBeNull();
  });

  test("after the item resumes and stops again, the read is null until a new summary is recorded", async () => {
    const { store, transition, call } = await world();
    const first = transition(ITEM, "stopped");
    await call({ itemId: ITEM, stopId: first }, { itemId: ITEM, stopId: first, summary: "first" });
    transition(ITEM, "resumed");
    expect(store.currentStopSummary(ITEM)).toBeNull();
    const second = transition(ITEM, "stopped");
    expect(store.currentStopSummary(ITEM)).toBeNull();
    await call({ itemId: ITEM, stopId: second }, { itemId: ITEM, stopId: second, summary: "second" });
    expect(store.currentStopSummary(ITEM)).toBe("second");
  });

  test("leaves the item's stage, state, labels and stop reason unchanged", async () => {
    const { store, transition, call } = await world();
    store.setIssueProjection(ITEM, { stage: "implementation", state: "blocked", warning: "red" });
    const stopId = transition(ITEM, "stopped");
    const snapshot = () => {
      const issue = store.getIssue(ITEM)!;
      return JSON.stringify({ stage: issue.projectedStage, state: issue.projectedState, labels: issue.labels, warning: issue.warning, transitions: store.listStageTransitions(ITEM) });
    };
    const before = snapshot();
    await call({ itemId: ITEM, stopId }, { itemId: ITEM, stopId, summary: "advice" });
    expect(snapshot()).toBe(before);
    expect(store.listStageTransitions(ITEM).at(-1)?.reason).toBe("red");
  });
});

describe("stop summary documentation", () => {
  test("SPEC.md and the Operator documentation describe the record, its limit, format rules and that it is advice only", async () => {
    for (const file of ["SPEC.md", "docs/operator-mcp.md"]) {
      const text = await Bun.file(path.join(import.meta.dir, "../..", file)).text();
      expect(text).toContain("operator.recordStopSummary");
      expect(text).toContain("300");
      expect(text).toContain("line break");
      expect(text).toContain("URL");
      expect(text).toContain("advice only");
    }
  });
});
