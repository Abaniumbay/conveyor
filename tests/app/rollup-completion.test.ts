import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConveyorService } from "../../src/app/service";
import type { ConveyorConfig } from "../../src/config/load";
import { configSchema } from "../../src/config/schema";
import { ConveyorStore } from "../../src/db/store";
import type { SourceIssue } from "../../src/source/types";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function sourceIssue(
  number: number,
  state: "open" | "closed",
  labels: string[],
): SourceIssue {
  return {
    id: `github:owner/my-app#${number}`,
    number,
    url: `https://example.com/issues/${number}`,
    title: `Issue ${number}`,
    body: "",
    state,
    stateReason: state === "closed" ? "completed" : null,
    labels,
    updatedAt: "2026-10-17T00:00:00Z",
  };
}

function config(root: string): ConveyorConfig {
  const parsed = configSchema.parse({
    settings: {
      database: path.join(root, "conveyor.sqlite"),
      logs: path.join(root, "logs"),
      artifacts: path.join(root, "artifacts"),
      workspaces: path.join(root, "workspaces"),
      runners: 1,
    },
    labels: {
      enrollment: "conveyor",
      stageTemplate: "conveyor:{stage}",
      states: { done: "conveyor:done" },
      metadata: { closable: "conveyor:closable", noSplit: "conveyor:no-split", orderTemplate: "conveyor:order:{number}" },
    },
    pipelines: {
      default: {
        successStatuses: ["done"],
        failureStatuses: ["error"],
        stages: [{ id: "implementation", run: { agent: "worker" }, concurrency: 1 }],
      },
    },
    repositories: {
      repo: { source: "github", address: "owner/my-app", folder: root, pipeline: "default" },
    },
    agents: {},
  });
  return { ...parsed, hash: "config-hash", root, plans: [] };
}

function completionSource(
  issues: SourceIssue[],
  descendants: ReadonlyMap<number, readonly number[]>,
  failedCloses = 0,
  closeBeforeFailure = false,
) {
  const closeCalls: number[] = [];
  const labelCalls: Array<{ number: number; labels: readonly string[] }> = [];
  let labelUpdates = 0;
  let remainingFailedCloses = failedCloses;
  const copy = (issue: SourceIssue): SourceIssue => ({ ...issue, labels: [...issue.labels] });
  const find = (number: number) => {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`Missing source issue ${number}`);
    return issue;
  };
  return {
    closeCalls,
    labelCalls,
    source: {
      async listIssues() { return issues.map(copy); },
      async getIssue(_address: string, number: number) { return copy(find(number)); },
      async getIssueProvenance() {
        return { enrollment: { login: "maintainer" }, title: { login: "maintainer" }, body: { login: "maintainer" } };
      },
      async collaboratorPermission() { return "admin" as const; },
      async repositoryVisibility() { return "private" as const; },
      async listSubIssues(_address: string, number: number) {
        return (descendants.get(number) ?? []).map((child) => copy(find(child)));
      },
      async listDependencies() { return []; },
      async replaceConveyorLabels(_address: string, number: number, labels: readonly string[]) {
        labelCalls.push({ number, labels: [...labels] });
        const issue = find(number);
        issue.labels = [...labels];
        labelUpdates += 1;
        issue.updatedAt = `2026-10-17T00:0${labelUpdates}:00Z`;
      },
      async closeIssue(_address: string, number: number) {
        closeCalls.push(number);
        if (remainingFailedCloses > 0) {
          remainingFailedCloses -= 1;
          if (closeBeforeFailure) {
            const issue = find(number);
            issue.state = "closed";
            issue.stateReason = "completed";
            issue.updatedAt = "2026-10-17T00:01:00Z";
          }
          throw new Error("temporary source outage");
        }
        const issue = find(number);
        issue.state = "closed";
        issue.stateReason = "completed";
        issue.updatedAt = "2026-10-17T00:01:00Z";
        return copy(issue);
      },
    },
  };
}

async function serviceFor(
  issues: SourceIssue[],
  descendants: ReadonlyMap<number, readonly number[]>,
  failedCloses = 0,
  closeBeforeFailure = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "conveyor-rollup-close-"));
  temporaryDirectories.push(root);
  const store = await ConveyorStore.open(path.join(root, "conveyor.sqlite"));
  const fixture = completionSource(issues, descendants, failedCloses, closeBeforeFailure);
  return {
    fixture,
    store,
    service: new ConveyorService(config(root), store, fixture.source as never),
  };
}

