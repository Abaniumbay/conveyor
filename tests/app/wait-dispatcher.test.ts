import { describe, expect, test } from "bun:test";

import { WaitDispatcher } from "../../src/app/wait-dispatcher";
import type { StoredEvent } from "../../src/events/catalogue";
import type { StageCursor } from "../../src/engine/journal";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function event(type: StoredEvent["type"], payload: unknown, scope: { repositoryId?: string; issueId?: string } = {}): StoredEvent {
  return {
    seq: 1, type, occurredAt: "2026-10-17T00:00:00Z", repositoryId: scope.repositoryId ?? "app", issueId: scope.issueId ?? null,
    actor: { kind: "webhook", id: "d1" }, correlationId: null, payload: payload as StoredEvent["payload"],
  };
}

function dispatcher(subscriptions: Record<string, Array<{ issueId: string; stageEpoch: number }>>, cursors: Record<string, Partial<StageCursor>> = {}) {
  const woken: string[] = [];
  const instance = new WaitDispatcher({
    journal: {
      subscribers: (topic) => (subscriptions[topic] ?? []).map((row) => ({ ...row, executionId: "e", kind: "ci" as const })),
      getCursor: (issueId) => (cursors[issueId] ?? { state: "pending", stageEpoch: 3 }) as StageCursor,
    },
    addressOf: (repositoryId) => (repositoryId === "app" ? "Owner/App" : null),
    numberOf: (issueId) => (issueId === "blocker" ? 7 : null),
    wake: (issueId) => { woken.push(issueId); },
  });
  return { instance, woken };
}

describe("WaitDispatcher topics", () => {
  const { instance } = dispatcher({});
  test("a finished CI run concerns its commit", () => {
    expect(instance.topicsFor(event("github.ciUpdated", { repository: "owner/app", sha: SHA, pullRequests: [5], completed: true }))).toEqual([`ci:owner/app:${SHA}`]);
  });
  test("CI progress concerns nothing", () => {
    expect(instance.topicsFor(event("github.ciUpdated", { repository: "owner/app", sha: SHA, pullRequests: [5], completed: false }))).toEqual([]);
  });
  test("a new head on a pull request concerns the pull request", () => {
    expect(instance.topicsFor(event("github.changeUpdated", { repository: "owner/app", number: 5, action: "synchronize", headSha: SHA }))).toEqual(["change:owner/app:5"]);
  });
  test("a closed pull request concerns the pull request", () => {
    expect(instance.topicsFor(event("github.changeUpdated", { repository: "owner/app", number: 5, action: "closed", headSha: SHA }))).toEqual(["change:owner/app:5"]);
  });
  test("a label on a pull request concerns nothing", () => {
    expect(instance.topicsFor(event("github.changeUpdated", { repository: "owner/app", number: 5, action: "labeled", headSha: SHA }))).toEqual([]);
  });
  test("an item whose state changed concerns the issue", () => {
    expect(instance.topicsFor(event("item.updated", { number: 7, changed: ["state"] }, { issueId: "blocker" }))).toEqual(["issue:owner/app:7"]);
  });
  test("an item whose title changed concerns nothing", () => {
    expect(instance.topicsFor(event("item.updated", { number: 7, changed: ["title"] }, { issueId: "blocker" }))).toEqual([]);
  });
  test("an item reaching done concerns the issue", () => {
    expect(instance.topicsFor(event("item.stageChanged", { fromStage: "review", fromState: "active", toStage: "review", toState: "done" }, { issueId: "blocker" }))).toEqual(["issue:owner/app:7"]);
  });
  test("a raw issue delivery does not wake dependency waits before the projection has it", () => {
    expect(instance.topicsFor(event("github.issueUpdated", { repository: "owner/app", number: 7, action: "closed", pullRequest: false }))).toEqual([]);
  });
});

describe("WaitDispatcher wakes", () => {
  const completed = event("github.ciUpdated", { repository: "owner/app", sha: SHA, pullRequests: [5], completed: true });

  test("a parked item of the current epoch", () => {
    const { instance, woken } = dispatcher({ [`ci:owner/app:${SHA}`]: [{ issueId: "item", stageEpoch: 3 }] });
    instance.handle(completed);
    instance.flush();
    expect(woken).toEqual(["item"]);
  });

  test("not a row of an earlier visit of the stage", () => {
    const { instance, woken } = dispatcher({ [`ci:owner/app:${SHA}`]: [{ issueId: "item", stageEpoch: 2 }] });
    instance.handle(completed);
    instance.flush();
    expect(woken).toEqual([]);
  });

  test("not an item that is running rather than parked", () => {
    const { instance, woken } = dispatcher({ [`ci:owner/app:${SHA}`]: [{ issueId: "item", stageEpoch: 3 }] }, { item: { state: "running", stageEpoch: 3 } });
    instance.handle(completed);
    instance.flush();
    expect(woken).toEqual([]);
  });

  test("each item once in a burst of events", async () => {
    const { instance, woken } = dispatcher({ [`ci:owner/app:${SHA}`]: [{ issueId: "item", stageEpoch: 3 }], "change:owner/app:5": [{ issueId: "item", stageEpoch: 3 }] });
    instance.handle(completed);
    instance.handle(event("github.changeUpdated", { repository: "owner/app", number: 5, action: "synchronize", headSha: SHA }));
    instance.handle(completed);
    await Promise.resolve();
    expect(woken).toEqual(["item"]);
  });
});
