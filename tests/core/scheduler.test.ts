import { describe, expect, test } from "bun:test";

import { capacityBlockers, selectRunnableIssues } from "../../src/core/scheduler";

describe("selectRunnableIssues", () => {
  test("scans global hierarchy order and skips dependencies without blocking later work", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "a1",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 1,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "a2",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 2,
          eligible: true,
          dependenciesSatisfied: false,
        },
        {
          id: "a3",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: 3,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "b",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 3,
        stages: { implementation: 3 },
        repositories: { "repo-a": 2, "repo-b": 1 },
      },
      { global: 0, stages: {}, repositories: {} },
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["a1", "a3", "b"]);
  });

  test("accounts for already running work across every concurrency scope", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "first",
          repositoryId: "repo-a",
          stageId: "refinement",
          queueRank: 1,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
        {
          id: "second",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 2,
        stages: { refinement: 1, implementation: 2 },
        repositories: { "repo-a": 1, "repo-b": 1 },
      },
      {
        global: 1,
        stages: { refinement: 1 },
        repositories: { "repo-a": 1 },
      },
    );

    expect(selected.map((candidate) => candidate.id)).toEqual(["second"]);
  });

  test("does not schedule roll-up parents or ineligible issues", () => {
    const selected = selectRunnableIssues(
      [
        {
          id: "parent",
          repositoryId: "repo-a",
          stageId: "implementation",
          queueRank: 1,
          siblingOrder: null,
          eligible: true,
          dependenciesSatisfied: true,
          rollupOnly: true,
        },
        {
          id: "paused",
          repositoryId: "repo-b",
          stageId: "implementation",
          queueRank: 2,
          siblingOrder: null,
          eligible: false,
          dependenciesSatisfied: true,
        },
      ],
      {
        global: 2,
        stages: { implementation: 2 },
        repositories: { "repo-a": 1, "repo-b": 1 },
      },
      { global: 0, stages: {}, repositories: {} },
    );

    expect(selected).toEqual([]);
  });
});

describe("lightweight stages", () => {
  test("a source-action-only stage runs even when repository and global permits are exhausted", () => {
    const selected = selectRunnableIssues(
      [
        { id: "agent", repositoryId: "repo", stageId: "implementation", queueRank: 1, siblingOrder: null, eligible: true, dependenciesSatisfied: true },
        { id: "ci-1", repositoryId: "repo", stageId: "ci", queueRank: 2, siblingOrder: null, eligible: true, dependenciesSatisfied: true, lightweight: true },
        { id: "ci-2", repositoryId: "repo", stageId: "ci", queueRank: 3, siblingOrder: null, eligible: true, dependenciesSatisfied: true, lightweight: true },
      ],
      { global: 2, stages: { implementation: 2, ci: 1 }, repositories: { repo: 2 } },
      { global: 2, stages: { implementation: 2 }, repositories: { repo: 2 } },
    );
    expect(selected.map((candidate) => candidate.id)).toEqual(["ci-1"]);
  });
});

describe("capacityBlockers", () => {
  test("reports every full limit and the exact holders, excluding lightweight work from runner and repository usage", () => {
    const blocks = capacityBlockers(
      { repositoryId: "repo-a", stageId: "implementation", lightweight: false },
      { global: 2, stages: { implementation: 2 }, repositories: { "repo-a": 1 } },
      [
        { id: "#106", repositoryId: "repo-a", stageId: "implementation", lightweight: false },
        { id: "#109", repositoryId: "repo-b", stageId: "implementation", lightweight: false },
        { id: "#ci", repositoryId: "repo-a", stageId: "implementation", lightweight: true },
      ],
    );

    expect(blocks).toEqual([
      { scope: "global", used: 2, limit: 2, occupants: ["#106", "#109"] },
      { scope: "stage", used: 3, limit: 2, occupants: ["#106", "#109", "#ci"] },
      { scope: "repository", used: 1, limit: 1, occupants: ["#106"] },
    ]);
  });
});