describe("roll-up parent completion", () => {
  test("closes an active nested roll-up only after every descendant is done", async () => {
    const { fixture, service, store } = await serviceFor([
      sourceIssue(1, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(2, "closed", ["conveyor", "conveyor:done"]),
      sourceIssue(3, "open", ["conveyor", "conveyor:implementation", "conveyor:done"]),
    ], new Map([[1, [2]], [2, [3]]]));

    await service.reconcileAll();

    expect(fixture.closeCalls).toEqual([1]);
    expect(fixture.labelCalls).toEqual([{
      number: 1,
      labels: ["conveyor", "conveyor:done", "conveyor:implementation"],
    }]);
    expect(store.getIssue("github:owner/my-app#1")).toMatchObject({
      sourceState: "closed",
      sourceStateReason: "completed",
      projectedState: "done",
      labels: ["conveyor", "conveyor:done", "conveyor:implementation"],
    });
    expect(store.getIssue("github:owner/my-app#3")?.sourceState).toBe("open");
    expect(service.dashboard("csrf").done.issues).toContainEqual(expect.objectContaining({
      id: "github:owner/my-app#1",
      closable: false,
    }));
    store.close();
  });

  test("leaves unfinished, paused, offboarded, and already closed parents untouched", async () => {
    const { fixture, service, store } = await serviceFor([
      sourceIssue(1, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(2, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(3, "open", ["conveyor:implementation"]),
      sourceIssue(4, "open", []),
      sourceIssue(5, "closed", ["conveyor", "conveyor:done"]),
      sourceIssue(6, "open", ["conveyor", "conveyor:done"]),
    ], new Map([[1, [2]], [3, [6]], [4, [6]], [5, [6]]]));
    store.upsertRepository({
      id: "repo", configName: "repo", source: "github", address: "owner/my-app", folder: "/tmp/rollup", configHash: "config-hash",
    });
    store.upsertIssue({
      id: "github:owner/my-app#4", repositoryId: "repo", sourceNumber: 4, sourceUrl: "https://example.com/issues/4",
      title: "Issue 4", body: "", sourceState: "open", sourceStateReason: null, labels: [], sourceUpdatedAt: "2026-10-17T00:00:00Z",
    });

    await service.reconcileAll();

    expect(fixture.closeCalls).toEqual([]);
    expect(fixture.labelCalls).toEqual([]);
    expect(store.getIssue("github:owner/my-app#1")?.sourceState).toBe("open");
    expect(store.getIssue("github:owner/my-app#3")?.sourceState).toBe("open");
    expect(store.getIssue("github:owner/my-app#4")?.sourceState).toBe("open");
    expect(store.getIssue("github:owner/my-app#5")?.sourceState).toBe("closed");
    expect(store.getIssue("github:owner/my-app#6")?.sourceState).toBe("open");
    store.close();
  });

  test("retries an uncertain close without repeating the completed-label mutation", async () => {
    const { fixture, service, store } = await serviceFor([
      sourceIssue(1, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(2, "open", ["conveyor", "conveyor:implementation", "conveyor:done"]),
  ], new Map([[1, [2]]]), 1);

    await service.reconcileAll();
    expect(fixture.closeCalls).toEqual([1]);
    expect(fixture.labelCalls).toHaveLength(1);
    expect(store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:github:owner/my-app#1:")).toMatchObject({
      status: "failed",
      error: "temporary source outage",
    });

    await service.reconcileAll();

    expect(fixture.closeCalls).toEqual([1, 1]);
    expect(fixture.labelCalls).toHaveLength(1);
    expect(store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:github:owner/my-app#1:")).toMatchObject({
      status: "succeeded",
    });
    expect(store.getIssue("github:owner/my-app#1")).toMatchObject({
      sourceState: "closed",
      sourceStateReason: "completed",
    });
    store.close();
  });

  test("observes a remotely completed close after a lost response without closing twice", async () => {
    const { fixture, service, store } = await serviceFor([
      sourceIssue(1, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(2, "open", ["conveyor", "conveyor:implementation", "conveyor:done"]),
    ], new Map([[1, [2]]]), 1, true);

    await service.reconcileAll();
    expect(store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:github:owner/my-app#1:")).toMatchObject({
      status: "failed",
      error: "temporary source outage",
    });

    await service.reconcileAll();

    expect(fixture.closeCalls).toEqual([1]);
    expect(fixture.labelCalls).toHaveLength(1);
    expect(store.getLatestSourceMutationByKeyPrefix("rollup-completion-close:github:owner/my-app#1:")).toMatchObject({
      status: "succeeded",
    });
    expect(store.getIssue("github:owner/my-app#1")).toMatchObject({
      sourceState: "closed",
      sourceStateReason: "completed",
    });
    store.close();
  });

  test("closes a parent again after it is reopened for a later completion episode", async () => {
    const issues = [
      sourceIssue(1, "open", ["conveyor", "conveyor:implementation"]),
      sourceIssue(2, "open", ["conveyor", "conveyor:implementation", "conveyor:done"]),
    ];
    const descendants = new Map<number, readonly number[]>([[1, [2]]]);
    const { fixture, service, store } = await serviceFor(issues, descendants);

    await service.reconcileAll();
    expect(fixture.closeCalls).toEqual([1]);

    const parent = issues[0]!;
    parent.state = "open";
    parent.stateReason = null;
    parent.labels = ["conveyor", "conveyor:implementation"];
    parent.updatedAt = "2026-10-17T00:02:00Z";
    const laterChild = sourceIssue(3, "open", ["conveyor", "conveyor:implementation"]);
    issues.push(laterChild);
    descendants.set(1, [2, 3]);

    await service.reconcileAll();
    expect(fixture.closeCalls).toEqual([1]);

    laterChild.labels = ["conveyor", "conveyor:implementation", "conveyor:done"];
    laterChild.updatedAt = "2026-10-17T00:03:00Z";
    await service.reconcileAll();

    expect(fixture.labelCalls).toHaveLength(2);
    expect(fixture.closeCalls).toEqual([1, 1]);
    expect(store.getIssue("github:owner/my-app#1")).toMatchObject({
      sourceState: "closed",
      sourceStateReason: "completed",
      projectedState: "done",
    });
    store.close();
  });
});