describe("gate-only executions", () => {
  const limits = { global: 2, stages: { implementation: 5 }, repositories: { repo: 1 } };
  const holder = { id: "agent", repositoryId: "repo", stageId: "implementation", queueRank: 1, siblingOrder: null, eligible: true, dependenciesSatisfied: true };
  const gate = { id: "gate", repositoryId: "repo", stageId: "implementation", queueRank: 2, siblingOrder: null, eligible: true, dependenciesSatisfied: true, gateOnly: true };

  test("is admitted without a repository permit, while another item's agent holds it", () => {
    const selected = selectRunnableIssues([gate], limits, { global: 1, stages: { implementation: 1 }, repositories: { repo: 1 } });
    expect(selected.map((candidate) => candidate.id)).toEqual(["gate"]);
  });

  test("still counts toward the global runner limit", () => {
    expect(selectRunnableIssues([gate], limits, { global: 2, stages: { implementation: 2 }, repositories: { repo: 1 } })).toEqual([]);
    const selected = selectRunnableIssues([gate, { ...gate, id: "gate-2", queueRank: 3 }], { ...limits, global: 1 }, { global: 0, stages: {}, repositories: {} });
    expect(selected.map((candidate) => candidate.id)).toEqual(["gate"]);
  });

  test("does not take the repository permit from a later agent run", () => {
    const selected = selectRunnableIssues(
      [gate, { ...holder, id: "later", queueRank: 3 }],
      limits,
      { global: 0, stages: {}, repositories: {} },
    );
    expect(selected.map((candidate) => candidate.id)).toEqual(["gate", "later"]);
  });

  test("an item that would start an agent waits for the repository permit", () => {
    const selected = selectRunnableIssues([{ ...gate, gateOnly: false }], limits, { global: 1, stages: { implementation: 1 }, repositories: { repo: 1 } });
    expect(selected).toEqual([]);
  });

  test("a running gate-only execution does not occupy the repository permit", () => {
    const blocks = capacityBlockers(
      { repositoryId: "repo", stageId: "implementation", lightweight: false },
      limits,
      [{ id: "gate", repositoryId: "repo", stageId: "implementation", lightweight: false, gateOnly: true }],
    );
    expect(blocks).toEqual([]);
  });

  test("a gate-only candidate reports no repository block but still reports the runner block", () => {
    const blocks = capacityBlockers(
      { repositoryId: "repo", stageId: "implementation", lightweight: false, gateOnly: true },
      { ...limits, global: 1 },
      [{ id: "agent", repositoryId: "repo", stageId: "implementation", lightweight: false }],
    );
    expect(blocks.map((block) => block.scope)).toEqual(["global"]);
  });
});

describe("skipped stages", () => {
  const full = { global: 1, stages: { review: 1 }, repositories: { a: 1, b: 1 } };
  const busy = { global: 1, stages: { review: 1 }, repositories: { a: 1, b: 1 } };
  const base = { siblingOrder: null, eligible: true, dependenciesSatisfied: true };

  test("an item entering a skipped stage is selected although every permit is full", () => {
    const selected = selectRunnableIssues(
      [{ ...base, id: "skip", repositoryId: "a", stageId: "review", queueRank: 2, skipped: true }],
      full,
      busy,
    );
    expect(selected.map((candidate) => candidate.id)).toEqual(["skip"]);
  });

  test("a skipped item takes no capacity from the item behind it", () => {
    const empty = { global: 0, stages: {}, repositories: {} };
    const selected = selectRunnableIssues(
      [
        { ...base, id: "skip", repositoryId: "a", stageId: "review", queueRank: 1, skipped: true },
        { ...base, id: "runs", repositoryId: "a", stageId: "review", queueRank: 2 },
      ],
      full,
      empty,
    );
    expect(selected.map((candidate) => candidate.id)).toEqual(["skip", "runs"]);
  });

  test("an item of a repository that does not skip the stage still waits for a full stage", () => {
    const selected = selectRunnableIssues(
      [{ ...base, id: "runs", repositoryId: "b", stageId: "review", queueRank: 2 }],
      full,
      busy,
    );
    expect(selected).toEqual([]);
  });

  test("a skipped item reports no capacity blocker", () => {
    const occupants = [{ id: "x", repositoryId: "a", stageId: "review", lightweight: false }];
    expect(capacityBlockers({ repositoryId: "a", stageId: "review", skipped: true }, full, occupants)).toEqual([]);
    expect(capacityBlockers({ repositoryId: "a", stageId: "review" }, full, occupants).length).toBeGreaterThan(0);
  });
});
